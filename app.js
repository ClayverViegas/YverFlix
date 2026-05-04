/* ==========================================================================
   Streaming MVP — Fases 1 + 2 + 3
   Front-end vanilla: catálogo TMDB + Player iframe + busca com debounce.
   --------------------------------------------------------------------------
   Decisões arquiteturais (com porquê):

   1) IIFE + 'use strict'
      - Escopo isolado para não poluir window. Em runtime simples (sem
        bundler), é a forma mais leve de modularizar.

   2) AbortController + timeout em todo fetch
      - fetch nativo NÃO tem timeout. Sem ele, requisições travadas vazam
        memória, seguram listeners e estouram o pool de ~6 conexões/origin
        do browser. Também serve para cancelar fetch anterior quando o
        usuário clica retry rápido (race condition).

   3) <template> clonado em vez de innerHTML
      - HTML é parseado UMA vez e clonado N vezes (rápido).
      - Preenchemos com textContent → seguro contra XSS no título.

   4) DocumentFragment para render em lote
      - Inserir N cards = N reflows. Um único appendChild(fragment) = 1.
        Crítico em listas grandes.

   5) IntersectionObserver compartilhado para lazy-load das capas
      - UM observer para todas as imagens (não um por card).
      - rootMargin pré-carrega 200px antes da viewport para evitar piscar.

   6) data-id e data-media-type no card
      - data-id guarda o TMDB id (requisito da Fase 1).
      - data-media-type ('movie'|'tv') decide o path do iframe na Fase 2:
        movie → /filme/{id} | tv → /serie/{id}.

   7) Event delegation
      - UM listener no grid em vez de N por card. Menos memória, sem
        listeners órfãos quando reconstruirmos o grid.

   8) Service-like pattern (getTrending() isolada)
      - A UI não fala com fetch direto. Quando migrarmos para Django,
        basta trocar a implementação interna desta função.

   9) [Fase 2] Iframe injetado em open() e REMOVIDO em close()
      - O iframe NÃO existe no HTML. É criado e anexado quando o modal
        abre, e completamente removido quando fecha.
      - ANTES de removeChild fazemos iframe.src = 'about:blank' — é o
        passo que de fato corta áudio/banda no Chromium (sem isso o
        iframe pode continuar consumindo recursos por alguns segundos
        após sair do DOM).

  10) [Fase 2] AbortController agrupando listeners do modal
      - Todos os event listeners criados em open() recebem o mesmo
        signal. Em close(), 1 chamada a abort() desliga TODOS de uma vez.
        Padrão mais limpo que removeEventListener para cada um.

  11) [Fase 3] Debounce de 500ms no input de busca
      - Evita disparar fetch a cada tecla. Só chama a TMDB quando o
        usuário pausa de digitar. Reduz ruído de rede e custos da API.

  12) [Fase 3] Cancelamento de race condition na busca
      - Cada nova busca aborta a request anterior via o mesmo
        currentController da Fase 1. Resposta velha NUNCA sobrescreve
        a nova (problema clássico de search-as-you-type).

  13) [Fase 3] renderCards modular (sem duplicar código)
      - Aceita opts.emptyMessage para customizar a mensagem do estado
        vazio. Mesma função usada para Trending E para resultados de
        busca → 1 caminho de renderização, 1 caminho de bug, 1 caminho
        de melhoria futura.
   ========================================================================== */

(function () {
  'use strict';

  /* ----------------------- 1. Configuração ------------------------------ */

  /**
   * IMPORTANTE: em produção (com Django) esta key sai do front e fica no
   * backend. No MVP front-only, fica aqui mesmo (TMDB v3 keys são
   * desenhadas para uso client-side).
   */
  var CONFIG = Object.freeze({
    TMDB_API_KEY: 'eb9c4dc18d0ed0f3485b2d9ab0c0aeb0',
    TMDB_BASE_URL: 'https://api.themoviedb.org/3',
    TMDB_IMG_BASE: 'https://image.tmdb.org/t/p',
    POSTER_SIZE: 'w342',          // ~342x513px — ideal para cards do grid
    LANGUAGE: 'pt-BR',
    REGION: 'BR',
    TIMEOUT_MS: 8000,             // 8s: balanço entre rede ruim e UX
    RETRY_ATTEMPTS: 1,            // 1 retry para erros transitórios (5xx/timeout)
    RETRY_DELAY_MS: 600,
    SKELETON_COUNT: 12,
    LAZY_ROOT_MARGIN: '200px',    // pré-carrega imgs 200px antes da viewport
  });

  /* ----------------------- 2. Camada HTTP ------------------------------- */

  /**
   * Erro HTTP tipado, com status para discriminação no UI.
   */
  function HttpError(message, status) {
    var err = new Error(message);
    err.name = 'HttpError';
    err.status = status;
    return err;
  }

  /**
   * fetch com timeout, retry e cancelamento.
   *
   * @param {string} url
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retries]
   * @param {AbortSignal} [options.signal] - signal externo (do caller) opcional
   * @returns {Promise<Response>}
   */
  async function fetchWithTimeout(url, options) {
    options = options || {};
    var timeoutMs = options.timeoutMs != null ? options.timeoutMs : CONFIG.TIMEOUT_MS;
    var retries = options.retries != null ? options.retries : CONFIG.RETRY_ATTEMPTS;
    var externalSignal = options.signal;

    var controller = new AbortController();
    var onExternalAbort = function () {
      controller.abort(externalSignal && externalSignal.reason);
    };

    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    var timeoutId = setTimeout(function () {
      controller.abort(new DOMException('Request timeout', 'TimeoutError'));
    }, timeoutMs);

    try {
      var response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        // 5xx é potencialmente transitório → retry.
        // 4xx é erro do cliente → NÃO faz sentido repetir.
        var isTransient = response.status >= 500 && response.status < 600;
        if (isTransient && retries > 0) {
          await delay(CONFIG.RETRY_DELAY_MS);
          return fetchWithTimeout(url, {
            timeoutMs: timeoutMs, retries: retries - 1, signal: externalSignal,
          });
        }
        throw HttpError('HTTP ' + response.status, response.status);
      }

      return response;
    } catch (err) {
      var isAbortByUser = externalSignal && externalSignal.aborted;
      var isRetriable =
        !isAbortByUser && retries > 0 &&
        (err.name === 'TimeoutError' || err.name === 'TypeError');
      if (isRetriable) {
        await delay(CONFIG.RETRY_DELAY_MS);
        return fetchWithTimeout(url, {
          timeoutMs: timeoutMs, retries: retries - 1, signal: externalSignal,
        });
      }
      throw err;
    } finally {
      // Sempre limpamos timer + listener — sem isso, vazamento garantido.
      clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * Debounce: retorna uma função que só executa `fn` após `delay` ms
   * sem novas chamadas. Cada nova chamada reseta o timer.
   *
   * POR QUE precisamos:
   *   - Sem debounce, cada tecla dispararia uma request à TMDB.
   *     Em uma busca de 8 caracteres = 8 requests. Com debounce 500ms,
   *     fica 1 request quando o usuário para de digitar.
   *   - Reduz ruído de rede, custos de API e race conditions.
   *
   * .cancel() permite cancelar uma execução pendente (usado quando
   * o usuário limpa o input — queremos restaurar o Trending na hora,
   * sem esperar o debounce vencer).
   */
  function debounce(fn, delayMs) {
    var timerId = 0;
    function debounced() {
      var args = arguments, ctx = this;
      clearTimeout(timerId);
      timerId = setTimeout(function () { fn.apply(ctx, args); }, delayMs);
    }
    debounced.cancel = function () { clearTimeout(timerId); timerId = 0; };
    return debounced;
  }

  /* ----------------------- 3. TMDB Service ------------------------------ */

  /**
   * @typedef {Object} PageResult
   * @property {MediaItem[]} items
   * @property {number} page
   * @property {number} totalPages
   */

  /**
   * [Fase 1+4] Busca os "Trending" da TMDB com paginação.
   *
   * @param {number} [page=1]
   * @param {AbortSignal} [signal]
   * @returns {Promise<PageResult>}
   */
  async function getTrending(page, signal) {
    assertApiKey();
    var url = new URL(CONFIG.TMDB_BASE_URL + '/trending/all/week');
    url.searchParams.set('api_key', CONFIG.TMDB_API_KEY);
    url.searchParams.set('language', CONFIG.LANGUAGE);
    url.searchParams.set('page', String(page || 1));

    var response = await fetchWithTimeout(url.toString(), { signal: signal });
    var data = await response.json();

    return {
      items: (data.results || [])
        .filter(function (r) { return r.media_type === 'movie' || r.media_type === 'tv'; })
        .map(normalizeMedia),
      page: data.page || page || 1,
      totalPages: data.total_pages || 1,
    };
  }

  /**
   * [Fase 3+4] Busca filmes E séries (/search/multi) com paginação.
   * O endpoint multi também retorna 'person' — filtramos fora.
   *
   * @param {string} query
   * @param {number} [page=1]
   * @param {AbortSignal} [signal]
   * @returns {Promise<PageResult>}
   */
  async function searchMulti(query, page, signal) {
    assertApiKey();
    var url = new URL(CONFIG.TMDB_BASE_URL + '/search/multi');
    url.searchParams.set('api_key', CONFIG.TMDB_API_KEY);
    url.searchParams.set('language', CONFIG.LANGUAGE);
    url.searchParams.set('query', query);
    url.searchParams.set('include_adult', 'false');
    url.searchParams.set('page', String(page || 1));

    var response = await fetchWithTimeout(url.toString(), { signal: signal });
    var data = await response.json();

    return {
      items: (data.results || [])
        .filter(function (r) { return r.media_type === 'movie' || r.media_type === 'tv'; })
        .map(normalizeMedia),
      page: data.page || page || 1,
      totalPages: data.total_pages || 1,
    };
  }

  /**
   * [Fase 4] Carrega a lista oficial de gêneros de filmes.
   * Chamado UMA única vez ao boot.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<Array<{id:number,name:string}>>}
   */
  async function getMovieGenres(signal) {
    assertApiKey();
    var url = new URL(CONFIG.TMDB_BASE_URL + '/genre/movie/list');
    url.searchParams.set('api_key', CONFIG.TMDB_API_KEY);
    url.searchParams.set('language', CONFIG.LANGUAGE);

    var response = await fetchWithTimeout(url.toString(), { signal: signal });
    var data = await response.json();
    return data.genres || [];
  }

  /**
   * [Fase 4] Filtra filmes por gênero via /discover/movie.
   *
   * Por que /discover/movie em vez de /genre/movie/list?
   * O endpoint /genre/movie/list SÓ retorna a LISTA de gêneros (id+nome).
   * Para FILTRAR catálogo por um id de gênero, o endpoint correto é
   * /discover/movie com parâmetro with_genres.
   *
   * @param {number} genreId
   * @param {number} [page=1]
   * @param {AbortSignal} [signal]
   * @returns {Promise<PageResult>}
   */
  async function getByGenre(genreId, page, signal) {
    assertApiKey();
    var url = new URL(CONFIG.TMDB_BASE_URL + '/discover/movie');
    url.searchParams.set('api_key', CONFIG.TMDB_API_KEY);
    url.searchParams.set('language', CONFIG.LANGUAGE);
    url.searchParams.set('with_genres', String(genreId));
    url.searchParams.set('include_adult', 'false');
    url.searchParams.set('sort_by', 'popularity.desc');
    url.searchParams.set('page', String(page || 1));

    var response = await fetchWithTimeout(url.toString(), { signal: signal });
    var data = await response.json();

    // /discover/movie não retorna media_type — forçamos 'movie' no normalize.
    var items = (data.results || []).map(function (r) {
      var withType = {};
      for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) withType[k] = r[k];
      withType.media_type = 'movie';
      return normalizeMedia(withType);
    });
    return {
      items: items,
      page: data.page || page || 1,
      totalPages: data.total_pages || 1,
    };
  }

  /*
   * FASE 5 — Detalhes de uma série.
   * Endpoint: /tv/{id}
   * Usado para descobrir o número total de temporadas e a lista de
   * temporadas disponíveis (com episode_count). Especiais (season 0)
   * são incluídos.
   */
  async function getTvDetails(id, signal) {
    assertApiKey();
    var url = new URL(CONFIG.TMDB_BASE_URL + '/tv/' + encodeURIComponent(id));
    url.searchParams.set('api_key', CONFIG.TMDB_API_KEY);
    url.searchParams.set('language', CONFIG.LANGUAGE);

    var response = await fetchWithTimeout(url.toString(), { signal: signal });
    var data = await response.json();
    return {
      id: data.id,
      name: data.name || data.original_name || '',
      numberOfSeasons: data.number_of_seasons || 0,
      // Cada temporada: { season_number, name, episode_count }.
      // Filtramos entradas inválidas (algumas séries antigas devolvem null).
      seasons: (data.seasons || []).filter(function (s) {
        return typeof s.season_number === 'number';
      }).map(function (s) {
        return {
          season_number: s.season_number,
          name: s.name || '',
          episode_count: s.episode_count || 0,
        };
      }),
    };
  }

  /*
   * FASE 5 — Episódios de UMA temporada.
   * Endpoint: /tv/{id}/season/{season}
   * Retorna a lista de episódios já normalizada (number + name).
   */
  async function getSeasonEpisodes(id, seasonNumber, signal) {
    assertApiKey();
    var url = new URL(
      CONFIG.TMDB_BASE_URL + '/tv/' +
      encodeURIComponent(id) + '/season/' +
      encodeURIComponent(seasonNumber)
    );
    url.searchParams.set('api_key', CONFIG.TMDB_API_KEY);
    url.searchParams.set('language', CONFIG.LANGUAGE);

    var response = await fetchWithTimeout(url.toString(), { signal: signal });
    var data = await response.json();
    return (data.episodes || []).map(function (e) {
      return {
        number: e.episode_number,
        name: e.name || ('Episódio ' + e.episode_number),
      };
    });
  }

  function assertApiKey() {
    if (!CONFIG.TMDB_API_KEY) {
      throw new Error('TMDB API key ausente em CONFIG.TMDB_API_KEY.');
    }
  }

  /**
   * @typedef {Object} MediaItem
   * @property {number}      tmdbId
   * @property {'movie'|'tv'} type
   * @property {string}      title
   * @property {string}      overview
   * @property {string|null} posterUrl
   * @property {string}      releaseDate
   * @property {number}      voteAverage
   */
  function normalizeMedia(raw) {
    var isMovie = raw.media_type === 'movie';
    return {
      tmdbId: raw.id,
      type: isMovie ? 'movie' : 'tv',
      title: isMovie ? raw.title : raw.name,
      overview: raw.overview || '',
      posterUrl: raw.poster_path
        ? CONFIG.TMDB_IMG_BASE + '/' + CONFIG.POSTER_SIZE + raw.poster_path
        : null,
      releaseDate: (isMovie ? raw.release_date : raw.first_air_date) || '',
      voteAverage: typeof raw.vote_average === 'number' ? raw.vote_average : 0,
    };
  }

  /* ----------------------- 4. UI / Render ------------------------------- */

  var $grid = document.getElementById('grid');
  var cardTemplate = document.getElementById('card-template');

  /**
   * Observer compartilhado para lazy-load de TODAS as imagens.
   * Único, vive durante toda a sessão. Quando reconstruímos o grid,
   * só removemos os <img> antigos — o observer continua o mesmo.
   */
  var imageObserver = new IntersectionObserver(onImageIntersect, {
    rootMargin: CONFIG.LAZY_ROOT_MARGIN,
    threshold: 0.01,
  });

  function onImageIntersect(entries) {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry.isIntersecting) continue;
      var img = entry.target;
      var src = img.dataset.src;
      if (src) {
        // { once: true } → listener auto-removido após disparar.
        img.addEventListener('load', function () {
          this.classList.add('card__poster--loaded');
        }, { once: true });
        img.addEventListener('error', function () {
          this.classList.add('card__poster--errored');
        }, { once: true });
        img.src = src;
        img.removeAttribute('data-src');
      }
      imageObserver.unobserve(img);
    }
  }

  /** Skeletons enquanto carrega. */
  function showSkeletons(count) {
    clearGrid();
    var n = count || CONFIG.SKELETON_COUNT;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < n; i++) {
      var sk = document.createElement('div');
      sk.className = 'card card--skeleton';
      sk.setAttribute('aria-hidden', 'true');
      frag.appendChild(sk);
    }
    $grid.appendChild(frag);
    $grid.dataset.state = 'loading';
    $grid.setAttribute('aria-busy', 'true');
  }

  /**
   * Renderiza os cards no grid.
   * Usa DocumentFragment → 1 reflow em vez de N.
   *
   * MODULAR (Fase 3): a MESMA função serve para Trending e para
   * resultados de busca. A única diferença é a mensagem do estado
   * vazio, que vem via opts.emptyMessage. Sem duplicação de código.
   *
   * @param {MediaItem[]} items
   * @param {{ emptyMessage?: string }} [opts]
   */
  function renderCards(items, opts) {
    opts = opts || {};
    clearGrid();
    if (!items.length) {
      var p = document.createElement('p');
      p.className = 'grid__msg';
      p.textContent = opts.emptyMessage || 'Nenhum título encontrado.';
      $grid.appendChild(p);
      $grid.dataset.state = 'empty';
      $grid.setAttribute('aria-busy', 'false');
      return;
    }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      frag.appendChild(createCard(items[i]));
    }
    $grid.appendChild(frag);
    $grid.dataset.state = 'ready';
    $grid.setAttribute('aria-busy', 'false');

    // Registra todas as imagens lazy no observer compartilhado.
    var lazyImgs = $grid.querySelectorAll('img[data-src]');
    for (var j = 0; j < lazyImgs.length; j++) imageObserver.observe(lazyImgs[j]);
  }

  /**
   * [Fase 4] APPEND-only — usado pelo infinite scroll para adicionar
   * a próxima página SEM limpar o grid existente.
   *
   * Não toca em estado/aria-busy do grid (isso é responsabilidade do
   * controlador de loading). Apenas anexa cards e registra novas imgs
   * no observer (re-observar imgs já observadas é no-op).
   *
   * @param {MediaItem[]} items
   */
  function appendCards(items) {
    if (!items || !items.length) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      frag.appendChild(createCard(items[i]));
    }
    $grid.appendChild(frag);

    var lazyImgs = $grid.querySelectorAll('img[data-src]');
    for (var j = 0; j < lazyImgs.length; j++) imageObserver.observe(lazyImgs[j]);
  }

  /**
   * Cria um card a partir de um MediaItem (clona <template>).
   * @param {MediaItem} item
   * @returns {DocumentFragment}
   */
  function createCard(item) {
    var fragment = cardTemplate.content.cloneNode(true);
    var article = fragment.querySelector('.card');
    var img     = fragment.querySelector('.card__poster');
    var title   = fragment.querySelector('.card__title');
    var meta    = fragment.querySelector('.card__meta');
    var rating  = fragment.querySelector('.card__rating');

    /*
     * REQUISITO: guardar o TMDB id no próprio elemento HTML.
     * Também guardamos media_type — vai ser essencial na Fase 2 para
     * montar a URL correta do iframe (/filme/{id} para movie, /serie/{id} para tv).
     */
    article.dataset.id = String(item.tmdbId);
    article.dataset.mediaType = item.type;
    article.setAttribute('aria-label', item.title);

    // textContent (não innerHTML) → seguro contra XSS.
    title.textContent = item.title;
    meta.textContent  = formatMeta(item);

    if (item.voteAverage > 0) {
      rating.textContent = item.voteAverage.toFixed(1);
      rating.classList.add('card__rating--visible');
    }

    if (item.posterUrl) {
      // data-src: a imagem real só é setada pelo IntersectionObserver
      // quando o card entra (ou se aproxima de) na viewport.
      img.dataset.src = item.posterUrl;
      img.alt = 'Capa de ' + item.title;
    } else {
      img.alt = '';
      img.classList.add('card__poster--placeholder');
    }

    return fragment;
  }

  function formatMeta(item) {
    var year  = item.releaseDate ? item.releaseDate.slice(0, 4) : '—';
    var kind  = item.type === 'movie' ? 'Filme' : 'Série';
    return kind + ' • ' + year;
  }

  /** Estado de erro com botão de retry. */
  function showError(message, onRetry) {
    clearGrid();
    $grid.dataset.state = 'error';
    $grid.setAttribute('aria-busy', 'false');

    var wrap = document.createElement('div');
    wrap.className = 'grid__msg grid__msg--error';
    wrap.setAttribute('role', 'alert');

    var p1 = document.createElement('p');
    p1.textContent = 'Não foi possível carregar o catálogo.';
    var p2 = document.createElement('p');
    p2.className = 'grid__msg-detail';
    p2.textContent = message;
    wrap.appendChild(p1);
    wrap.appendChild(p2);

    if (typeof onRetry === 'function') {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'grid__retry';
      btn.textContent = 'Tentar novamente';
      btn.addEventListener('click', onRetry, { once: true });
      wrap.appendChild(btn);
    }
    $grid.appendChild(wrap);
  }

  function clearGrid() {
    // Desobserva imgs ANTES de removê-las (senão o observer segura
    // referências e o GC não libera os <img>).
    var imgs = $grid.querySelectorAll('img[data-src]');
    for (var i = 0; i < imgs.length; i++) imageObserver.unobserve(imgs[i]);
    // replaceChildren() é mais eficiente que innerHTML='' (sem reparse).
    $grid.replaceChildren();
  }

  /** Mensagem amigável de erro com base no tipo. */
  function humanizeError(err) {
    if (err.name === 'TimeoutError')    return 'Tempo limite excedido. Verifique sua conexão.';
    if (err.name === 'TypeError')       return 'Falha de rede.';
    if (err.status === 401)             return 'Chave de API inválida.';
    if (err.status === 404)             return 'Recurso não encontrado.';
    if (err.status === 429)             return 'Muitas requisições. Tente em alguns instantes.';
    if (typeof err.status === 'number') return 'Erro do servidor (' + err.status + ').';
    return err.message || 'Erro desconhecido.';
  }

  /* ----------------------- 5.0 SeriesEpisodes (FASE 5) ------------------ */

  /*
   * Módulo de Temporadas/Episódios. IIFE encapsula estado e cache.
   *
   * API pública:
   *   SeriesEpisodes.mount(item, $container, onPlay)
   *     - item:        { tmdbId, mediaType, title }
   *     - $container:  elemento <aside> com os 3 sub-elementos esperados
   *                    (#season-select, .episodes__loading, #episodes-list)
   *     - onPlay(s,e): callback chamado quando o usuário clica num episódio.
   *                    Recebe (seasonNumber, episodeNumber). É responsável
   *                    por atualizar o src do iframe.
   *
   *   SeriesEpisodes.destroy()
   *     - aborta requests pendentes, limpa listeners e esconde o painel.
   *     - chamado no close() do PlayerModal.
   *
   * DECISÕES DE PERFORMANCE:
   *   1) `cache` é um Object.create(null) NO ESCOPO DO IIFE — preservado
   *      entre aberturas do modal. Reabrir a mesma série não dispara
   *      nenhum fetch (REQUISITO 4 — cache de dados).
   *   2) Detalhes + Temporada 1 são buscados em PARALELO via Promise.all
   *      no mount(). Reduz pela metade o tempo até a primeira lista
   *      renderizar (vs. encadeado).
   *   3) AbortController por mount: trocar de série antes da resposta
   *      chegar cancela request anterior e descarta resultado obsoleto.
   *   4) Lista de episódios é renderizada via DocumentFragment — 1 reflow
   *      em vez de N (um por episódio).
   *   5) Cache de episódios é POR TEMPORADA — não baixamos todas as
   *      temporadas de uma vez (lazy). Só fetcha a temporada selecionada.
   */
  var SeriesEpisodes = (function () {
    'use strict';

    /*
     * Shape do cache:
     *   cache[tmdbId] = {
     *     detailsLoaded: bool,
     *     totalSeasons:  number,
     *     seasons:       [{ season_number, name, episode_count }],
     *     episodes:      { [seasonNumber]: [{ number, name }] }
     *   }
     */
    var cache = Object.create(null);

    // Estado do mount ATUAL (apenas 1 série visível por vez no modal).
    var current = null;

    function ensureCacheEntry(tmdbId) {
      if (!cache[tmdbId]) {
        cache[tmdbId] = {
          detailsLoaded: false,
          totalSeasons: 0,
          seasons: [],
          episodes: {},
        };
      }
      return cache[tmdbId];
    }

    function mount(item, $container, onPlay) {
      // Guarda contra mount duplicado: se já existe, destrói antes.
      destroy();

      var c = {
        tmdbId: item.tmdbId,
        controller: new AbortController(),
        $container: $container,
        $select: $container.querySelector('#season-select'),
        $loading: $container.querySelector('.episodes__loading'),
        $list: $container.querySelector('#episodes-list'),
        onPlay: onPlay,
        currentSeason: 1,
        currentEpisode: 1,
      };
      current = c;

      $container.hidden = false;

      // Listeners — todos com signal do AbortController p/ cleanup atômico.
      c.$select.addEventListener('change', onSeasonChange,  { signal: c.controller.signal });
      c.$list.addEventListener('click',    onEpisodeClick,  { signal: c.controller.signal });
      c.$list.addEventListener('keydown',  onEpisodeKeydown, { signal: c.controller.signal });

      // Carrega detalhes + temporada 1 em PARALELO (reduz TTI da lista).
      loadInitial(item.tmdbId);
    }

    async function loadInitial(tmdbId) {
      var c = current;
      if (!c || c.tmdbId !== tmdbId) return;

      var entry = ensureCacheEntry(tmdbId);
      showLoading();

      try {
        var detailsPromise;
        var episodesPromise;

        // Cache hit em detalhes? Skip fetch.
        if (entry.detailsLoaded) {
          detailsPromise = Promise.resolve(entry);
        } else {
          detailsPromise = getTvDetails(tmdbId, c.controller.signal).then(function (d) {
            entry.detailsLoaded = true;
            entry.totalSeasons = d.numberOfSeasons;
            entry.seasons = d.seasons;
            return entry;
          });
        }

        // Cache hit na temporada 1? Skip fetch.
        if (entry.episodes[1]) {
          episodesPromise = Promise.resolve(entry.episodes[1]);
        } else {
          episodesPromise = getSeasonEpisodes(tmdbId, 1, c.controller.signal).then(function (eps) {
            entry.episodes[1] = eps;
            return eps;
          });
        }

        // Promise.all: paraleliza as 2 requests (perf decisão 2).
        var results = await Promise.all([detailsPromise, episodesPromise]);
        var episodes = results[1];

        // Race guard: usuário pode ter trocado de série.
        if (!current || current.tmdbId !== tmdbId) return;

        renderSeasonOptions(entry.seasons, current.currentSeason);
        renderEpisodes(episodes, current.currentEpisode);
        hideLoading();
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.error('[Streaming MVP] Falha ao carregar série/temporada:', err);
        hideLoading();
        renderListError();
      }
    }

    async function loadSeason(seasonNumber) {
      var c = current;
      if (!c) return;

      var entry = ensureCacheEntry(c.tmdbId);

      // CACHE HIT — render síncrono, ZERO fetch (REQUISITO 4).
      if (entry.episodes[seasonNumber]) {
        renderEpisodes(entry.episodes[seasonNumber], null);
        return;
      }

      showLoading();
      try {
        var eps = await getSeasonEpisodes(c.tmdbId, seasonNumber, c.controller.signal);
        if (!current || current.tmdbId !== c.tmdbId) return;
        entry.episodes[seasonNumber] = eps;
        renderEpisodes(eps, null);
        hideLoading();
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.error('[Streaming MVP] Falha ao carregar temporada:', err);
        hideLoading();
        renderListError();
      }
    }

    /* ---- handlers ---- */

    function onSeasonChange(event) {
      var season = Number(event.target.value);
      if (!Number.isFinite(season)) return;
      current.currentSeason = season;
      loadSeason(season);
    }

    function onEpisodeClick(event) {
      var li = event.target.closest('.episodes__item');
      if (!li || !current.$list.contains(li)) return;
      activateEpisode(Number(li.dataset.season), Number(li.dataset.episode));
    }

    function onEpisodeKeydown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var li = event.target.closest('.episodes__item');
      if (!li) return;
      event.preventDefault();
      activateEpisode(Number(li.dataset.season), Number(li.dataset.episode));
    }

    function activateEpisode(season, episode) {
      if (!current) return;
      current.currentSeason = season;
      current.currentEpisode = episode;

      // Marca o item ATIVO sem regerar a lista (zero re-render).
      var items = current.$list.querySelectorAll('.episodes__item');
      Array.prototype.forEach.call(items, function (it) {
        var match = Number(it.dataset.season) === season && Number(it.dataset.episode) === episode;
        it.classList.toggle('episodes__item--active', match);
        it.setAttribute('aria-selected', match ? 'true' : 'false');
      });

      // Notifica o PlayerModal (ele atualiza o iframe.src).
      if (typeof current.onPlay === 'function') current.onPlay(season, episode);
    }

    /* ---- render ---- */

    function renderSeasonOptions(seasons, selected) {
      var $sel = current.$select;
      $sel.replaceChildren();

      // Algumas séries têm season 0 ("Especiais"). Mantemos no <select>
      // mas auto-seleção sempre prioriza temporada 1.
      seasons.forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = String(s.season_number);
        var label;
        if (s.season_number === 0) {
          label = s.name || 'Especiais';
        } else {
          // Se TMDB já entrega "Temporada 1" / "Season 1", usamos.
          label = s.name && /Season|Temporada/i.test(s.name)
            ? s.name
            : 'Temporada ' + s.season_number;
        }
        if (s.episode_count) label += ' · ' + s.episode_count + ' ep';
        opt.textContent = label;
        $sel.appendChild(opt);
      });

      // Garante que selected está nas opções; senão pega a primeira.
      var found = Array.prototype.some.call($sel.options, function (o) {
        return Number(o.value) === selected;
      });
      $sel.value = found ? String(selected) : ($sel.options[0] ? $sel.options[0].value : '');
      if (!found && $sel.options[0]) {
        current.currentSeason = Number($sel.options[0].value);
      }
    }

    function renderEpisodes(episodes, activeEpisode) {
      var $list = current.$list;
      $list.replaceChildren();

      if (!episodes || !episodes.length) {
        var empty = document.createElement('li');
        empty.className = 'episodes__empty';
        empty.textContent = 'Nenhum episódio encontrado nesta temporada.';
        $list.appendChild(empty);
        return;
      }

      // DocumentFragment → 1 único reflow (perf decisão 4).
      var fragment = document.createDocumentFragment();
      episodes.forEach(function (ep) {
        var li = document.createElement('li');
        li.className = 'episodes__item';
        li.setAttribute('role', 'option');
        li.tabIndex = 0;
        li.dataset.season = String(current.currentSeason);
        li.dataset.episode = String(ep.number);

        var isActive = activeEpisode && ep.number === activeEpisode;
        if (isActive) li.classList.add('episodes__item--active');
        li.setAttribute('aria-selected', isActive ? 'true' : 'false');

        var num = document.createElement('span');
        num.className = 'episodes__num';
        // Formato "E01 - Pilot" (REQUISITO de UI).
        var n = ep.number;
        num.textContent = 'E' + (n < 10 ? '0' + n : n);

        var title = document.createElement('span');
        title.className = 'episodes__title';
        // textContent → safe contra XSS no nome do episódio.
        title.textContent = ep.name;

        li.appendChild(num);
        li.appendChild(title);
        fragment.appendChild(li);
      });
      $list.appendChild(fragment);
    }

    function renderListError() {
      current.$list.replaceChildren();
      var li = document.createElement('li');
      li.className = 'episodes__empty';
      li.textContent = 'Erro ao carregar episódios. Tente outra temporada.';
      current.$list.appendChild(li);
    }

    function showLoading() {
      if (!current) return;
      if (current.$loading) current.$loading.hidden = false;
      current.$list.setAttribute('aria-busy', 'true');
    }

    function hideLoading() {
      if (!current) return;
      if (current.$loading) current.$loading.hidden = true;
      current.$list.setAttribute('aria-busy', 'false');
    }

    function destroy() {
      if (!current) return;
      // 1 abort() = remove todos os listeners + cancela requests pendentes.
      try { current.controller.abort(); } catch (e) { /* noop */ }
      if (current.$container) current.$container.hidden = true;
      if (current.$select)    current.$select.replaceChildren();
      if (current.$list)      current.$list.replaceChildren();
      if (current.$loading)   current.$loading.hidden = true;
      current = null;
    }

    return { mount: mount, destroy: destroy };
  })();

  /* ----------------------- 5. Player Modal ------------------------------ */

  /**
   * Módulo PlayerModal: abre um overlay com iframe injetado dinamicamente,
   * fecha removendo o iframe COMPLETAMENTE do DOM (corta áudio e banda).
   *
   * Estado mantido em closure (encapsulado, não global):
   *   - isOpen        : guard contra reentradas
   *   - iframe        : referência do iframe quando aberto, null quando fechado
   *   - currentItem   : item sendo reproduzido (p/ retry / abrir em nova aba)
   *   - loadTimerId   : timer do timeout de carregamento (12s)
   *   - cleanups      : AbortController que agrega TODOS os listeners de open()
   *   - lastFocused   : elemento que tinha foco antes de abrir (restaurado no close)
   */
  var PlayerModal = (function () {
    var $modal          = document.getElementById('player-modal');
    var $title          = document.getElementById('player-title');
    var $mount          = document.getElementById('player-mount');
    var $episodesPanel  = document.getElementById('episodes-panel');
    var $closeBtns      = $modal.querySelectorAll('[data-modal-close]');

    var IFRAME_LOAD_TIMEOUT_MS = 12000;
    var SUPERFLIX_BASE = 'https://superflixapi.online';

    /*
     * FASE 5 — Sandbox do iframe (BLOQUEIO DE ANÚNCIOS).
     *
     * Lista permissiva MÍNIMA — exatamente o que o player precisa:
     *   - allow-forms          → submeter forms (alguns players usam)
     *   - allow-scripts        → executar JS do player
     *   - allow-same-origin    → manter origin do superflix (cookies/storage)
     *   - allow-presentation   → permitir Presentation API (cast/fullscreen)
     *
     * O QUE FICA BLOQUEADO (= ad mitigation):
     *   - allow-popups          → window.open(), target=_blank → bloqueado
     *   - allow-modals          → alert/confirm/prompt → bloqueado
     *   - allow-top-navigation  → o iframe NÃO pode redirecionar nossa página
     *   - allow-pointer-lock, allow-downloads, etc. → todos negados
     *
     * Resultado: redirects agressivos do Superflix são neutralizados.
     */
    var IFRAME_SANDBOX = 'allow-forms allow-scripts allow-same-origin allow-presentation';

    var state = {
      isOpen: false,
      iframe: null,
      currentItem: null,
      currentSeason: null,    // FASE 5 — temporada ATIVA (apenas tv)
      currentEpisode: null,   // FASE 5 — episódio ATIVO (apenas tv)
      loadTimerId: 0,
      cleanups: null,
      lastFocused: null,
    };

    /**
     * Constrói a URL do iframe conforme o tipo de mídia.
     * REQUISITO: movie → /filme/{id} ; tv → /serie/{id}.
     * FASE 5: para séries, anexa ?season=S&episode=E quando ambos
     * são fornecidos (REQUISITO 5 — player dinâmico).
     */
    function buildPlayerUrl(mediaType, tmdbId, season, episode) {
      var pathSegment = mediaType === 'movie' ? 'filme' : 'serie';
      var url = SUPERFLIX_BASE + '/' + pathSegment + '/' + encodeURIComponent(tmdbId);
      if (mediaType === 'tv' && season && episode) {
        url += '?season=' + encodeURIComponent(season) +
               '&episode=' + encodeURIComponent(episode);
      }
      return url;
    }

    /**
     * Abre o modal com o player do item.
     * @param {{ tmdbId: number, mediaType: 'movie'|'tv', title: string }} item
     */
    function open(item) {
      // Reabre limpo se já estiver aberto (não acumular iframes).
      if (state.isOpen) close();

      state.isOpen = true;
      state.currentItem = item;
      state.lastFocused = document.activeElement;

      // FASE 5 — para séries, default S1E1 (UX Netflix-like: o player já
      // arranca tocando o piloto sem o usuário precisar clicar).
      var isTv = item.mediaType === 'tv';
      state.currentSeason  = isTv ? 1 : null;
      state.currentEpisode = isTv ? 1 : null;

      // AbortController: 1 abort() = todos os listeners desligados.
      state.cleanups = new AbortController();
      var sig = state.cleanups.signal;

      // 1) Body scroll lock sem layout shift (compensa scrollbar).
      var scrollbarW = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbarW > 0) document.body.style.paddingRight = scrollbarW + 'px';

      // 2) Header + classe modal--tv (CSS adapta layout para séries).
      $title.textContent = item.title || 'Player';
      $modal.classList.toggle('modal--tv', isTv);
      renderLoadingState();

      // 3) Cria o iframe DINAMICAMENTE — não existe no HTML.
      var iframe = document.createElement('iframe');
      iframe.className = 'player__iframe';
      iframe.title = 'Player de vídeo — ' + (item.title || 'mídia');
      iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = 'no-referrer';

      // FASE 5 — SANDBOX (BLOQUEIO DE ANÚNCIOS — REQUISITO 6).
      // Sem allow-popups e sem allow-modals: redirects do Superflix são bloqueados.
      iframe.setAttribute('sandbox', IFRAME_SANDBOX);

      // 4) Listeners do iframe — agrupados no AbortController.
      iframe.addEventListener('load', onIframeLoad, { signal: sig, once: true });
      iframe.addEventListener('error', onIframeFail, { signal: sig, once: true });

      // 5) Timeout de fallback: se 'load' não disparar em N seg, mostra erro.
      state.loadTimerId = setTimeout(function () {
        onIframeFail(new Error('iframe load timeout (' + IFRAME_LOAD_TIMEOUT_MS + 'ms)'));
      }, IFRAME_LOAD_TIMEOUT_MS);

      // 6) src é o ÚLTIMO passo — só agora a request começa.
      iframe.src = buildPlayerUrl(item.mediaType, item.tmdbId,
                                   state.currentSeason, state.currentEpisode);
      state.iframe = iframe;

      // 7) Anexa o iframe ao mount.
      $mount.appendChild(iframe);

      // 8) Mostra modal (CSS faz fade-in via transition).
      $modal.classList.add('modal--open');
      $modal.setAttribute('aria-hidden', 'false');

      // 9) Listeners de fechamento — também agrupados no signal.
      document.addEventListener('keydown', onKeydown, { signal: sig });
      Array.prototype.forEach.call($closeBtns, function (btn) {
        btn.addEventListener('click', close, { signal: sig });
      });

      // 10) FASE 5 — monta painel de Temporadas/Episódios (SOMENTE p/ tv).
      //     onPlayEpisode é o callback que troca o src do iframe.
      if (isTv && $episodesPanel && typeof SeriesEpisodes !== 'undefined') {
        SeriesEpisodes.mount(item, $episodesPanel, onPlayEpisode);
      }

      // 11) Foco inicial no botão fechar (acessibilidade).
      //     setTimeout 0 para garantir que o modal já está visível.
      setTimeout(function () {
        var closeBtn = $modal.querySelector('.modal__close');
        if (closeBtn) closeBtn.focus();
      }, 0);
    }

    /*
     * FASE 5 — Callback chamado pelo SeriesEpisodes quando o usuário
     * clica num episódio. Atualiza o src do iframe SEM destruí-lo
     * (mantém o player montado, troca só a URL).
     *
     * POR QUÊ não recriar o iframe:
     *   - Trocar src dispara um navigation (cheap), não um destroy/create.
     *   - Mantém os listeners e o sandbox já configurados.
     *   - Evita o flash de "Carregando player…" entre episódios.
     */
    function onPlayEpisode(seasonNumber, episodeNumber) {
      if (!state.isOpen || !state.iframe || !state.currentItem) return;
      state.currentSeason  = seasonNumber;
      state.currentEpisode = episodeNumber;
      var newUrl = buildPlayerUrl(
        state.currentItem.mediaType,
        state.currentItem.tmdbId,
        seasonNumber,
        episodeNumber
      );
      // Decisão de performance: trocar `src` direto é o caminho mais barato.
      // O sandbox e listeners do iframe permanecem intactos.
      try { state.iframe.src = newUrl; } catch (e) {
        console.error('[Streaming MVP] Falha ao trocar episódio:', e);
      }
    }

    /**
     * Fecha o modal e libera TODOS os recursos.
     * É a parte crítica: garantir zero memory leak e parada de banda/áudio.
     */
    function close() {
      if (!state.isOpen) return;

      // 1) Cancela timer + desliga TODOS os listeners de uma vez.
      if (state.loadTimerId) { clearTimeout(state.loadTimerId); state.loadTimerId = 0; }
      if (state.cleanups)    { state.cleanups.abort(); state.cleanups = null; }

      // 1.5) FASE 5 — desmonta painel de séries (aborta requests e listeners).
      if (typeof SeriesEpisodes !== 'undefined') SeriesEpisodes.destroy();
      $modal.classList.remove('modal--tv');

      // 2) Remove o iframe DE VERDADE.
      //    src = 'about:blank' ANTES de removeChild — passo essencial:
      //    no Chromium isso interrompe o pipeline de mídia e o download
      //    do conteúdo. Sem isso, em algumas versões o iframe continua
      //    consumindo banda/áudio por alguns segundos após sair do DOM.
      if (state.iframe) {
        try { state.iframe.src = 'about:blank'; } catch (e) { /* noop */ }
        if (state.iframe.parentNode) state.iframe.parentNode.removeChild(state.iframe);
        state.iframe = null;
      }

      // 3) Limpa qualquer placeholder/erro que tenha ficado no mount.
      $mount.replaceChildren();

      // 4) Esconde modal e restaura body.
      $modal.classList.remove('modal--open');
      $modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';

      // 5) Restaura o foco no elemento anterior (acessibilidade).
      if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
        try { state.lastFocused.focus(); } catch (e) { /* noop */ }
      }
      state.lastFocused = null;
      state.currentItem = null;
      state.currentSeason = null;
      state.currentEpisode = null;
      state.isOpen = false;
    }

    /* ---- handlers ---- */

    function onIframeLoad() {
      // 'load' do iframe disparou — cancela o timeout e remove o spinner.
      if (state.loadTimerId) { clearTimeout(state.loadTimerId); state.loadTimerId = 0; }
      var loading = $mount.querySelector('.player__loading');
      if (loading) loading.remove();
      // Observação: por ser cross-origin, NÃO conseguimos inspecionar o
      // conteúdo do iframe. Se o superflix devolveu uma página de erro,
      // 'load' ainda dispara. Para detecção fina, só com integração
      // dedicada da API do player (fora do escopo do MVP).
    }

    function onIframeFail(err) {
      console.error('[Streaming MVP] Player iframe falhou:', err);
      if (state.loadTimerId) { clearTimeout(state.loadTimerId); state.loadTimerId = 0; }

      // Remove o iframe quebrado (corta conexão) e mostra fallback.
      if (state.iframe) {
        try { state.iframe.src = 'about:blank'; } catch (e) {}
        if (state.iframe.parentNode) state.iframe.parentNode.removeChild(state.iframe);
        state.iframe = null;
      }
      renderErrorState();
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }

    /* ---- estados visuais ---- */

    function renderLoadingState() {
      $mount.replaceChildren();
      var box = document.createElement('div');
      box.className = 'player__loading';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');

      var spinner = document.createElement('div');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');

      var label = document.createElement('p');
      label.textContent = 'Carregando player…';

      box.appendChild(spinner);
      box.appendChild(label);
      $mount.appendChild(box);
    }

    function renderErrorState() {
      $mount.replaceChildren();
      var box = document.createElement('div');
      box.className = 'player__error';
      box.setAttribute('role', 'alert');

      var t = document.createElement('p');
      t.className = 'player__error-title';
      t.textContent = 'Player indisponível';

      var d = document.createElement('p');
      d.className = 'player__error-detail';
      d.textContent = 'Não foi possível carregar o player. Tente novamente em instantes.';

      var actions = document.createElement('div');
      actions.className = 'player__error-actions';

      // Botão 'Tentar novamente' — fecha+reabre com o mesmo item.
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'grid__retry';
      retry.textContent = 'Tentar novamente';
      retry.addEventListener('click', function () {
        var item = state.currentItem;
        if (!item) return;
        close();
        // setTimeout 0 → reset visual completo entre close e novo open.
        setTimeout(function () { open(item); }, 0);
      }, { signal: state.cleanups ? state.cleanups.signal : undefined });

      // Link 'Abrir em nova aba' — fallback definitivo.
      var link = document.createElement('a');
      link.className = 'player__error-link';
      link.textContent = 'Abrir em nova aba';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (state.currentItem) {
        link.href = buildPlayerUrl(
          state.currentItem.mediaType,
          state.currentItem.tmdbId,
          state.currentSeason,
          state.currentEpisode
        );
      }

      actions.appendChild(retry);
      actions.appendChild(link);

      box.appendChild(t);
      box.appendChild(d);
      box.appendChild(actions);
      $mount.appendChild(box);
    }

    // API pública do módulo.
    return { open: open, close: close };
  })();

  /* ==========================================================================
     6. Bootstrap (Fase 4 — estado unificado + paginação + infinite scroll)
     ========================================================================== */

  /*
   * controller único para a request EM ANDAMENTO no grid (qualquer modo).
   * Cada loadFirstPage / loadMore aborta o anterior — evita race conditions
   * (ex.: usuário troca de gênero antes da página anterior responder).
   */
  var currentController = null;

  /*
   * Estado central da view. UMA fonte da verdade.
   *
   *   mode:        'home' | 'search' | 'genre'
   *   query:       string ativa (modo search)
   *   genreId:     id ativo (modo genre)
   *   genreName:   nome do gênero ativo (para o header)
   *   page:        última página JÁ carregada com sucesso
   *   totalPages:  total reportado pela API
   *   isLoading:   true durante qualquer fetch do grid
   *   hasMore:     há mais páginas a buscar?
   */
  var state = {
    mode: 'home',
    query: '',
    genreId: null,
    genreName: '',
    page: 0,
    totalPages: 1,
    isLoading: false,
    hasMore: true,
  };

  /* Refs do header da seção e dos elementos de paginação. */
  var $sectionTitle = document.getElementById('trending-title');
  var $sectionSub   = document.querySelector('.section__sub');
  var $loadMore     = document.getElementById('grid-loadmore');
  var $sentinel     = document.getElementById('grid-sentinel');
  var $chips        = document.getElementById('genres-chips');

  /* ----- Header dinâmico baseado no modo atual ------------------------- */

  function setHeader() {
    if (state.mode === 'search') {
      $sectionTitle.textContent = 'Resultados para "' + state.query + '"';
      $sectionSub.textContent   = 'Filmes e séries encontrados na TMDB';
    } else if (state.mode === 'genre') {
      $sectionTitle.textContent = 'Gênero: ' + state.genreName;
      $sectionSub.textContent   = 'Filmes mais populares deste gênero';
    } else {
      $sectionTitle.textContent = 'Em alta nesta semana';
      $sectionSub.textContent   = 'Filmes e séries mais populares no momento';
    }
  }

  function getEmptyMessage() {
    if (state.mode === 'search') return 'Nenhum resultado para "' + state.query + '".';
    if (state.mode === 'genre')  return 'Nenhum filme encontrado neste gênero.';
    return 'Nenhum título em alta no momento.';
  }

  /* ----- Spinner inferior ---------------------------------------------- */

  function showBottomSpinner() { $loadMore.hidden = false; }
  function hideBottomSpinner() { $loadMore.hidden = true; }

  /* ----- Sentinel + IntersectionObserver para infinite scroll ---------- */

  /*
   * rootMargin grande (400px) → começamos a carregar ANTES do usuário
   * atingir o final do grid, eliminando a sensação de "trava".
   *
   * threshold 0 (default) → basta 1 pixel do sentinel entrar na viewport.
   */
  var sentinelObserver = new IntersectionObserver(onSentinelIntersect, {
    root: null,
    rootMargin: '400px 0px',
    threshold: 0,
  });

  function onSentinelIntersect(entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting) {
        loadMore();
        // Não precisa unobserve aqui — loadMore() faz isso internamente
        // para evitar disparos paralelos enquanto o fetch está em voo.
      }
    }
  }

  function observeSentinel() {
    $sentinel.style.display = '';
    sentinelObserver.observe($sentinel);
  }

  function unobserveSentinel() {
    sentinelObserver.unobserve($sentinel);
  }

  function hideSentinel() {
    sentinelObserver.unobserve($sentinel);
    $sentinel.style.display = 'none';
  }

  /* ----- Dispatcher: qual endpoint chamar para o modo atual ------------ */

  function fetchForCurrentMode(page, signal) {
    if (state.mode === 'search') return searchMulti(state.query, page, signal);
    if (state.mode === 'genre')  return getByGenre(state.genreId, page, signal);
    return getTrending(page, signal);
  }

  /* ----- Carregamento da PRIMEIRA página de um modo -------------------- */

  /**
   * Reseta o grid e busca a página 1 do modo atual (state.mode/query/genreId).
   * Chamado em qualquer transição de modo: home → search, search → genre, etc.
   */
  async function loadFirstPage() {
    // Cancela request anterior + para infinite scroll enquanto reseta.
    if (currentController) currentController.abort();
    currentController = new AbortController();
    unobserveSentinel();
    hideBottomSpinner();

    // REQUISITO: ao trocar de modo, a página é resetada para 1 e o grid limpo.
    state.page = 0;
    state.totalPages = 1;
    state.hasMore = true;
    state.isLoading = true;

    setHeader();
    showSkeletons();

    console.log('[Streaming MVP] loadFirstPage →',
      { mode: state.mode, query: state.query, genreId: state.genreId });

    try {
      var result = await fetchForCurrentMode(1, currentController.signal);
      state.isLoading = false;
      state.page = result.page;
      state.totalPages = result.totalPages;
      state.hasMore = result.page < result.totalPages;

      console.log('[Streaming MVP] page 1 ok →',
        { items: result.items.length, totalPages: result.totalPages, hasMore: state.hasMore });

      renderCards(result.items, { emptyMessage: getEmptyMessage() });

      // Religa o infinite scroll só se ainda há páginas e veio item nesta.
      if (state.hasMore && result.items.length > 0) observeSentinel();
      else hideSentinel();
    } catch (err) {
      state.isLoading = false;
      if (err.name === 'AbortError') return;     // foi cancelada por nós
      console.error('[Streaming MVP] Falha ao carregar página 1:', err);
      showError(humanizeError(err), loadFirstPage);
    }
  }

  /* ----- Carregamento das páginas SUBSEQUENTES (infinite scroll) ------- */

  async function loadMore() {
    // Guards: evita disparos paralelos e respeita totalPages da API.
    if (state.isLoading || !state.hasMore) return;

    // Pausa o observer enquanto a request está em voo
    // (evita o sentinel disparar 5 vezes seguidas no mesmo scroll).
    unobserveSentinel();

    if (currentController) currentController.abort();
    currentController = new AbortController();
    state.isLoading = true;
    showBottomSpinner();

    var nextPage = state.page + 1;
    console.log('[Streaming MVP] loadMore →', { mode: state.mode, page: nextPage });

    try {
      var result = await fetchForCurrentMode(nextPage, currentController.signal);
      state.isLoading = false;
      state.page = result.page;
      state.totalPages = result.totalPages;
      state.hasMore = result.page < result.totalPages;

      console.log('[Streaming MVP] page', nextPage, 'ok →',
        { items: result.items.length, hasMore: state.hasMore });

      appendCards(result.items);
      hideBottomSpinner();

      if (state.hasMore && result.items.length > 0) observeSentinel();
      else hideSentinel();
    } catch (err) {
      state.isLoading = false;
      hideBottomSpinner();
      if (err.name === 'AbortError') return;

      console.error('[Streaming MVP] Falha ao carregar página', nextPage, '-', err);
      // Em caso de erro numa página seguinte, não destruímos o grid já
      // renderizado. Apenas religamos o sentinel para o usuário tentar
      // novamente ao re-rolar.
      if (state.hasMore) observeSentinel();
    }
  }

  /* ===== Click delegation no grid (cards → PlayerModal) ================ */

  $grid.addEventListener('click', function (event) {
    var card = event.target.closest('.card');
    if (!card || !card.dataset.id) return;       // ignora skeletons/msgs
    var titleEl = card.querySelector('.card__title');
    PlayerModal.open({
      tmdbId: Number(card.dataset.id),
      mediaType: card.dataset.mediaType,
      title: titleEl ? titleEl.textContent : '',
    });
  });

  $grid.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var card = event.target.closest('.card');
    if (!card || !card.dataset.id) return;
    event.preventDefault();
    card.click();
  });

  /* ===== 6.1 Search wiring (Fase 3) ==================================== */

  var $searchInput = document.getElementById('search-input');
  var $searchClear = document.getElementById('search-clear');
  var $searchForm  = document.getElementById('search-form');

  if (!$searchInput || !$searchClear || !$searchForm) {
    console.error('[Streaming MVP] Elementos de busca não encontrados no DOM:',
      { $searchInput: $searchInput, $searchClear: $searchClear, $searchForm: $searchForm });
  } else {
    console.log('[Streaming MVP] Search wiring inicializado com sucesso.');
  }

  /**
   * Decide qual view carregar com base no valor do input.
   * Trocar para search também desativa o filtro de gênero (mutuamente exclusivos).
   */
  function applyQuery(rawQuery) {
    var query = (rawQuery || '').trim();
    console.log('[Streaming MVP] applyQuery →', JSON.stringify(query));

    if (!query) {
      // REQUISITO Fase 3: input vazio → volta pro Trending automaticamente.
      // (Se um chip estava ativo, mantemos ele — só limpamos search.)
      if (state.mode === 'search') {
        state.mode = 'home';
        state.query = '';
        state.genreId = null;
        state.genreName = '';
        updateChipsUI();
        loadFirstPage();
      }
      return;
    }

    // Evita refazer a mesma busca.
    if (state.mode === 'search' && state.query === query) return;

    // Nova busca → desativa qualquer chip ativo (modos exclusivos).
    state.mode = 'search';
    state.query = query;
    state.genreId = null;
    state.genreName = '';
    updateChipsUI();
    loadFirstPage();
  }

  var debouncedApplyQuery = debounce(applyQuery, 500);

  $searchInput.addEventListener('input', function (event) {
    var value = event.target.value;
    $searchClear.hidden = !value;
    debouncedApplyQuery(value);
  });

  $searchClear.addEventListener('click', function () {
    debouncedApplyQuery.cancel();
    $searchInput.value = '';
    $searchClear.hidden = true;
    $searchInput.focus();
    applyQuery('');
  });

  $searchForm.addEventListener('submit', function (event) {
    event.preventDefault();
    debouncedApplyQuery.cancel();
    applyQuery($searchInput.value);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== '/') return;
    var t = event.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    var modalOpen = document.getElementById('player-modal').classList.contains('modal--open');
    if (modalOpen) return;
    event.preventDefault();
    $searchInput.focus();
    $searchInput.select();
  });

  /* ===== 6.2 Genre chips (Fase 4) ====================================== */

  /** Renderiza skeletons enquanto os gêneros carregam. */
  function renderChipSkeletons() {
    var widths = [70, 90, 100, 80, 110, 60, 90, 75];
    var frag = document.createDocumentFragment();
    for (var i = 0; i < widths.length; i++) {
      var sk = document.createElement('span');
      sk.className = 'chip chip--skeleton';
      sk.style.width = widths[i] + 'px';
      sk.setAttribute('aria-hidden', 'true');
      frag.appendChild(sk);
    }
    $chips.replaceChildren(frag);
  }

  /** Renderiza os chips reais. Genre 0 é o "Todos" (limpa filtro). */
  function renderChips(genres) {
    var frag = document.createDocumentFragment();

    // Chip "Todos" → volta pra Home (Trending).
    frag.appendChild(makeChip(0, 'Todos'));

    for (var i = 0; i < genres.length; i++) {
      frag.appendChild(makeChip(genres[i].id, genres[i].name));
    }

    $chips.replaceChildren(frag);
    $chips.setAttribute('aria-busy', 'false');
    updateChipsUI();
  }

  function makeChip(id, name) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.genreId = String(id);
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = name;
    return btn;
  }

  /** Sincroniza a aparência dos chips com o estado atual. */
  function updateChipsUI() {
    var chips = $chips.querySelectorAll('.chip[data-genre-id]');
    var activeId = state.mode === 'genre' ? state.genreId : 0; // 0 = "Todos"
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i];
      var id = Number(chip.dataset.genreId);
      var isActive = id === activeId && (state.mode === 'genre' || (state.mode === 'home' && id === 0));
      chip.classList.toggle('chip--active', isActive);
      chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
  }

  /** Click delegation nos chips. */
  $chips.addEventListener('click', function (event) {
    var chip = event.target.closest('.chip[data-genre-id]');
    if (!chip) return;
    var id = Number(chip.dataset.genreId);
    var name = chip.textContent;

    // Chip "Todos" → volta para Home.
    if (id === 0) {
      if (state.mode === 'home') return;       // já estamos em home
      state.mode = 'home';
      state.query = '';
      state.genreId = null;
      state.genreName = '';
      $searchInput.value = '';
      $searchClear.hidden = true;
      updateChipsUI();
      loadFirstPage();
      return;
    }

    // Click no chip JÁ ativo → desativa e volta para Home.
    if (state.mode === 'genre' && state.genreId === id) {
      state.mode = 'home';
      state.genreId = null;
      state.genreName = '';
      updateChipsUI();
      loadFirstPage();
      return;
    }

    // Novo gênero → modo 'genre'. Limpa busca (modos exclusivos).
    state.mode = 'genre';
    state.genreId = id;
    state.genreName = name;
    state.query = '';
    $searchInput.value = '';
    $searchClear.hidden = true;
    updateChipsUI();
    loadFirstPage();
  });

  /** Boot dos chips: carrega /genre/movie/list de forma independente. */
  async function loadGenres() {
    renderChipSkeletons();
    try {
      var genres = await getMovieGenres();
      console.log('[Streaming MVP] Gêneros carregados:', genres.length);
      renderChips(genres);
    } catch (err) {
      console.error('[Streaming MVP] Falha ao carregar gêneros:', err);
      // Falha aqui não derruba o app — só esconde a barra de filtros.
      $chips.replaceChildren();
      $chips.setAttribute('aria-busy', 'false');
      var nav = document.querySelector('.filters');
      if (nav) nav.style.display = 'none';
    }
  }

  /* ===== Cleanup ao descartar a página ================================= */

  window.addEventListener('pagehide', function () {
    if (currentController) currentController.abort();
    imageObserver.disconnect();
    sentinelObserver.disconnect();
    PlayerModal.close();
  }, { once: true });

  /* ===== Kick-off ====================================================== */

  loadGenres();          // chips em paralelo (não bloqueia o grid)
  loadFirstPage();       // primeira página do Trending
})();
