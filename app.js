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
    TMDB_IMG_BASE: 'https://image.tmdb.org/t/p',
    POSTER_SIZE: 'w342',
    BACKDROP_SIZE: 'w1280',
    STILL_SIZE: 'w300',
    PROFILE_SIZE: 'w185',
    LANGUAGE: 'pt-BR',
    REGION: 'BR',
    TIMEOUT_MS: 8000,
    RETRY_ATTEMPTS: 1,
    RETRY_DELAY_MS: 600,
    SKELETON_COUNT: 12,
    LAZY_ROOT_MARGIN: '200px',
    CAST_LIMIT: 12,
  });

  /* ----------------------- 1.b Supabase (FASE 6.1) ---------------------- */

  /**
   * Configuração do Supabase — Project URL + Publishable Key.
   *
   * SEGURANÇA: a `publishable key` (formato `sb_publishable_...`) é o
   * substituto novo do `anon key` e é DESENHADA pra ficar pública no
   * client. Quem protege os dados são as policies de RLS (Row Level
   * Security) no Postgres do Supabase. Não é credencial sensível —
   * pode commitar no repo público sem problema.
   *
   * NUNCA usar `service_role` key no front (essa sim bypassa RLS).
   */
  var SUPABASE_CONFIG = Object.freeze({
    URL: 'https://oxgibqccznmysncubkct.supabase.co',
    PUBLISHABLE_KEY: 'sb_publishable_Sl4wOBxdNlpdYtyxN4H5GQ_fKcHTKHw',
  });

  /**
   * Cliente Supabase global. Inicializado ANTES de qualquer módulo IIFE
   * pra que `loadFavorites()`, `loadWatchHistory()`, etc. (próximas fases)
   * possam usá-lo direto.
   *
   * Decisões:
   *  - `auth.persistSession: true` (FASE 7.1) — guarda o JWT no
   *    localStorage. F5 reenvia INITIAL_SESSION com a sessão recuperada,
   *    o usuário fica logado entre reloads e tabs.
   *  - `auth.autoRefreshToken: true` — refresha o JWT antes do expiry
   *    automaticamente (sem isso, expiraria silenciosamente em ~1h).
   *  - `auth.detectSessionInUrl: true` — pra fluxos de OAuth/magic-link
   *    (callback redireciona com #access_token na URL). Default true,
   *    mas explícito pra clareza.
   *  - Exposto em `window.YverFlix.supabase` (não polui `window` direto)
   *    pra facilitar debug no DevTools sem expor uma variável solta.
   *  - Guard pro caso do CDN não ter carregado (fallback gracioso: app
   *    ainda funciona, só sem persistência).
   */
  var supabaseClient = null;
  if (typeof window.supabase !== 'undefined' && window.supabase.createClient) {
    supabaseClient = window.supabase.createClient(
      SUPABASE_CONFIG.URL,
      SUPABASE_CONFIG.PUBLISHABLE_KEY,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }
    );
    window.YverFlix = window.YverFlix || {};
    window.YverFlix.supabase = supabaseClient;
    console.log('[Supabase] Cliente inicializado →', SUPABASE_CONFIG.URL);
  } else {
    console.warn('[Supabase] CDN não carregou — persistência desabilitada.');
  }

  /**
   * Smoke test de conectividade — FASE 6.1 REQUISITO 4.
   *
   * Tenta um SELECT numa tabela inexistente (`_yverflix_ping`). Cenários:
   *
   *   ✓ status 404 + error.code === 'PGRST205' (PostgREST: tabela não
   *     encontrada) → CONEXÃO OK. CORS, headers de auth e o projeto estão
   *     todos válidos — só não tem tabela com esse nome (esperado).
   *
   *   ✗ TypeError "Failed to fetch" / network error → CORS bloqueado ou
   *     URL errada.
   *
   *   ✗ status 401/403 → publishable key inválida ou expirada.
   *
   *   ✗ status 5xx → projeto pausado/quebrado no Supabase.
   *
   * Loga TUDO no console pra Clayver verificar visualmente. Não bloqueia
   * o boot do catálogo (roda em IIFE async sem await no thread principal).
   */
  function smokeTestSupabase() {
    if (!supabaseClient) return;
    var t0 = performance.now();
    supabaseClient
      .from('_yverflix_ping')
      .select('*')
      .limit(1)
      .then(function (res) {
        var dt = (performance.now() - t0).toFixed(1);
        var ok = res.error && res.error.code === 'PGRST205';
        console.log(
          '[Supabase] smoke test (' + dt + 'ms):',
          ok ? '✓ CONEXÃO OK' : '⚠ verificar resposta',
          {
            data: res.data,
            error: res.error,
            status: res.status,
            statusText: res.statusText,
          }
        );
      })
      .catch(function (err) {
        console.error('[Supabase] smoke test FALHOU (rede/CORS):', err);
      });
  }

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
      var fetchOpts = { signal: controller.signal };
      if (options.method) fetchOpts.method = options.method;
      if (options.headers) fetchOpts.headers = options.headers;
      if (options.body != null) fetchOpts.body = options.body;
      var response = await fetch(url, fetchOpts);

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
   * Chamada centralizada ao proxy /api/tmdb.
   * O proxy (api/tmdb.js) recebe `endpoint` como query param e injeta
   * a API key server-side — nada de chave no client.
   *
   * @param {string} endpoint - ex: '/trending/all/week'
   * @param {Object} [params] - query params extras (page, query, etc.)
   * @param {AbortSignal} [signal]
   * @returns {Promise<Object>} JSON da TMDB
   */
  async function callTMDBProxy(endpoint, params, signal) {
    var url = new URL('/api/tmdb', window.location.origin);
    url.searchParams.set('endpoint', endpoint);
    if (params) {
      var keys = Object.keys(params);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (params[k] != null) url.searchParams.set(k, String(params[k]));
      }
    }
    var response = await fetchWithTimeout(url.toString(), { signal: signal });
    return response.json();
  }

  /**
   * [Fase 1+4] Busca os "Trending" da TMDB com paginação.
   *
   * @param {number} [page=1]
   * @param {AbortSignal} [signal]
   * @returns {Promise<PageResult>}
   */
  async function getTrending(page, signal) {
    var data = await callTMDBProxy('/trending/all/week', { page: page || 1 }, signal);
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
    var data = await callTMDBProxy('/search/multi', {
      query: query,
      include_adult: 'false',
      page: page || 1,
    }, signal);
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
    var data = await callTMDBProxy('/genre/movie/list', null, signal);
    return data.genres || [];
  }

  /**
   * [Fase 4] Filtra filmes por gênero via /discover/movie.
   *
   * @param {number} genreId
   * @param {number} [page=1]
   * @param {AbortSignal} [signal]
   * @returns {Promise<PageResult>}
   */
  async function getByGenre(genreId, page, signal) {
    var data = await callTMDBProxy('/discover/movie', {
      with_genres: genreId,
      include_adult: 'false',
      sort_by: 'popularity.desc',
      page: page || 1,
    }, signal);

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
   */
  async function getTvDetails(id, signal) {
    var data = await callTMDBProxy('/tv/' + id, null, signal);
    return {
      id: data.id,
      name: data.name || data.original_name || '',
      numberOfSeasons: data.number_of_seasons || 0,
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
   */
  async function getSeasonEpisodes(id, seasonNumber, signal) {
    var data = await callTMDBProxy(
      '/tv/' + id + '/season/' + seasonNumber, null, signal
    );
    return (data.episodes || []).map(function (e) {
      return {
        number: e.episode_number,
        name: e.name || ('Episódio ' + e.episode_number),
        overview: e.overview || '',
        runtime: e.runtime || 0,
        stillUrl: e.still_path
          ? CONFIG.TMDB_IMG_BASE + '/' + CONFIG.STILL_SIZE + e.still_path
          : null,
        airDate: e.air_date || '',
      };
    });
  }

  /*
   * FASE 6 — Detalhes completos para a tela de "imersivo".
   * Endpoint: /movie/{id} ou /tv/{id}.
   */
  async function getDetails(mediaType, id, signal) {
    var path = mediaType === 'movie' ? '/movie/' : '/tv/';
    var data = await callTMDBProxy(path + id, {
      append_to_response: mediaType === 'movie' ? 'release_dates' : 'content_ratings',
    }, signal);

    var isMovie = mediaType === 'movie';
    return {
      tmdbId: data.id,
      type: mediaType,
      title: isMovie ? data.title : data.name,
      originalTitle: isMovie ? data.original_title : data.original_name,
      overview: data.overview || '',
      tagline: data.tagline || '',
      backdropUrl: data.backdrop_path
        ? CONFIG.TMDB_IMG_BASE + '/' + CONFIG.BACKDROP_SIZE + data.backdrop_path
        : null,
      posterUrl: data.poster_path
        ? CONFIG.TMDB_IMG_BASE + '/' + CONFIG.POSTER_SIZE + data.poster_path
        : null,
      posterPath: data.poster_path || null,
      releaseDate: (isMovie ? data.release_date : data.first_air_date) || '',
      voteAverage: typeof data.vote_average === 'number' ? data.vote_average : 0,
      runtime: isMovie
        ? (data.runtime || 0)
        : ((data.episode_run_time && data.episode_run_time[0]) || 0),
      genres: (data.genres || []).map(function (g) { return g.name; }),
      status: data.status || '',
      numberOfSeasons: data.number_of_seasons || 0,
      numberOfEpisodes: data.number_of_episodes || 0,
      seasons: (data.seasons || []).filter(function (s) {
        return typeof s.season_number === 'number';
      }).map(function (s) {
        return {
          season_number: s.season_number,
          name: s.name || '',
          episode_count: s.episode_count || 0,
        };
      }),
      certification: extractCertification(data, isMovie),
    };
  }

  /*
   * Extrai a classificação etária priorizando BR > US > primeiro disponível.
   */
  function extractCertification(data, isMovie) {
    if (isMovie) {
      var rd = data.release_dates && data.release_dates.results;
      if (!rd || !rd.length) return '';
      var pick = rd.find(function (r) { return r.iso_3166_1 === 'BR'; })
        || rd.find(function (r) { return r.iso_3166_1 === 'US'; })
        || rd[0];
      var entries = (pick && pick.release_dates) || [];
      var found = entries.find(function (e) { return e.certification; });
      return found ? found.certification : '';
    }
    var cr = data.content_ratings && data.content_ratings.results;
    if (!cr || !cr.length) return '';
    var pickTv = cr.find(function (r) { return r.iso_3166_1 === 'BR'; })
      || cr.find(function (r) { return r.iso_3166_1 === 'US'; })
      || cr[0];
    return (pickTv && pickTv.rating) || '';
  }

  /*
   * FASE 6 — Créditos (elenco). Retorna no máx. CAST_LIMIT atores.
   */
  async function getCredits(mediaType, id, signal) {
    var path = mediaType === 'movie' ? '/movie/' : '/tv/';
    var data = await callTMDBProxy(path + id + '/credits', null, signal);
    return (data.cast || [])
      .slice(0, CONFIG.CAST_LIMIT)
      .map(function (p) {
        return {
          id: p.id,
          name: p.name || '',
          character: p.character || '',
          photoUrl: p.profile_path
            ? CONFIG.TMDB_IMG_BASE + '/' + CONFIG.PROFILE_SIZE + p.profile_path
            : null,
        };
      });
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
      posterPath: raw.poster_path || null,  // FASE 6.2 — para gravar no Supabase
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
    var img = fragment.querySelector('.card__poster');
    var title = fragment.querySelector('.card__title');
    var meta = fragment.querySelector('.card__meta');
    var rating = fragment.querySelector('.card__rating');

    /*
     * REQUISITO: guardar o TMDB id no próprio elemento HTML.
     * Também guardamos media_type — vai ser essencial na Fase 2 para
     * montar a URL correta do iframe (/filme/{id} para movie, /serie/{id} para tv).
     */
    article.dataset.id = String(item.tmdbId);
    article.dataset.mediaType = item.type;
    // FASE 6.2 — guardamos o poster_path original (não a URL) pra
    // gravar no Supabase quando o usuário favoritar. Salvar só o path
    // (não a URL inteira) deixa o size de imagem flexível em listagens
    // futuras (e.g. Minha Lista pode usar w185 em vez de w342).
    if (item.posterPath) article.dataset.posterPath = item.posterPath;
    article.setAttribute('aria-label', item.title);

    // textContent (não innerHTML) → seguro contra XSS.
    title.textContent = item.title;
    meta.textContent = formatMeta(item);

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
    // FASE 6.3 — itens vindos de Minha Lista (Supabase) podem não ter
    // releaseDate, pois a tabela favorites guarda só o essencial.
    // Nesse caso mostramos só "Filme"/"Série" sem o "• —" feio.
    var year = item.releaseDate ? item.releaseDate.slice(0, 4) : '';
    var kind = item.type === 'movie' ? 'Filme' : 'Série';
    return year ? (kind + ' • ' + year) : kind;
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
    if (err.name === 'TimeoutError') return 'Tempo limite excedido. Verifique sua conexão.';
    if (err.name === 'TypeError') return 'Falha de rede.';
    if (err.status === 401) return 'Chave de API inválida.';
    if (err.status === 404) return 'Recurso não encontrado.';
    if (err.status === 429) return 'Muitas requisições. Tente em alguns instantes.';
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
   *     - chamado no close() do ContentModal.
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
     * FASE 5 + 6 — cache de séries.
     * Shape:
     *   cache[tmdbId] = {
     *     detailsLoaded: bool,
     *     totalSeasons:  number,
     *     seasons:       [{ season_number, name, episode_count }],
     *     episodes:      { [seasonNumber]: [{ number, name, stillUrl, runtime, overview }] }
     *   }
     *
     * O cache vive no closure do IIFE — preservado entre aberturas do modal
     * (REQUISITO 4 da Fase 5: re-acessar T1 já carregada = ZERO fetch).
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

    /*
     * FASE 6 — Mount ganha a responsabilidade de CONSTRUIR seu próprio DOM
     * dentro do $container (em vez de esperar um markup pré-existente).
     * Isto desacopla SeriesEpisodes da estrutura do index.html — pode ser
     * inserido em qualquer lugar (atualmente DetailsView usa).
     *
     * @param {Object} item       { tmdbId, mediaType, title }
     * @param {Element} $container onde os elementos serão renderizados
     * @param {Function} onPlay   callback (season, episode) ao clicar ep
     */
    function mount(item, $container, onPlay, opts) {
      // Guarda contra mount duplicado: se já existe, destrói antes.
      destroy();

      opts = opts || {};

      // Constrói o DOM (header com select + loading + grid de cards).
      buildContainerDOM($container);

      var c = {
        tmdbId: item.tmdbId,
        controller: new AbortController(),
        $container: $container,
        $select: $container.querySelector('.episodes__select'),
        $loading: $container.querySelector('.episodes-section__loading'),
        $list: $container.querySelector('.episodes-grid'),
        $resumeBtn: null,
        onPlay: onPlay,
        // FASE 8 — resume é a temporada/ep que veio do "Continuar Assistindo".
        // Se setado, a UI auto-seleciona a temporada e (se autoplay) dispara
        // o player imediatamente após carregar.
        currentSeason: opts.resumeSeason || 1,
        currentEpisode: opts.resumeEpisode || null,
        resumeAutoplay: !!opts.autoplay && !!opts.resumeEpisode,
        resumeConsumed: false,
      };
      current = c;

      $container.hidden = false;

      // Listeners — todos com signal do AbortController p/ cleanup atômico.
      c.$select.addEventListener('change', onSeasonChange, { signal: c.controller.signal });
      c.$list.addEventListener('click', onEpisodeClick, { signal: c.controller.signal });
      c.$list.addEventListener('keydown', onEpisodeKeydown, { signal: c.controller.signal });

      // Carrega detalhes + temporada inicial em PARALELO (reduz TTI da lista).
      loadInitial(item.tmdbId);
    }

    async function loadInitial(tmdbId) {
      var c = current;
      if (!c || c.tmdbId !== tmdbId) return;

      // FASE 8 — temporada inicial pode ser != 1 quando vem do
      // "Continuar Assistindo" via opts.resumeSeason.
      var initialSeason = c.currentSeason || 1;

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

        // Cache hit na temporada inicial? Skip fetch.
        if (entry.episodes[initialSeason]) {
          episodesPromise = Promise.resolve(entry.episodes[initialSeason]);
        } else {
          episodesPromise = getSeasonEpisodes(tmdbId, initialSeason, c.controller.signal).then(function (eps) {
            entry.episodes[initialSeason] = eps;
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

        // FASE 8 — autoplay do "Continuar Assistindo": dispara onPlay com
        // o S/E salvo logo após a primeira lista carregar. resumeConsumed
        // garante que só dispara 1×, mesmo se o user trocar de temporada
        // depois e o cache já estiver quente.
        if (current.resumeAutoplay && !current.resumeConsumed) {
          current.resumeConsumed = true;
          activateEpisode(current.currentSeason, current.currentEpisode);
        }
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
      var li = event.target.closest('.ep-card');
      if (!li || !current.$list.contains(li)) return;
      activateEpisode(Number(li.dataset.season), Number(li.dataset.episode));
    }

    function onEpisodeKeydown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var li = event.target.closest('.ep-card');
      if (!li) return;
      event.preventDefault();
      activateEpisode(Number(li.dataset.season), Number(li.dataset.episode));
    }

    function activateEpisode(season, episode) {
      if (!current) return;
      current.currentSeason = season;
      current.currentEpisode = episode;

      // Marca o item ATIVO sem regerar a lista (zero re-render).
      var items = current.$list.querySelectorAll('.ep-card');
      Array.prototype.forEach.call(items, function (it) {
        var match = Number(it.dataset.season) === season && Number(it.dataset.episode) === episode;
        it.classList.toggle('ep-card--active', match);
        it.setAttribute('aria-selected', match ? 'true' : 'false');
      });

      // FASE 8 — resolve título do episódio do cache (pra registrar no histórico).
      var entry = cache[current.tmdbId];
      var epTitle = null;
      if (entry && entry.episodes && entry.episodes[season]) {
        for (var i = 0; i < entry.episodes[season].length; i++) {
          if (entry.episodes[season][i].number === episode) {
            epTitle = entry.episodes[season][i].name;
            break;
          }
        }
      }

      // Notifica o ContentModal (ele cria o iframe + entra na view player).
      if (typeof current.onPlay === 'function') current.onPlay(season, episode, epTitle);
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

    /*
     * FASE 6 — Render VISUAL com thumbnail, título, runtime e overview.
     * Substitui a lista textual da Fase 5 por cards horizontais.
     *
     * Decisões de performance:
     *   - DocumentFragment p/ 1 reflow só.
     *   - <img loading="lazy"> nativo: thumbs fora da viewport não baixam.
     *   - decoding="async" → não bloqueia o main thread.
     *   - .is-loaded (fade-in) controlado por listener `load` por imagem
     *     (registro pontual; remove sozinho com {once: true}).
     *   - contain: layout style (no CSS) isola reflow por card.
     */
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

      var fragment = document.createDocumentFragment();
      episodes.forEach(function (ep) {
        fragment.appendChild(buildEpisodeCard(ep, activeEpisode));
      });
      $list.appendChild(fragment);
      applyWatchedState();
      updateResumeButton();
    }

    /**
     * Percorre os cards de episódio renderizados e adiciona a classe
     * .is-watched naqueles cujo número <= getMaxWatchedEpisode().
     * Chamado após renderEpisodes() e por refreshWatched().
     */
    function applyWatchedState() {
      if (!current) return;
      var maxEp = HistoryService.getMaxWatchedEpisode(current.tmdbId, current.currentSeason);
      if (!maxEp) return;
      var cards = current.$list.querySelectorAll('.ep-card');
      for (var i = 0; i < cards.length; i++) {
        var epNum = parseInt(cards[i].dataset.episode, 10);
        if (!isNaN(epNum) && epNum <= maxEp) {
          cards[i].classList.add('is-watched');
        }
      }
    }

    /**
     * Re-aplica o estado de "assistido" nos cards já renderizados.
     * Chamado pelo ContentModal ao voltar do player pra details view,
     * garantindo reatividade sem re-renderizar toda a lista.
     */
    function refreshWatched() {
      if (!current || !current.$list) return;
      applyWatchedState();
      updateResumeButton();
    }

    /**
     * Calcula o próximo episódio com base no histórico e injetualiza
     * o botão "Continuar Assistindo" / "Começar a Assistir".
     *
     * Lógica:
     *   1. maxWatched = getMaxWatchedEpisode(tmdbId, seasonAtual)
     *   2. next = maxWatched + 1
     *   3. Se next existe na lista atual → mostra botão com "Ep X"
     *   4. Se next > total de eps da temporada → tenta temporada + 1
     *   5. Se não há próxima temporada ou ela não está em cache → esconde
     *
     * Performance: usa APENAS cache local (getCurrentList + cache[tmdbId]).
     * Zero fetches de API.
     */
    function updateResumeButton() {
      if (!current) return;

      var slot = current.$container.querySelector('.episodes-section__resume');
      if (!slot) return;

      // Limpa botão anterior.
      slot.replaceChildren();

      var tmdbId = current.tmdbId;
      var season = current.currentSeason;
      var maxWatched = HistoryService.getMaxWatchedEpisode(tmdbId, season);
      var nextEp = maxWatched + 1;

      // Verifica se nextEp existe na lista atual (cache quente).
      var list = getCurrentList();
      var epExists = list.some(function (ep) { return ep.number === nextEp; });

      var targetSeason = season;
      var targetEpisode = nextEp;
      var label;

      if (epExists) {
        // Próximo episódio na mesma temporada.
        label = maxWatched === 0
          ? 'Começar a Assistir'
          : 'Assistir ao Próximo: Ep ' + nextEp;
      } else {
        // NextEp não existe — pode ser que a temporada acabou.
        // Tenta a próxima temporada SE estiver em cache.
        var entry = cache[tmdbId];
        if (!entry) return;

        var nextSeasonNum = season + 1;
        var hasNextSeason = entry.seasons.some(function (s) {
          return s.season_number === nextSeasonNum;
        });

        if (!hasNextSeason) {
          // Série terminou ou não há próxima temporada.
          // Se o user já assistiu TODOS os eps da temporada atual,
          // esconde o botão. Se não assistiu nenhum, mostra "Começar".
          if (maxWatched === 0) {
            label = 'Começar a Assistir';
            targetEpisode = list.length ? list[0].number : 1;
          } else {
            return; // esconde o botão
          }
        } else {
          // Próxima temporada existe no catálogo.
          var nextSeasonEps = entry.episodes[nextSeasonNum];
          if (!nextSeasonEps || !nextSeasonEps.length) {
            // Temporada existe mas episódios não estão em cache.
            // Não fazemos fetch (performance). Esconde.
            return;
          }
          targetSeason = nextSeasonNum;
          targetEpisode = nextSeasonEps[0].number;
          label = 'Assistir S' + nextSeasonNum + 'E' + targetEpisode;
        }
      }

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--primary btn-resume-play';
      btn.innerHTML = '<span class="btn__icon" aria-hidden="true">▶</span>' +
        '<span>' + label + '</span>';
      btn.addEventListener('click', function () {
        if (current && typeof current.onPlay === 'function') {
          current.onPlay(targetSeason, targetEpisode, null);
        }
      });

      slot.appendChild(btn);
      current.$resumeBtn = btn;
    }

    function buildEpisodeCard(ep, activeEpisode) {
      var li = document.createElement('li');
      li.className = 'ep-card';
      li.setAttribute('role', 'option');
      li.tabIndex = 0;
      li.dataset.season = String(current.currentSeason);
      li.dataset.episode = String(ep.number);

      var isActive = activeEpisode && ep.number === activeEpisode;
      if (isActive) li.classList.add('ep-card--active');
      li.setAttribute('aria-selected', isActive ? 'true' : 'false');

      // ---- Thumb (16:9 com still_path do TMDB).
      var thumb = document.createElement('div');
      thumb.className = 'ep-card__thumb';

      if (ep.stillUrl) {
        var img = document.createElement('img');
        img.className = 'ep-card__thumb-img';
        img.src = ep.stillUrl;
        img.alt = '';                  // decorativo (título já está ao lado)
        img.loading = 'lazy';          // lazy native
        img.decoding = 'async';
        // Fade-in só após o load (perf: evita flash branco).
        img.addEventListener('load', function () {
          img.classList.add('is-loaded');
        }, { once: true });
        // Se a imagem falha, mantém o fundo escuro do thumb (graceful).
        img.addEventListener('error', function () {
          img.style.display = 'none';
        }, { once: true });
        thumb.appendChild(img);
      } else {
        var ph = document.createElement('div');
        ph.className = 'ep-card__thumb-placeholder';
        ph.textContent = '🎬';
        thumb.appendChild(ph);
      }

      // Número do episódio sobreposto.
      var n = ep.number;
      var num = document.createElement('span');
      num.className = 'ep-card__num';
      num.textContent = 'E' + (n < 10 ? '0' + n : n);
      thumb.appendChild(num);

      // Overlay de play (aparece no hover via CSS).
      var overlay = document.createElement('div');
      overlay.className = 'ep-card__play-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.textContent = '▶';
      thumb.appendChild(overlay);

      li.appendChild(thumb);

      // ---- Info à direita.
      var info = document.createElement('div');
      info.className = 'ep-card__info';

      var title = document.createElement('h4');
      title.className = 'ep-card__title';
      title.textContent = ep.name;
      info.appendChild(title);

      // Meta: runtime + air_date (só aparece se tem dados).
      if (ep.runtime || ep.airDate) {
        var meta = document.createElement('div');
        meta.className = 'ep-card__meta';
        var bits = [];
        if (ep.runtime) bits.push(ep.runtime + ' min');
        if (ep.airDate) bits.push(formatYear(ep.airDate));
        meta.textContent = bits.join(' · ');
        info.appendChild(meta);
      }

      if (ep.overview) {
        var ov = document.createElement('p');
        ov.className = 'ep-card__overview';
        ov.textContent = ep.overview;
        info.appendChild(ov);
      }

      li.appendChild(info);

      return li;
    }

    function renderListError() {
      current.$list.replaceChildren();
      var li = document.createElement('li');
      li.className = 'episodes__empty';
      li.textContent = 'Erro ao carregar episódios. Tente outra temporada.';
      current.$list.appendChild(li);
    }

    /*
     * FASE 6 — Constrói o DOM interno do painel de episódios.
     * Antes (Fase 5) o markup vinha de index.html; agora é dinâmico p/
     * podermos reusar SeriesEpisodes em qualquer container.
     */
    function buildContainerDOM($container) {
      $container.replaceChildren();

      // Header com título + select de temporadas.
      var head = document.createElement('header');
      head.className = 'episodes-section__head';

      var title = document.createElement('h3');
      title.className = 'section-title';
      title.textContent = 'Episódios';
      head.appendChild(title);

      var selectWrap = document.createElement('div');
      selectWrap.className = 'episodes__select-wrap';

      var select = document.createElement('select');
      select.className = 'episodes__select';
      select.setAttribute('aria-label', 'Selecionar temporada');
      selectWrap.appendChild(select);

      var chev = document.createElement('span');
      chev.className = 'episodes__chevron';
      chev.setAttribute('aria-hidden', 'true');
      chev.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"' +
        ' fill="none" stroke="currentColor" stroke-width="2"' +
        ' stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>';
      selectWrap.appendChild(chev);

      head.appendChild(selectWrap);
      $container.appendChild(head);

      // Slot para o botão "Continuar Assistindo" (injetado por updateResumeButton).
      var resumeSlot = document.createElement('div');
      resumeSlot.className = 'episodes-section__resume';
      $container.appendChild(resumeSlot);

      // Loading inline (visível apenas durante fetch da temporada).
      var loading = document.createElement('div');
      loading.className = 'episodes-section__loading';
      loading.setAttribute('role', 'status');
      loading.setAttribute('aria-live', 'polite');
      loading.hidden = true;
      var spinner = document.createElement('span');
      spinner.className = 'spinner spinner--sm';
      spinner.setAttribute('aria-hidden', 'true');
      var lbl = document.createElement('span');
      lbl.textContent = 'Carregando episódios…';
      loading.appendChild(spinner);
      loading.appendChild(lbl);
      $container.appendChild(loading);

      // Grid de cards.
      var list = document.createElement('ul');
      list.className = 'episodes-grid';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'Episódios');
      $container.appendChild(list);
    }

    function formatYear(dateStr) {
      var m = /^(\d{4})/.exec(dateStr || '');
      return m ? m[1] : '';
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
      // FASE 6 — limpa o DOM construído (DetailsView remove o container do
      // details quando re-mounta, mas garantimos cleanup mesmo em outros
      // pontos de saída).
      if (current.$container) {
        current.$container.replaceChildren();
        current.$container.hidden = true;
      }
      current = null;
    }

    /**
     * Resolve o próximo episódio dado (tmdbId, season, episode).
     * Usa o cache existente; se a temporada seguinte não está em cache,
     * faz fetch (getSeasonEpisodes é compartilhado no escopo pai).
     *
     * @returns {Promise<{season:number, episode:number, title:string}|null>}
     */
    async function resolveNextEpisode(tmdbId, season, episode) {
      var entry = cache[tmdbId];
      if (!entry) return null;

      var eps = entry.episodes[season];
      if (!eps) {
        try {
          eps = await getSeasonEpisodes(tmdbId, season);
          entry.episodes[season] = eps;
        } catch (e) { return null; }
      }

      var idx = -1;
      for (var i = 0; i < eps.length; i++) {
        if (eps[i].number === episode) { idx = i; break; }
      }

      if (idx >= 0 && idx < eps.length - 1) {
        var next = eps[idx + 1];
        return { season: season, episode: next.number, title: next.name };
      }

      var nextSeasonNum = season + 1;
      var hasSeason = entry.seasons.some(function (s) {
        return s.season_number === nextSeasonNum;
      });
      if (!hasSeason) return null;

      try {
        var nextEps = await getSeasonEpisodes(tmdbId, nextSeasonNum);
        entry.episodes[nextSeasonNum] = nextEps;
        if (!nextEps.length) return null;
        return { season: nextSeasonNum, episode: nextEps[0].number, title: nextEps[0].name };
      } catch (e) { return null; }
    }

    /**
     * Retorna a lista de episódios da temporada atualmente carregada em cache.
     *
     * @returns {Array<{number:number, name:string, ...}>}
     */
    function getCurrentList() {
      if (!current) return [];
      var entry = cache[current.tmdbId];
      if (!entry || !entry.episodes[current.currentSeason]) return [];
      return entry.episodes[current.currentSeason];
    }

    return { mount: mount, destroy: destroy, resolveNextEpisode: resolveNextEpisode, getCurrentList: getCurrentList, refreshWatched: refreshWatched };
  })();

  /* ====================================================================
     FASE 6 — DetailsView (página de detalhes imersivos dentro do modal)

     Responsabilidades:
       - Buscar /tv/{id} ou /movie/{id} (`getDetails`) + /credits em paralelo.
       - Renderizar Hero (backdrop + título + meta + sinopse).
       - Renderizar carrossel de elenco (lazy load nas fotos).
       - Para tv: montar SeriesEpisodes; para movie: botão "Assistir agora".
       - Notificar via `onPlay(season|null, episode|null)` para o
         ContentModal abrir o player (se episode null → é um filme).

     Cache:
       - detailsCache + creditsCache vivem no closure.
       - Reabrir o mesmo card é instantâneo (zero fetch).

     Decisões de performance:
       1) Promise.all paraleliza as 2 requests de mount inicial.
       2) Backdrop é eager (acima da dobra); cast e thumbs são lazy.
       3) Container do details é completamente limpo entre mounts (sem
          leak de listeners — usamos AbortController).
       4) Re-render quando o cache hit é hidratado SÍNCRONAMENTE.
     ==================================================================== */
  var DetailsView = (function () {
    'use strict';

    var detailsCache = Object.create(null);  // tmdbId -> details
    var creditsCache = Object.create(null);  // tmdbId -> credits[]
    var current = null;

    /*
     * @param {Object} item                { tmdbId, mediaType, title, ... }
     * @param {Element} $root              container (#details-content)
     * @param {Element} $loadingEl         overlay de loading do modal
     * @param {Function} onPlay            callback (season, episode) — null/null para filme
     */
    function mount(item, $root, $loadingEl, onPlay, opts) {
      destroy();

      opts = opts || {};

      current = {
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        controller: new AbortController(),
        $root: $root,
        $loading: $loadingEl,
        $episodesContainer: null,
        onPlay: onPlay,
        // FASE 8 — opts encaminhados pro SeriesEpisodes (deep linking).
        resumeOpts: {
          resumeSeason: opts.resumeSeason,
          resumeEpisode: opts.resumeEpisode,
          autoplay: !!opts.autoplay,
        },
      };

      // Cache hit total → render síncrono.
      var cachedDetails = detailsCache[item.tmdbId];
      var cachedCredits = creditsCache[item.tmdbId];

      if (cachedDetails && cachedCredits) {
        renderAll(cachedDetails, cachedCredits);
        return;
      }

      // Caso contrário: mostra loading e dispara fetch paralelo.
      showLoading();
      loadAll(item, cachedDetails, cachedCredits);
    }

    async function loadAll(item, cachedDetails, cachedCredits) {
      var c = current;
      if (!c) return;
      var sig = c.controller.signal;

      try {
        // Promise.all: 2 requests em PARALELO — TTI metade do sequencial.
        var detailsPromise = cachedDetails
          ? Promise.resolve(cachedDetails)
          : getDetails(item.mediaType, item.tmdbId, sig).then(function (d) {
            detailsCache[item.tmdbId] = d;
            return d;
          });

        var creditsPromise = cachedCredits
          ? Promise.resolve(cachedCredits)
          : getCredits(item.mediaType, item.tmdbId, sig).then(function (c2) {
            creditsCache[item.tmdbId] = c2;
            return c2;
          });

        var results = await Promise.all([detailsPromise, creditsPromise]);

        // Race guard: usuário pode ter trocado de card antes da resposta.
        if (!current || current.tmdbId !== item.tmdbId) return;

        renderAll(results[0], results[1]);
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.error('[Streaming MVP] Falha ao carregar detalhes:', err);
        renderError();
      } finally {
        hideLoading();
      }
    }

    /* ---- render principal ---- */

    function renderAll(details, credits) {
      var c = current;
      if (!c) return;
      hideLoading();

      // Limpa qualquer render anterior (cache hit em re-mount).
      c.$root.replaceChildren();

      c.$root.appendChild(buildHero(details));
      if (credits && credits.length) {
        c.$root.appendChild(buildCastSection(credits));
      }

      // Ações específicas por tipo de mídia (REQUISITO 5 — gatilho de play).
      if (details.type === 'tv') {
        // Painel de episódios (com SeriesEpisodes, módulo da Fase 5).
        var episodesSection = document.createElement('section');
        episodesSection.className = 'episodes-section details-section';
        c.$root.appendChild(episodesSection);
        c.$episodesContainer = episodesSection;

        SeriesEpisodes.mount(
          { tmdbId: details.tmdbId, mediaType: 'tv', title: details.title },
          episodesSection,
          function (season, episode, episodeTitle) {
            if (typeof c.onPlay === 'function') c.onPlay(season, episode, episodeTitle);
          },
          c.resumeOpts                  // FASE 8 — deep linking
        );
      }
      // Para movie, o "Assistir agora" já está no hero (botão).
    }

    /* ---- hero ---- */

    function buildHero(d) {
      var hero = document.createElement('section');
      hero.className = 'hero';

      // Backdrop como CSS variable inline (CSS aplica como background-image).
      // POR QUÊ inline em vez de attribute: permite o gradiente CSS continuar
      // controlado por classe e evita que reflows futuros refaçam parsing.
      if (d.backdropUrl) {
        hero.style.setProperty('--hero-bg', 'url(' + d.backdropUrl + ')');
      }

      var inner = document.createElement('div');
      inner.className = 'hero__inner';

      var h2 = document.createElement('h2');
      h2.className = 'hero__title';
      h2.textContent = d.title;
      inner.appendChild(h2);

      if (d.tagline) {
        var tag = document.createElement('p');
        tag.className = 'hero__tagline';
        tag.textContent = d.tagline;
        inner.appendChild(tag);
      }

      // Chips de meta: rating, ano, classificação, runtime/temporadas, gêneros.
      var meta = document.createElement('div');
      meta.className = 'hero__meta';

      if (d.voteAverage) {
        var rating = document.createElement('span');
        rating.className = 'meta-chip meta-chip--rating';
        rating.textContent = '★ ' + d.voteAverage.toFixed(1);
        meta.appendChild(rating);
      }

      var year = formatYear(d.releaseDate);
      if (year) meta.appendChild(makeChip(year));

      if (d.certification) {
        var cert = document.createElement('span');
        cert.className = 'meta-chip meta-chip--cert';
        cert.textContent = d.certification;
        meta.appendChild(cert);
      }

      if (d.type === 'movie' && d.runtime) {
        meta.appendChild(makeChip(d.runtime + ' min'));
      } else if (d.type === 'tv' && d.numberOfSeasons) {
        meta.appendChild(makeChip(
          d.numberOfSeasons + (d.numberOfSeasons === 1 ? ' temporada' : ' temporadas')
        ));
      }

      // Primeiros 3 gêneros (não polui o hero).
      (d.genres || []).slice(0, 3).forEach(function (g) {
        meta.appendChild(makeChip(g));
      });

      if (meta.children.length) inner.appendChild(meta);

      // Sinopse completa.
      if (d.overview) {
        var ov = document.createElement('p');
        ov.className = 'hero__overview';
        ov.textContent = d.overview;
        inner.appendChild(ov);
      }

      // Ações: para movie → "Assistir Agora" no hero. Para tv → user clica
      // num episódio mais abaixo (decisão de UX: cada ep é o trigger).
      if (d.type === 'movie') {
        var actions = document.createElement('div');
        actions.className = 'hero__actions';

        var watch = document.createElement('button');
        watch.type = 'button';
        watch.className = 'btn btn--primary';
        watch.innerHTML = '<span class="btn__icon" aria-hidden="true">▶</span>' +
          '<span>Assistir agora</span>';
        watch.addEventListener('click', function () {
          // null/null → ContentModal sabe que é movie.
          if (current && typeof current.onPlay === 'function') current.onPlay(null, null);
        });
        actions.appendChild(watch);
        inner.appendChild(actions);
      }

      hero.appendChild(inner);
      return hero;
    }

    function makeChip(text) {
      var chip = document.createElement('span');
      chip.className = 'meta-chip';
      chip.textContent = text;
      return chip;
    }

    /* ---- cast ---- */

    function buildCastSection(credits) {
      var section = document.createElement('section');
      section.className = 'details-section';

      var title = document.createElement('h3');
      title.className = 'section-title';
      title.textContent = 'Elenco';
      section.appendChild(title);

      var carousel = document.createElement('ul');
      carousel.className = 'cast-carousel';
      carousel.setAttribute('role', 'list');

      // DocumentFragment p/ 1 reflow só.
      var fragment = document.createDocumentFragment();
      credits.forEach(function (p) {
        fragment.appendChild(buildCastItem(p));
      });
      carousel.appendChild(fragment);
      section.appendChild(carousel);

      return section;
    }

    function buildCastItem(p) {
      var li = document.createElement('li');
      li.className = 'cast-item';

      var photoWrap = document.createElement('div');
      photoWrap.className = 'cast-photo-wrap';

      if (p.photoUrl) {
        var img = document.createElement('img');
        img.className = 'cast-photo';
        img.src = p.photoUrl;
        img.alt = p.name;
        // Lazy + async decoding — REQUISITO Fase 6: lazy nas fotos do elenco.
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('load', function () {
          img.classList.add('is-loaded');
        }, { once: true });
        img.addEventListener('error', function () {
          // Fallback: substitui por placeholder.
          img.replaceWith(buildCastPlaceholder(p.name));
        }, { once: true });
        photoWrap.appendChild(img);
      } else {
        photoWrap.appendChild(buildCastPlaceholder(p.name));
      }

      li.appendChild(photoWrap);

      var name = document.createElement('p');
      name.className = 'cast-name';
      name.textContent = p.name;
      li.appendChild(name);

      if (p.character) {
        var role = document.createElement('p');
        role.className = 'cast-role';
        role.textContent = p.character;
        li.appendChild(role);
      }

      return li;
    }

    function buildCastPlaceholder(name) {
      var ph = document.createElement('div');
      ph.className = 'cast-photo--placeholder';
      ph.setAttribute('aria-hidden', 'true');
      // Iniciais do ator (até 2 letras).
      var initials = (name || '?').trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(function (w) { return (w[0] || '').toUpperCase(); })
        .join('');
      ph.textContent = initials || '?';
      return ph;
    }

    /* ---- estados ---- */

    function showLoading() {
      if (current && current.$loading) current.$loading.hidden = false;
    }

    function hideLoading() {
      if (current && current.$loading) current.$loading.hidden = true;
    }

    function renderError() {
      if (!current) return;
      hideLoading();
      var c = current.$root;
      c.replaceChildren();
      var box = document.createElement('div');
      box.className = 'modal__loading';
      box.style.position = 'static';
      box.innerHTML = '<p>Não foi possível carregar os detalhes. Tente novamente.</p>';
      c.appendChild(box);
    }

    function destroy() {
      if (!current) return;
      try { current.controller.abort(); } catch (e) { /* noop */ }
      // Garante cleanup do SeriesEpisodes (caso seja tv).
      try { SeriesEpisodes.destroy(); } catch (e) { /* noop */ }
      if (current.$root) current.$root.replaceChildren();
      hideLoading();
      current = null;
    }

    function formatYear(dateStr) {
      var m = /^(\d{4})/.exec(dateStr || '');
      return m ? m[1] : '';
    }

    return {
      mount: mount,
      destroy: destroy,
    };
  })();

  /* ----------------------- 4.5 Favoritos (FASE 6.2) --------------------- */

  /**
   * FASE 6.2 — Persistência de Favoritos via Supabase.
   *
   * Módulo IIFE encapsulado. Único contrato exposto:
   *   - attach(item)  → liga o botão de coração no header do modal
   *                     ao item atual e carrega o status do banco.
   *   - detach()      → desliga, invalida requests pendentes e reseta visual.
   *
   * RACE CONDITIONS — como tratamos as promessas pra evitar "out-of-sync":
   *
   *   Cenário A: usuário clica MUITO RÁPIDO no coração (insert→delete→insert→...).
   *
   *     1) Cada chamada (loadStatus / toggle) gera um `myReqId` monotônico
   *        a partir de um contador `latestReqId` no closure.
   *     2) O botão fica em `disabled` (CSS `cursor: progress`) enquanto a
   *        request voa — descarte de cliques no nível UI.
   *     3) Antes de aplicar resposta no DOM, comparamos `myReqId !==
   *        latestReqId` e descartamos respostas obsoletas. Padrão
   *        "last-write-wins" — nunca deixa a UI refletir uma resposta
   *        velha que chegou DEPOIS de uma mais nova. Útil em redes ruins
   *        onde insert pode demorar 800ms e delete subsequente 200ms.
   *     4) Optimistic UI: o ícone muda de estado IMEDIATAMENTE no clique,
   *        ANTES da resposta. Se vier erro, revertemos. Sensação de
   *        instantaneidade sem mentir sobre o estado real.
   *
   *   Cenário B: usuário fecha o modal antes da request voltar.
   *
   *     - `detach()` incrementa `latestReqId` → qualquer .then() pendente
   *       cai no early-return. Não tentamos atualizar DOM já desmontado.
   *
   *   Cenário C: usuário troca de modal (item A → item B) antes da
   *             primeira request de A voltar.
   *
   *     - `attach(B)` chama `detach()` (que invalida o reqId de A) antes
   *       de iniciar o fetch de B. Resposta de A nunca pinta o estado de B.
   *
   *   Cenário D: insert duplicado por race (cliquei 2x rapidíssimo antes
   *             do disable pegar).
   *
   *     - O UNIQUE (user_id, tmdb_id, media_type) no Postgres é o último
   *       guardião. Se algo passar, vira `error.code === '23505'` e
   *       fazemos rollback visual — o banco continua consistente.
   *
   * Performance:
   *   - loadStatus roda EM PARALELO ao DetailsView.mount() — modal abre
   *     imediatamente, coração entra em "carregando" e atualiza assincronamente.
   *   - .maybeSingle() em vez de .single() — não levanta erro quando não
   *     existe linha (é o caso comum: item não favoritado).
   *   - Cacheia o `id` (PK) ao carregar status → DELETE futuro filtra
   *     direto pelo id (faster do que pelo composto).
   */
  /* ----------------------- 4.4.0 Session helper (FASE 7.1) -------------- */

  /**
   * FASE 7.2 — Sessão atual + identificação do usuário "ativo" para
   * persistência (tabela `favorites`, `watch_history`).
   *
   * Helper centralizado:
   *   - getCurrentUserId() devolve o session.user.id REAL quando logado,
   *     ou null quando deslogado (sem fallback anônimo).
   *   - isLoggedIn() é o guard usado por toggle/touch pra interceptar
   *     usuários anônimos e direcionar ao modal de login.
   *
   * `currentSession` é populada pelo handler de `onAuthStateChange`. Antes
   * dele rodar (boot inicial), permanece null.
   */
  var currentSession = null;

  function getCurrentUserId() {
    if (currentSession && currentSession.user && currentSession.user.id) {
      return currentSession.user.id;
    }
    return null;
  }

  function isLoggedIn() {
    return !!(currentSession && currentSession.user);
  }

  var Favorites = (function () {
    var $btn = document.getElementById('modal-fav');

    /**
     * FASE 6.3 — Evento custom que avisa o resto do app que um favorito
     * foi adicionado/removido. Só disparamos APÓS o servidor confirmar
     * (não no optimistic UI) — assim, se a request falhar e o coração
     * reverter, a Home não fica com fantasmas.
     *
     * detail: { action: 'added'|'removed', item: {tmdbId,mediaType,title,posterPath,id?} }
     *
     * Decoupling: Favorites NÃO conhece MyList. Qualquer módulo (badge
     * "12 favoritos", contador no header, etc) pode escutar o mesmo evento.
     */
    function emitChange(action, item, rowId) {
      var detail = {
        action: action,
        item: {
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
          title: item.title || null,
          posterPath: item.posterPath || null,
          id: rowId || null,
        },
      };
      window.dispatchEvent(new CustomEvent('yverflix:favorites-changed', { detail: detail }));
    }

    /** @type {object|null} Cliente Supabase (null se CDN não carregou) */
    function getClient() {
      return (window.YverFlix && window.YverFlix.supabase) || null;
    }

    /** Contador monotônico — invalida promessas antigas. */
    var latestReqId = 0;

    /** Item atualmente atrelado ao botão. */
    var currentItem = null;

    /** PK do row de favorito (cacheada no loadStatus pra delete rápido). */
    var currentRowId = null;

    /** Listener de click — guardado pra remover em detach. */
    var clickHandler = null;

    function attach(item) {
      // Sempre detach antes — invalida qualquer request anterior + remove
      // listener antigo. Idempotente (chamar 2x não duplica handler).
      detach();

      var supa = getClient();
      if (!supa) {
        // Degradação graciosa: sem Supabase, esconde o botão. Modal continua
        // funcionando normalmente.
        $btn.hidden = true;
        return;
      }

      currentItem = item;
      currentRowId = null;

      // Estado inicial: botão visível, em loading, sem indicar fav (até saber).
      $btn.hidden = false;
      setActive(false);
      setLoading(true);

      // Liga listener ANTES de saber o status — garante que se o usuário
      // clicar muito rápido (raro), o handler ja existe. O handler em si
      // bate em $btn.disabled === true e ignora o clique.
      clickHandler = onClickToggle;
      $btn.addEventListener('click', clickHandler);

      // Dispara verificação de status. NÃO bloqueia — modal já está aberto
      // visualmente, só o coração permanece em loading até a resposta.
      var myReqId = ++latestReqId;
      supa
        .from('favorites')
        .select('id')
        .eq('user_id', getCurrentUserId())
        .eq('tmdb_id', item.tmdbId)
        .eq('media_type', item.mediaType)
        .maybeSingle()
        .then(function (res) {
          if (myReqId !== latestReqId) return;     // resposta obsoleta
          if (res.error) {
            // Erro de leitura → desliga botão (não dá pra prometer toggle).
            console.warn('[Favorites] loadStatus erro:', res.error);
            setLoading(false);
            $btn.disabled = true;
            return;
          }
          currentRowId = res.data ? res.data.id : null;
          setActive(!!res.data);
          setLoading(false);
        })
        .catch(function (err) {
          if (myReqId !== latestReqId) return;
          console.warn('[Favorites] loadStatus catch:', err);
          setLoading(false);
          $btn.disabled = true;
        });
    }

    function detach() {
      // Invalida QUALQUER promessa pendente (loadStatus ou toggle).
      // Resposta tardia bate em `myReqId !== latestReqId` e dá early-return.
      latestReqId++;

      if (clickHandler) {
        $btn.removeEventListener('click', clickHandler);
        clickHandler = null;
      }
      currentItem = null;
      currentRowId = null;
      $btn.hidden = true;
      $btn.disabled = false;        // reset pro próximo attach
      setActive(false);
      setLoading(false);
      $btn.classList.remove('modal__fav--just-toggled');
    }

    function onClickToggle() {
      // O `disabled` do <button> já bloqueia clicks no nível do browser,
      // mas reforço aqui — defesa em profundidade.
      if ($btn.disabled || !currentItem) return;
      toggle();
    }

    function toggle() {
      var supa = getClient();
      if (!supa || !currentItem) return;

      // FASE 7.2 — Login gate: anônimo não pode favoritar.
      if (!isLoggedIn()) {
        Auth.open();
        return;
      }

      var item = currentItem;
      var wasActive = $btn.classList.contains('modal__fav--active');
      var willBeActive = !wasActive;

      // Optimistic UI: muda visual ANTES da resposta. Animação de pulse pra
      // confirmar feedback tátil. Se o servidor falhar, revertemos abaixo.
      setActive(willBeActive);
      setLoading(true);
      pulse();

      var myReqId = ++latestReqId;
      var op = wasActive ? doDelete(item) : doInsert(item);

      op
        .then(function (res) {
          if (myReqId !== latestReqId) return;    // resposta obsoleta
          if (res.error) {
            // Em caso de UNIQUE violation (23505) o estado real É `active`,
            // então o optimistic UI já está correto — só logamos. Pra
            // outros erros, revertemos.
            var isUniqueViolation = res.error.code === '23505';
            console[isUniqueViolation ? 'warn' : 'error'](
              '[Favorites] toggle erro:', res.error
            );
            if (!isUniqueViolation) setActive(wasActive);
          } else {
            // Sucesso: atualiza cache do PK.
            if (willBeActive && res.data && res.data[0]) {
              currentRowId = res.data[0].id;
            } else if (!willBeActive) {
              currentRowId = null;
            }
            // FASE 6.3 — dispara evento APÓS o server confirmar.
            // MyList (e quem mais escutar) faz patch incremental no DOM.
            // Em UNIQUE violation NÃO emitimos: o item já estava lá,
            // ninguém precisa reagir.
            emitChange(
              willBeActive ? 'added' : 'removed',
              item,
              willBeActive ? currentRowId : null
            );
          }
          setLoading(false);
        })
        .catch(function (err) {
          if (myReqId !== latestReqId) return;
          console.error('[Favorites] toggle catch:', err);
          setActive(wasActive);          // rollback visual
          setLoading(false);
        });
    }

    function doInsert(item) {
      return getClient()
        .from('favorites')
        .insert({
          user_id: getCurrentUserId(),
          tmdb_id: item.tmdbId,
          media_type: item.mediaType,
          title: item.title || null,
          poster_path: item.posterPath || null,
        })
        .select();      // retorna a linha inserida (com id)
    }

    function doDelete(item) {
      var q = getClient().from('favorites').delete();
      // Se temos o PK cacheado, filtra direto por id (mais rápido).
      // Senão, fallback pelo composto (user_id + tmdb_id + media_type).
      if (currentRowId != null) {
        return q.eq('id', currentRowId);
      }
      return q
        .eq('user_id', getCurrentUserId())
        .eq('tmdb_id', item.tmdbId)
        .eq('media_type', item.mediaType);
    }

    function setActive(active) {
      $btn.classList.toggle('modal__fav--active', !!active);
      $btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      $btn.setAttribute(
        'aria-label',
        active ? 'Remover dos favoritos' : 'Adicionar aos favoritos'
      );
      var label = $btn.querySelector('.modal__fav-label');
      if (label) label.textContent = active ? 'Remover dos favoritos' : 'Favoritar';
    }

    function setLoading(loading) {
      $btn.disabled = !!loading;
    }

    function pulse() {
      // Trigger CSS animation: remove + force reflow + add.
      $btn.classList.remove('modal__fav--just-toggled');
      void $btn.offsetWidth;
      $btn.classList.add('modal__fav--just-toggled');
      setTimeout(function () {
        $btn.classList.remove('modal__fav--just-toggled');
      }, 400);
    }

    /**
     * FASE 6.3 — Lista TODOS os favoritos do usuário, ordenados pelo
     * mais recente. Usado pelo MyList no boot.
     *
     * @returns {Promise<Array<{id,user_id,tmdb_id,media_type,title,poster_path,added_at}>>}
     */
    function list() {
      var supa = getClient();
      if (!supa) return Promise.resolve([]);
      // Ordeno por `id` (BIGSERIAL) DESC — id é monotonicamente
      // crescente, então é uma boa proxy de "mais recente primeiro"
      // mesmo se o schema do projeto não tiver a coluna `added_at`
      // (ex.: tabela criada manualmente antes do migration). Robusto.
      return supa
        .from('favorites')
        .select('id, user_id, tmdb_id, media_type, title, poster_path')
        .eq('user_id', getCurrentUserId())
        .order('id', { ascending: false })
        .then(function (res) {
          if (res.error) {
            console.warn('[Favorites] list erro:', res.error);
            return [];
          }
          return res.data || [];
        });
    }

    function getUserId() { return getCurrentUserId(); }

    return {
      attach: attach,
      detach: detach,
      list: list,
      getUserId: getUserId,
    };
  })();

  /* ----------------------- 4.6 Minha Lista (FASE 6.3) ------------------- */

  /**
   * FASE 6.3 — Render da "Minha Lista" na home + sincronização real-time.
   *
   * Por que reativo via CustomEvent ('yverflix:favorites-changed'):
   *   1. Decoupling — Favorites não conhece MyList. Qualquer módulo
   *      futuro (contador, page dedicada de favoritos, badge no header)
   *      pode escutar o MESMO evento sem que Favorites mude.
   *   2. Sem dependência externa — `window.dispatchEvent` é DOM nativo,
   *      zero overhead vs pub/sub manual.
   *   3. Sem polling — só reage quando algo muda de verdade.
   *
   * Por que NÃO usar Supabase Realtime (websocket):
   *   - É single-user (sem multi-device sync por enquanto). O canal ws
   *     custaria banda + handshake sem trazer nada de útil.
   *   - Quando entrar auth + multi-device na Fase 7+, plugar Realtime
   *     é trivial: o handler do canal só precisa disparar o MESMO evento.
   *
   * Por que patch incremental (vs. re-fetch + re-render):
   *   - O evento já carrega o item afetado (insert/delete) — não preciso
   *     bater no banco de novo.
   *   - DOM mutation O(1): `insertBefore` (added) ou `element.remove()`
   *     (removed). O grid principal e o resto do site NÃO são tocados.
   *   - Mantenho um Map<key, element> em closure pra encontrar o card
   *     a remover em O(1) sem `querySelector`.
   *   - Zero flicker, zero layout thrash, zero refetch.
   */
  var MyList = (function () {
    var $section = document.getElementById('my-list-section');
    var $list = document.getElementById('my-list');

    /**
     * Index dos cards montados, chave: "<media_type>:<tmdb_id>".
     * Mantém referência direta ao DOM element pra remover sem querySelector.
     * @type {Object<string, HTMLElement>}
     */
    var byKey = Object.create(null);

    /**
     * FASE 7.1 — Mesmo padrão do `latestReqId` no Favorites: contador
     * monotônico que invalida resultados de fetches obsoletos.
     *
     * Cenário: F5 com sessão persistida → init() pode tentar fetch antes
     * do Supabase resolver a sessão (currentSession ainda null). Logo após,
     * INITIAL_SESSION chega → reload() limpa DOM e dispara fetch do
     * user real. Sem versionamento, o `.then()` lento do init() chega
     * DEPOIS e injeta favoritos do user errado mascarando os corretos.
     */
    var loadGen = 0;

    function key(mediaType, tmdbId) {
      return mediaType + ':' + tmdbId;
    }

    /**
     * Converte uma row do Supabase no shape de MediaItem que createCard
     * consome. Ano/rating ficam vazios — formatMeta da Fase 6.3 mostra
     * só "Filme"/"Série" quando releaseDate é falsy.
     */
    function rowToItem(row) {
      return {
        tmdbId: row.tmdb_id,
        type: row.media_type,
        title: row.title || 'Sem título',
        posterPath: row.poster_path || null,
        posterUrl: row.poster_path
          ? CONFIG.TMDB_IMG_BASE + '/' + CONFIG.POSTER_SIZE + row.poster_path
          : null,
        voteAverage: 0,         // não exibido (createCard checa > 0)
        releaseDate: '',        // formatMeta omite quando vazio
      };
    }

    /**
     * Cria o elemento do card e registra suas imagens lazy no observer
     * compartilhado. Reusa createCard() — mesma estética do grid.
     */
    function buildCardElement(item) {
      var fragment = createCard(item);
      var article = fragment.querySelector('.card');
      // appendChild move os children do fragment pro novo parent —
      // mas o ref pro article continua válido.
      var lazy = fragment.querySelectorAll('img[data-src]');
      // Wrapper retorna o fragment pra quem inserir, mas também
      // exponho o article pra indexar. Vou retornar { article, fragment, lazy }.
      return { article: article, fragment: fragment, lazyImgs: lazy };
    }

    function show() { $section.hidden = false; }
    function hide() { $section.hidden = true; }

    /**
     * Boot: registra listener de eventos UMA vez.
     * O fetch inicial é disparado por onAuthStateChange (INITIAL_SESSION /
     * SIGNED_IN) pra garantir que getCurrentUserId() já tem o userId real.
     */
    function init() {
      window.addEventListener('yverflix:favorites-changed', onChanged);
    }

    function onChanged(e) {
      var d = e && e.detail;
      if (!d || !d.item) return;
      if (d.action === 'added') addOne(d.item);
      else if (d.action === 'removed') removeOne(d.item);
    }

    /**
     * Patch O(1): insere o card novo no INÍCIO do trilho (favorito
     * mais recente fica primeiro — igual ao .order('added_at', desc)
     * do fetch inicial). Sem refetch.
     */
    function addOne(item) {
      var k = key(item.mediaType, item.tmdbId);
      if (byKey[k]) return;            // defesa contra duplo-add (UNIQUE no banco já cobre)

      var built = buildCardElement(rowToItem({
        tmdb_id: item.tmdbId,
        media_type: item.mediaType,
        title: item.title,
        poster_path: item.posterPath,
      }));
      byKey[k] = built.article;
      // prepend no trilho (mais recente primeiro)
      $list.insertBefore(built.fragment, $list.firstChild);
      for (var i = 0; i < built.lazyImgs.length; i++) {
        imageObserver.observe(built.lazyImgs[i]);
      }
      show();
    }

    /**
     * Patch O(1): remove só o card afetado. Sem querySelector — uso o
     * Map indexado por chave composta. Se o trilho ficar vazio, esconde
     * a section (UI limpa).
     */
    function removeOne(item) {
      var k = key(item.mediaType, item.tmdbId);
      var el = byKey[k];
      if (!el) return;
      // unobserve as imgs do card antes de remover (libera o observer)
      var imgs = el.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) imageObserver.unobserve(imgs[i]);
      el.remove();
      delete byKey[k];
      if (!$list.children.length) hide();
    }

    /**
     * FASE 7.1 — Limpa estado e refaz o fetch. Chamado quando o usuário
     * muda (login/logout) — o userId atrás do `getCurrentUserId()` mudou,
     * então a lista anterior está obsoleta.
     *
     * Não usa init() pra evitar registrar o listener de novo (já registrado
     * no boot). Apenas:
     *   1. Remove todos os cards do trilho
     *   2. Limpa byKey
     *   3. Esconde a section (vai re-mostrar se rows > 0)
     *   4. Re-fetcha com o novo USER_ID
     */
    function reload() {
      // Bumpar gen ANTES de limpar — qualquer fetch in-flight (incluindo
      // o disparado pelo init()) tem seu .then() invalidado.
      var myGen = ++loadGen;

      // Unobserve imgs antes de limpar pra liberar referências do observer
      var imgs = $list.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) imageObserver.unobserve(imgs[i]);

      $list.replaceChildren();
      // Reseta o byKey preservando a referência (closure dependente).
      // `Object.keys` em null-prototype object funciona normalmente.
      var keys = Object.keys(byKey);
      for (var k = 0; k < keys.length; k++) delete byKey[keys[k]];
      hide();

      Favorites.list()
        .then(function (rows) {
          if (myGen !== loadGen) return;     // outro reload mais novo já rolou
          if (!rows.length) {
            if (!$list.children.length) hide();
            return;
          }
          var frag = document.createDocumentFragment();
          var allLazy = [];
          for (var i = 0; i < rows.length; i++) {
            var item = rowToItem(rows[i]);
            var dupKey = key(item.type, item.tmdbId);
            if (byKey[dupKey]) continue;
            var built = buildCardElement(item);
            byKey[dupKey] = built.article;
            frag.appendChild(built.fragment);
            for (var j = 0; j < built.lazyImgs.length; j++) {
              allLazy.push(built.lazyImgs[j]);
            }
          }
          $list.appendChild(frag);
          for (var k = 0; k < allLazy.length; k++) {
            imageObserver.observe(allLazy[k]);
          }
          show();
          console.log('[MyList] recarregada com', rows.length, 'favorito(s) do novo user.');
        })
        .catch(function (err) {
          if (myGen !== loadGen) return;
          console.warn('[MyList] reload falhou:', err);
          if (!$list.children.length) hide();
        });
    }

    /**
     * Limpa o DOM e o índice sem re-fetch. Usado por resetUserInterface()
     * no SIGNED_OUT pra zerar a UI antes do próximo fetch controlado.
     */
    function clear() {
      ++loadGen;   // invalida qualquer fetch in-flight
      var imgs = $list.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) imageObserver.unobserve(imgs[i]);
      $list.replaceChildren();
      var keys = Object.keys(byKey);
      for (var k = 0; k < keys.length; k++) delete byKey[keys[k]];
      hide();
    }

    return { init: init, reload: reload, clear: clear };
  })();

  /* ============================================================
     FASE 8 — HistoryService (watch_history)
     ============================================================
     Toda chamada a `enterPlayerView` no ContentModal dispara um
     `HistoryService.touch(item, { season, episode, episodeTitle })`.
     O service grava 1 row por (user, tmdb_id, media_type) via UPSERT.

     Estratégia para evitar chamadas excessivas ao banco:

     1) DEBOUNCE 500ms POR CHAVE (tmdb_id+media_type)
        - Cada `touch()` reseta um timer. Se o user clicar rapidamente
          em vários episódios da mesma série, só o ÚLTIMO upsert sai.
        - Cliques em séries diferentes têm timers independentes —
          não interferem entre si.

     2) DEDUPE SEMÂNTICO (sigCache)
        - Cache em memória do (season, episode) do último upsert
          enviado. Antes do flush, comparo com o payload novo. Se
          são idênticos, NEM SEQUER bate no banco.
        - Caso típico: user fecha modal e reabre o mesmo episódio
          5 segundos depois → dedupe pula o upsert (updated_at
          ficaria + 5s mais novo, mas a UI não muda).

     3) OPTIMISTIC EVENT
        - `dispatchEvent('yverflix:history-changed')` é disparado
          ANTES do upsert resolver. ContinueWatching atualiza a
          UI instantâneo. Se o upsert falhar, marco no log e libero
          o sigCache pra que um próximo touch retry naturalmente.

     4) UPSERT NATIVO (vs SELECT-then-INSERT/UPDATE)
        - Single round-trip por chave. UNIQUE constraint do banco
          é a garantia última.

     5) LAST-WRITE-WINS via updated_at
        - Mesmo se uma response chegar fora de ordem, o `updated_at`
          mais recente ganha no SELECT do boot (order by desc).

     Cenário stress: user abre 10 episódios em 3s.
       - 10 calls de touch() em <500ms → 1 upsert no banco (debounce).
       - Próxima sessão fecha o modal, reabre o E10 → 0 upserts (dedupe).
       - Total: ~1 upsert/banco por "session de zapping", em vez de 10. */

  var HistoryService = (function () {
    var TABLE = 'watch_history';
    var DEBOUNCE_MS = 500;

    function getClient() {
      return (window.YverFlix && window.YverFlix.supabase) || null;
    }
    function key(mediaType, tmdbId) { return mediaType + ':' + tmdbId; }

    var pendingTimers = Object.create(null);   // key -> timer id
    var pendingPayloads = Object.create(null);   // key -> payload
    var sigCache = Object.create(null);   // key -> last (season,episode) sent

    // Cache em memória do maior episódio assistido por (tmdbId, season).
    // Atualizado por touch() (síncrono) e getOne() (hidratação do DB).
    // Shape: { [tmdbId]: { [season]: maxEpisode } }
    var watchedCache = Object.create(null);

    /**
     * Marca um item como "assistido agora". Debounce 500ms + dedupe.
     *
     * @param {Object}      item         - { tmdbId, mediaType, title, posterPath }
     * @param {Object}      [ctx]        - { season, episode, episodeTitle }
     * @param {Object}      [progressData] - { progressSeconds, durationSeconds }
     * @param {boolean}     [forceFlush] - true = flush síncrono, bypass debounce
     */
    function touch(item, ctx, progressData, forceFlush) {
      if (!item || item.tmdbId == null || !item.mediaType) return;
      if (!isLoggedIn()) return;
      ctx = ctx || {};

      var k = key(item.mediaType, item.tmdbId);
      var payload = {
        user_id: getCurrentUserId(),
        tmdb_id: item.tmdbId,
        media_type: item.mediaType,
        title: item.title || null,
        poster_path: item.posterPath || null,
        season: ctx.season != null ? ctx.season : null,
        episode: ctx.episode != null ? ctx.episode : null,
        episode_title: ctx.episodeTitle || null,
        updated_at: new Date().toISOString(),
      };

      // Progresso temporal: só inclui no payload quando explicitamente
      // fornecido. Math.floor garante inteiros válidos; fallback pra 0
      // se o campo vier undefined/null/NaN.
      if (progressData) {
        payload.progress_seconds = Math.floor(Number(progressData.progressSeconds)) || 0;
        payload.duration_seconds = Math.floor(Number(progressData.durationSeconds)) || 0;
      }

      pendingPayloads[k] = payload;

      // Atualiza watchedCache imediatamente (síncrono) pra que a UI
      // de episódios assistidos reaja sem round-trip ao banco.
      if (payload.season != null && payload.episode != null) {
        if (!watchedCache[item.tmdbId]) watchedCache[item.tmdbId] = Object.create(null);
        var cur = watchedCache[item.tmdbId][payload.season] || 0;
        if (payload.episode > cur) watchedCache[item.tmdbId][payload.season] = payload.episode;
      }

      // Optimistic UI: ContinueWatching atualiza ANTES do round-trip.
      var eventDetail = {
        action: 'touched',
        item: {
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
          title: item.title || null,
          posterPath: item.posterPath || null,
          season: payload.season,
          episode: payload.episode,
          episodeTitle: payload.episode_title,
          updatedAt: payload.updated_at,
        },
      };
      if (progressData) {
        eventDetail.item.progressSeconds = payload.progress_seconds;
        eventDetail.item.durationSeconds = payload.duration_seconds;
      }
      window.dispatchEvent(new CustomEvent('yverflix:history-changed', {
        detail: eventDetail,
      }));

      // forceFlush: bypass debounce e flush síncrono imediato.
      // Usado no fechamento do modal/player pra não perder progresso
      // numa saída brusca do usuário (beforeunload, etc).
      if (forceFlush) {
        if (pendingTimers[k]) {
          clearTimeout(pendingTimers[k]);
          delete pendingTimers[k];
        }
        delete pendingPayloads[k];
        flush(k, payload, true);
        return;
      }

      if (pendingTimers[k]) clearTimeout(pendingTimers[k]);
      pendingTimers[k] = setTimeout(function () {
        delete pendingTimers[k];
        var p = pendingPayloads[k];
        delete pendingPayloads[k];
        flush(k, p);
      }, DEBOUNCE_MS);
    }

    function flush(k, payload, force) {
      var supa = getClient();
      if (!supa || !payload) return;

      // Dedupe semântico: se nada mudou (mesma S/E), skip o upsert.
      // Ignorado quando force=true (ex: flush de progresso no fechamento).
      if (!force) {
        var sig = sigCache[k];
        if (sig && sig.season === payload.season && sig.episode === payload.episode) {
          // updated_at ficaria 1-2s mais novo, mas a UI já reflete o estado.
          // Pular evita pressionar o banco em zapping de UI.
          return;
        }
      }
      sigCache[k] = { season: payload.season, episode: payload.episode };

      supa.from(TABLE)
        .upsert(payload, { onConflict: 'user_id,tmdb_id,media_type' })
        .then(function (res) {
          if (res.error) {
            // Libera o sigCache pra tentar de novo em um próximo touch.
            delete sigCache[k];
            console.warn('[History] upsert erro:', res.error);
          }
        });
    }

    /**
     * @returns {Promise<Array>} top N rows por updated_at desc.
     */
    function list(limit) {
      var supa = getClient();
      if (!supa || !isLoggedIn()) return Promise.resolve([]);
      var lim = limit || 10;
      return supa
        .from(TABLE)
        .select('id, user_id, tmdb_id, media_type, title, poster_path, season, episode, episode_title, progress_seconds, duration_seconds, updated_at')
        .eq('user_id', getCurrentUserId())
        .order('updated_at', { ascending: false })
        .limit(lim)
        .then(function (res) {
          if (res.error) {
            console.warn('[History] list erro:', res.error);
            return [];
          }
          return res.data || [];
        });
    }

    /**
     * Busca a última entrada de watch_history para (tmdbId, mediaType).
     * Usado pelo ContentModal pra hidratar o S/E ao abrir séries da Home.
     * @returns {Promise<{season:number, episode:number, progress_seconds:number}|null>}
     */
    function getOne(tmdbId, mediaType) {
      var supa = getClient();
      if (!supa || !isLoggedIn()) return Promise.resolve(null);
      return supa
        .from(TABLE)
        .select('season, episode, episode_title, progress_seconds')
        .eq('user_id', getCurrentUserId())
        .eq('tmdb_id', tmdbId)
        .eq('media_type', mediaType)
        .limit(1)
        .then(function (res) {
          if (res.error) {
            console.warn('[History] getOne erro:', res.error);
            return null;
          }
          var row = (res.data && res.data[0]) || null;
          // Hidrata watchedCache com o baseline do DB (maior episódio
          // persistido). touch() pode ter atualizado depois — por isso
          // só grava se for MAIOR que o cache atual.
          if (row && row.season != null && row.episode != null) {
            if (!watchedCache[tmdbId]) watchedCache[tmdbId] = Object.create(null);
            var cur = watchedCache[tmdbId][row.season] || 0;
            if (row.episode > cur) watchedCache[tmdbId][row.season] = row.episode;
          }
          return row;
        });
    }

    /**
     * Retorna o maior episódio assistido para (tmdbId, season) baseado
     * no watchedCache em memória. Usado pela renderização de episódios
     * pra marcar cards com a classe .is-watched.
     *
     * @returns {number} maior número de episódio, ou 0 se nenhum.
     */
    function getMaxWatchedEpisode(tmdbId, season) {
      if (!tmdbId || season == null) return 0;
      var entry = watchedCache[tmdbId];
      return (entry && entry[season]) || 0;
    }

    /**
     * Cancela timers + limpa caches. Chamado em logout (user trocou).
     */
    function invalidate() {
      var ts = Object.keys(pendingTimers);
      for (var i = 0; i < ts.length; i++) {
        clearTimeout(pendingTimers[ts[i]]);
        delete pendingTimers[ts[i]];
      }
      var ps = Object.keys(pendingPayloads);
      for (var j = 0; j < ps.length; j++) delete pendingPayloads[ps[j]];
      var ss = Object.keys(sigCache);
      for (var k = 0; k < ss.length; k++) delete sigCache[ss[k]];
      var ws = Object.keys(watchedCache);
      for (var w = 0; w < ws.length; w++) delete watchedCache[ws[w]];
    }

    return { touch: touch, list: list, getOne: getOne, getMaxWatchedEpisode: getMaxWatchedEpisode, invalidate: invalidate };
  })();
  // Expõe pra debugging (igual padrão YverFlix.supabase).
  window.YverFlix = window.YverFlix || {};
  window.YverFlix.HistoryService = HistoryService;

  /* ============================================================
     FASE 8 — ContinueWatching (carrossel "Continuar Assistindo")
     ============================================================
     Reusa createCard pra estética idêntica ao grid + Minha Lista.
     Sync via `yverflix:history-changed` (disparado pelo HistoryService).

     Patches incrementais (zero re-render do site):
       - Item já existe no rail → move pro topo + atualiza badge S/E.
       - Item novo → prepend.
       - Lista cresce além de 10 → trim do mais antigo (last-N consistente). */

  var ContinueWatching = (function () {
    var $section = document.getElementById('continue-section');
    var $list = document.getElementById('continue-list');

    var byKey = Object.create(null);    // "<media>:<id>" → article
    var loadGen = 0;

    function key(mediaType, tmdbId) { return mediaType + ':' + tmdbId; }
    function show() {
      if ($section) {
        $section.hidden = false;
        $section.classList.remove('is-hidden');
      }
    }
    function hide() {
      if ($section) {
        $section.hidden = true;
        $section.classList.add('is-hidden');
      }
    }

    function rowToItem(row) {
      return {
        tmdbId: row.tmdb_id,
        type: row.media_type,
        title: row.title || 'Sem título',
        posterPath: row.poster_path || null,
        posterUrl: row.poster_path
          ? CONFIG.TMDB_IMG_BASE + '/' + CONFIG.POSTER_SIZE + row.poster_path
          : null,
        voteAverage: 0,
        releaseDate: '',
      };
    }

    function badgeText(season, episode) {
      var ep = episode < 10 ? '0' + episode : String(episode);
      return 'T' + season + ' · E' + ep;
    }

    function buildCardElement(row) {
      var fragment = createCard(rowToItem(row));
      var article = fragment.querySelector('.card');
      article.classList.add('continue-card');

      // Deep linking: marca o card pra abrir o modal direto no player.
      article.dataset.autoplay = '1';
      if (row.season != null && row.episode != null) {
        article.dataset.resumeSeason = String(row.season);
        article.dataset.resumeEpisode = String(row.episode);

        // Badge "T1 · E03" sobreposta no canto inf-esq do poster.
        var posterWrap = article.querySelector('.card__poster-wrap');
        if (posterWrap) {
          var badge = document.createElement('span');
          badge.className = 'continue-card__badge';
          badge.textContent = badgeText(row.season, row.episode);
          posterWrap.appendChild(badge);
        }
      }

      var lazy = fragment.querySelectorAll('img[data-src]');
      return { article: article, fragment: fragment, lazyImgs: lazy };
    }

    function init() {
      hide();   // FASE 7.2 — seção começa oculta; só aparece após fetch autenticado.
      if ($list) $list.innerHTML = '';
      window.addEventListener('yverflix:history-changed', onChanged);
      // Fetch adiado para onAuthStateChange (INITIAL_SESSION/SIGNED_IN).
    }

    function fetchAndRender() {
      if (!$section || !$list) return;
      // FASE 7.2 — Blindagem: anônimo não deve ver carrossel nem invocar HistoryService.
      if (!isLoggedIn()) { clear(); hide(); return; }

      var myGen = ++loadGen;
      HistoryService.list(10)
        .then(function (rows) {
          if (myGen !== loadGen) return;
          if (!rows.length) {
            // Race: addUpsert por evento pode ter populado durante o fetch.
            if (!$list.children.length) hide();
            return;
          }
          var frag = document.createDocumentFragment();
          var allLazy = [];
          for (var i = 0; i < rows.length; i++) {
            var k = key(rows[i].media_type, rows[i].tmdb_id);
            if (byKey[k]) continue;       // já adicionado por evento
            var built = buildCardElement(rows[i]);
            byKey[k] = built.article;
            frag.appendChild(built.fragment);
            for (var j = 0; j < built.lazyImgs.length; j++) {
              allLazy.push(built.lazyImgs[j]);
            }
          }
          $list.appendChild(frag);
          for (var x = 0; x < allLazy.length; x++) {
            imageObserver.observe(allLazy[x]);
          }
          show();
        })
        .catch(function (err) {
          if (myGen !== loadGen) return;
          console.warn('[ContinueWatching] init falhou:', err);
          if (!$list.children.length) hide();
        });
    }

    function onChanged(e) {
      if (!isLoggedIn()) return;
      var d = e && e.detail;
      if (!d || !d.item) return;
      // Aceita 'touched' (only action por enquanto). Futuro: 'cleared'.
      if (d.action === 'touched') upsertCard(d.item);
    }

    /**
     * Patch O(1):
     *  - Existe → atualiza badge + data-attrs + move pro topo.
     *  - Não existe → cria + prepend. Trim a max=10 cards.
     */
    function upsertCard(item) {
      if (!$list) return;
      var k = key(item.mediaType, item.tmdbId);
      var existing = byKey[k];

      if (existing) {
        // Atualiza badge e data-attrs.
        var posterWrap = existing.querySelector('.card__poster-wrap');
        if (item.season != null && item.episode != null) {
          existing.dataset.resumeSeason = String(item.season);
          existing.dataset.resumeEpisode = String(item.episode);
          var badge = existing.querySelector('.continue-card__badge');
          if (!badge && posterWrap) {
            badge = document.createElement('span');
            badge.className = 'continue-card__badge';
            posterWrap.appendChild(badge);
          }
          if (badge) badge.textContent = badgeText(item.season, item.episode);
        }
        // Move pro topo (sem re-render: mesmo node).
        $list.insertBefore(existing, $list.firstChild);
        show();
        return;
      }

      // Card novo
      var built = buildCardElement({
        tmdb_id: item.tmdbId,
        media_type: item.mediaType,
        title: item.title,
        poster_path: item.posterPath,
        season: item.season,
        episode: item.episode,
      });
      byKey[k] = built.article;
      $list.insertBefore(built.fragment, $list.firstChild);
      for (var i = 0; i < built.lazyImgs.length; i++) {
        imageObserver.observe(built.lazyImgs[i]);
      }

      // Trim: mantém só os 10 mais recentes (consistente com o list(10)).
      while ($list.children.length > 10) {
        var last = $list.lastElementChild;
        if (!last) break;
        var lastKey = (last.dataset.mediaType || '') + ':' + (last.dataset.id || '');
        var imgs = last.querySelectorAll('img');
        for (var j = 0; j < imgs.length; j++) imageObserver.unobserve(imgs[j]);
        last.remove();
        delete byKey[lastKey];
      }
      show();
    }

    /**
     * Re-fetch quando o user trocou (login/logout). Mesmo padrão do MyList.
     */
    function reload() {
      if (!$section || !$list) return;
      var imgs = $list.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) imageObserver.unobserve(imgs[i]);
      $list.replaceChildren();
      var keys = Object.keys(byKey);
      for (var k = 0; k < keys.length; k++) delete byKey[keys[k]];
      hide();
      fetchAndRender();
    }

    /**
     * Limpa o DOM e o índice sem re-fetch. Usado por resetUserInterface().
     */
    function clear() {
      if (!$section || !$list) return;
      ++loadGen;
      var imgs = $list.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) imageObserver.unobserve(imgs[i]);
      $list.replaceChildren();
      var keys = Object.keys(byKey);
      for (var k = 0; k < keys.length; k++) delete byKey[keys[k]];
      hide();
    }

    return { init: init, reload: reload, clear: clear };
  })();

  /* ----------------------- 5. Content Modal (Fase 6) -------------------- */

  /**
   * FASE 6 — ContentModal.
   *
   * Refactor completo do PlayerModal da Fase 5:
   *   - Modal agora tem 2 views: 'details' (default) e 'player'.
   *   - Abrir um card → DetailsView.mount() → hero, elenco, episódios.
   *   - Iframe NÃO é criado em open(). É criado apenas em enterPlayerView()
   *     quando o usuário clica "Assistir Agora" (filme) ou um episódio.
   *   - Botão "Voltar" alterna do player para details (destrói iframe →
   *     libera banda imediatamente).
   *   - Fechar o modal limpa tudo.
   *
   * Estado em closure:
   *   - isOpen / view ('details' | 'player')
   *   - iframe (criado em demand)
   *   - currentItem / currentSeason / currentEpisode
   *   - cleanups (AbortController de listeners do open)
   */
  var ContentModal = (function () {
    var $modal = document.getElementById('player-modal');
    var $title = document.getElementById('player-title');
    var $back = document.getElementById('modal-back');
    var $detailsView = document.getElementById('details-view');
    var $detailsContent = document.getElementById('details-content');
    var $detailsLoading = document.getElementById('details-loading');
    var $playerView = document.getElementById('player-view');
    var $mount = document.getElementById('player-mount');
    var $closeBtns = $modal.querySelectorAll('[data-modal-close]');

    var state = {
      isOpen: false,
      view: 'details',
      iframe: null,
      currentItem: null,
      currentSeason: null,
      currentEpisode: null,
      currentEpisodeTitle: null,
      cleanups: null,
      lastFocused: null,
      activeServer: 'warezcdn', // Default server (Principal/Padrão)
    };

    /**
     * Construtores de URL dos provedores de streaming.
     * Cada um recebe (mediaType, tmdbId, season, episode) e devolve a URL
     * completa para o iframe.src.
     */
    function trocarIframePlayer(provedor, id, type, s, e) {
      var tmdbId = id;
      var season = s || 1;
      var episode = e || 1;

      if (provedor === 'vidsrc') {
        if (type === 'movie') {
          return 'https://vsembed.ru/embed/movie?tmdb=' + encodeURIComponent(tmdbId);
        } else {
          return 'https://vsembed.ru/embed/tv?tmdb=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season) + '&episode=' + encodeURIComponent(episode);
        }
      } else {
        // Principal/Padrão: warezcdn (.lat com hashes #color=E50914#nolink)
        if (type === 'movie') {
          return 'https://warezcdn.lat/filme/' + encodeURIComponent(tmdbId) + '#color=E50914#nolink';
        } else {
          return 'https://warezcdn.lat/serie/' + encodeURIComponent(tmdbId) + '/' + encodeURIComponent(season) + '/' + encodeURIComponent(episode) + '#color=E50914#nolink';
        }
      }
    }

    var openGeneration = 0;

    // Cronômetro de engajamento (viewport ativa).
    var watchTimerId = null;
    var currentProgressSeconds = 0;
    var isWatching = false;

    /**
     * Abre o modal com a view de DETALHES (não inicia o player ainda).
     * Iframe será criado apenas quando o usuário clicar "Assistir Agora"
     * (filme) ou um episódio (série).
     *
     * @param {{ tmdbId: number, mediaType: 'movie'|'tv', title: string }} item
     * @param {Object} [opts]
     * @param {boolean} [opts.autoplay]      FASE 8 — pular detalhes e ir direto pro player
     * @param {number}  [opts.resumeSeason]  FASE 8 — temporada salva (deep link do Continue)
     * @param {number}  [opts.resumeEpisode] FASE 8 — episódio salvo
     * @param {string}  [opts.resumeEpisodeTitle] FASE 8 — título do episódio salvo
     */
    function open(item, opts) {
      if (state.isOpen) close();
      opts = opts || {};

      state.isOpen = true;
      state.view = 'details';
      state.currentItem = item;
      state.currentSeason = null;
      state.currentEpisode = null;
      state.currentEpisodeTitle = null;
      state.activeServer = 'warezcdn';
      state.lastFocused = document.activeElement;

      state.cleanups = new AbortController();
      var sig = state.cleanups.signal;

      // 1) Body scroll lock sem layout shift.
      var scrollbarW = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbarW > 0) document.body.style.paddingRight = scrollbarW + 'px';

      // 2) Header + classe da view ATUAL (CSS toggla qual section é visível).
      $title.textContent = item.title || 'Detalhes';
      applyViewClass('details');

      // 3) Mostra modal.
      $modal.classList.add('modal--open');
      $modal.setAttribute('aria-hidden', 'false');

      // 4) Listeners agrupados no signal — fecha modal + back + ESC.
      document.addEventListener('keydown', onKeydown, { signal: sig });
      Array.prototype.forEach.call($closeBtns, function (btn) {
        btn.addEventListener('click', close, { signal: sig });
      });
      $back.addEventListener('click', enterDetailsView, { signal: sig });

      // 4.1) FASE 8.1 — Salva progresso em eventos de ciclo de vida do
      //      navegador. beforeunload cobre F5/cmd+W; visibilitychange
      //      cobre troca de aba. Ambos limpam via AbortSignal do modal.
      window.addEventListener('beforeunload', function () {
        saveCurrentProgress(true);
      }, { signal: sig });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden' && state.view === 'player') {
          saveCurrentProgress(true);
        }
      }, { signal: sig });

      // 5) Para séries sem resume explícito, consulta watch_history antes
      //    de montar o DetailsView. A query é indexada (user_id, tmdb_id,
      //    media_type) e resolve em ~50-100ms — o modal já está visível
      //    com loading state.
      var myGen = ++openGeneration;

      var mountDetails = function (resolved) {
        var resumeProgress = resolved.resumeProgress || 0;

        DetailsView.mount(item, $detailsContent, $detailsLoading, function (season, episode, episodeTitle) {
          enterPlayerView(season, episode, episodeTitle, resumeProgress);
          // Reseta pra 0 — só o primeiro play herda o progresso do banco.
          resumeProgress = 0;
        }, resolved);

        // 6) FASE 6.2 — liga o botão de favoritos ao item atual.
        Favorites.attach(item);

        // 7) FASE 8 — autoplay direto pra view player (filme vindo do
        //    Continuar Assistindo). Para séries, o autoplay é aplicado
        //    pelo SeriesEpisodes quando a temporada carrega.
        if (resolved.autoplay && item.mediaType === 'movie') {
          enterPlayerView(null, null, null, resumeProgress);
        }
      };

      if (item.mediaType === 'tv' && opts.resumeSeason == null && !opts.autoplay) {
        $detailsLoading.hidden = false;
        HistoryService.getOne(item.tmdbId, 'tv')
          .catch(function () { return null; })
          .then(function (row) {
            if (myGen !== openGeneration || !state.isOpen) return;
            if (!state.currentItem || state.currentItem.tmdbId !== item.tmdbId) return;

            var resolved = {
              resumeSeason: opts.resumeSeason,
              resumeEpisode: opts.resumeEpisode,
              autoplay: !!opts.autoplay,
            };

            if (row && row.season != null && row.episode != null) {
              resolved.resumeSeason = row.season;
              resolved.resumeEpisode = row.episode;
              resolved.resumeProgress = row.progress_seconds || 0;
            }

            mountDetails(resolved);
          });
      } else {
        mountDetails({
          resumeSeason: opts.resumeSeason,
          resumeEpisode: opts.resumeEpisode,
          autoplay: !!opts.autoplay,
        });
      }

      // 8) Foco inicial no botão fechar (acessibilidade).
      setTimeout(function () {
        var closeBtn = $modal.querySelector('.modal__close');
        if (closeBtn) closeBtn.focus();
      }, 0);
    }

    /* ---- Progress Tracker (engajamento de viewport) ---- */

    /**
     * Inicia o cronômetro de engajamento. Incrementa currentProgressSeconds
     * a cada 1s SOMENTE quando a aba está visível (document.visibilityState).
     *
     * @param {number} [initialSeconds=0] - valor hidratado do banco (progress_seconds)
     */
    function startProgressTracker(initialSeconds) {
      stopProgressTracker();
      currentProgressSeconds = initialSeconds || 0;
      isWatching = true;
      watchTimerId = setInterval(function () {
        if (document.visibilityState === 'visible') {
          currentProgressSeconds++;
          console.log('[Tracker] Tempo acumulado:', currentProgressSeconds);
        }
      }, 1000);
    }

    /** Para o cronômetro sem salvar. */
    function stopProgressTracker() {
      if (watchTimerId) {
        clearInterval(watchTimerId);
        watchTimerId = null;
      }
      isWatching = false;
    }

    /**
     * Persiste o progresso atual no Supabase via HistoryService.
     * NÃO para o tracker — use stopProgressTracker() separadamente
     * quando o tracker de fato deve morrer (destroyIframe / close).
     *
     * @param {boolean} [force=false] - true = flush síncrono (bypass debounce)
     */
    function saveCurrentProgress(force) {
      if (currentProgressSeconds <= 5) return;
      if (!state.currentItem) return;
      if (typeof HistoryService === 'undefined' || !HistoryService.touch) return;

      HistoryService.touch(
        state.currentItem,
        {
          season: state.currentSeason,
          episode: state.currentEpisode,
          episodeTitle: state.currentEpisodeTitle,
        },
        {
          progressSeconds: currentProgressSeconds,
          durationSeconds: 0,
        },
        !!force
      );
    }

    /**
     * Renderiza um toast de UX informando o último ponto de assistido.
     * Auto-remove após 6 segundos.
     *
     * @param {number} seconds - progress_seconds do banco
     */
    function showResumeToast(seconds) {
      if (!seconds || seconds <= 0) return;

      var h = Math.floor(seconds / 3600);
      var m = Math.floor((seconds % 3600) / 60);
      var s = seconds % 60;
      var timeStr = h > 0
        ? h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
        : m + ':' + (s < 10 ? '0' : '') + s;

      var toast = document.createElement('div');
      toast.className = 'resume-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.innerHTML =
        '<span class="resume-toast__icon" aria-hidden="true">\u23F1\uFE0F</span>' +
        '<span class="resume-toast__text">Voc\u00EA parou aos <strong>' + timeStr + '</strong> da \u00FAltima vez. Avance o player para continuar.</span>';

      // Injeta no body pra não ser afetado pelo overflow:hidden do modal.
      document.body.appendChild(toast);

      // Força reflow antes de adicionar a classe de entrada (transição CSS).
      void toast.offsetWidth;
      toast.classList.add('resume-toast--visible');

      setTimeout(function () {
        toast.classList.remove('resume-toast--visible');
        setTimeout(function () {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 400); // aguarda fade-out CSS
      }, 6000);
    }

    /*
     * FASE 6 — Alterna para a view do player e cria o iframe.
     * FASE 8 — também grava no watch_history (debounced no HistoryService).
     *
     * @param {number|null} season         null para filmes
     * @param {number|null} episode        null para filmes
     * @param {string|null} episodeTitle   título do ep ("Pilot"); usado pra UI
     *                                     do "Continuar Assistindo".
     * @param {number}      [initialProgress=0] - progress_seconds do banco
     */
    function enterPlayerView(season, episode, episodeTitle, initialProgress) {
      if (!state.isOpen || !state.currentItem) return;

      state.view = 'player';
      state.currentSeason = season;
      state.currentEpisode = episode;
      state.currentEpisodeTitle = episodeTitle || null;

      applyViewClass('player');
      createIframe(state.currentItem, season, episode);

      // FASE 8 — toda entrada no player é um "play" → registra no histórico.
      // O HistoryService faz dedupe + debounce internamente, então chamar
      // a cada enterPlayerView é seguro.
      if (typeof HistoryService !== 'undefined' && HistoryService.touch) {
        HistoryService.touch(state.currentItem, {
          season: season,
          episode: episode,
          episodeTitle: episodeTitle || null,
        });
      }

      // FASE 8.1 — Inicia tracker de engajamento a partir do último
      // progresso salvo no banco (ou 0 se não houver).
      startProgressTracker(initialProgress);

      // Toast de UX: informa o usuário do ponto de retomada.
      if (initialProgress > 0) {
        showResumeToast(initialProgress);
      }

      // Foco no botão Voltar (acessibilidade — user pode pressionar Enter
      // pra voltar ou Esc pra fechar).
      setTimeout(function () { try { $back.focus(); } catch (e) { } }, 0);
    }

    /* ---- Progress Tracker (engajamento de viewport) ---- */

    /*
     * Volta para a view de detalhes. Destrói o iframe (libera
     * banda imediatamente — comportamento equivalente ao close, exceto
     * que o modal continua aberto).
     */
    function enterDetailsView() {
      if (!state.isOpen) return;
      state.view = 'details';
      destroyIframe();
      applyViewClass('details');
      // Re-ativa marcação de episódios assistidos ao voltar do player.
      SeriesEpisodes.refreshWatched();
    }

    /*
     * Aplica a classe de view ao modal + atualiza atributos hidden.
     * Estratégia: ao usar classes E hidden ao mesmo tempo, garantimos
     * que screen readers ignorem a view oculta (hidden = aria-hidden).
     */
    function applyViewClass(view) {
      $modal.classList.toggle('modal--view-details', view === 'details');
      $modal.classList.toggle('modal--view-player', view === 'player');
      $detailsView.hidden = view !== 'details';
      $playerView.hidden = view !== 'player';
      $back.hidden = view !== 'player';

      if (view === 'details') {
        $title.textContent = state.currentItem ? state.currentItem.title : 'Detalhes';
      } else {
        syncModalMetadata(state.currentSeason, state.currentEpisode, state.currentEpisodeTitle);
      }
    }

    /**
     * Sincroniza o label de metadata no header sempre que há mudança de
     * episódio. Formata como "SxEp — Título".
     *
     * @param {number|null} s     season
     * @param {number|null} e     episode
     * @param {string|null} title título do episódio
     */
    function syncModalMetadata(s, e, title) {
      var label;
      if (s != null && e != null) {
        label = s + 'x' + (e < 10 ? '0' + e : String(e));
        if (title) label += ' \u2014 ' + title;
      } else {
        label = state.currentItem ? state.currentItem.title : 'Player';
      }
      $title.textContent = label;
    }

    /*
     * Injeta o iframe no #player-mount.
     * Fluxo: WarezCDN (padrão) com seletor manual para VidSrc.
     *
     * DESIGN:
     *   - $mount.innerHTML = '' remove QUALQUER filho anterior (iframe, erro, loading).
     *     Mais seguro que rastrear nós individualmente — zero memory leak.
     *   - iframe.style: preenche 100% do mount.
     *   - onload limpa classe de loading.
     */
    function createIframe(item, season, episode) {
      destroyIframe();

      // Limpa qualquer conteúdo anterior (iframe quebrado, tela de erro, etc).
      $mount.innerHTML = '';

      // 1. Injeta o seletor de servidores
      injetarSeletorDeServidores(item.tmdbId, item.mediaType, season, episode);

      // 2. Injeta o título do conteúdo
      var titleEl = document.createElement('div');
      titleEl.className = 'player-title';

      var label;
      if (season != null && episode != null) {
        label = season + 'x' + (episode < 10 ? '0' + episode : String(episode));
        if (state.currentEpisodeTitle) {
          label += ' \u2014 ' + state.currentEpisodeTitle;
        } else {
          label += ' \u2014 ' + item.title;
        }
      } else {
        label = item.title;
      }
      titleEl.textContent = label;
      $mount.appendChild(titleEl);

      // 3. Construção do iframe
      var iframe = document.createElement('iframe');
      iframe.setAttribute('frameborder', '0');
      iframe.setAttribute('width', '100%');
      iframe.setAttribute('height', '100%');
      iframe.setAttribute('referrerpolicy', 'origin');
      iframe.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.removeAttribute('sandbox'); // Garante que não possui sandbox

      // Estilos inline: posicionamento relativo para fluxo normal
      iframe.style.width = '100%';
      iframe.style.flex = '1';
      iframe.style.border = 'none';
      iframe.style.position = 'relative';
      iframe.style.background = '#000';

      state.iframe = iframe;

      // Adiciona classe de loading e listener onload
      iframe.classList.add('loading');
      iframe.onload = function () {
        iframe.classList.remove('loading');
      };

      // URL baseada no servidor ativo
      var urlGerada = trocarIframePlayer(state.activeServer, item.tmdbId, item.mediaType, season, episode);
      console.log('[YverFlix Player] URL gerada:', urlGerada);
      console.log('[Player] Geração de URL - tmdbId:', item.tmdbId, 'season:', season, 'episode:', episode, '-> URL:', urlGerada);
      console.log('[Player] Carregando ' + (state.activeServer === 'warezcdn' ? 'WarezCDN' : 'VidSrc') + ':', urlGerada);

      iframe.src = urlGerada;

      // Injeta no DOM após o título.
      $mount.appendChild(iframe);
    }

    /*
     * Destrói o iframe e limpa o mount.
     * Sequência segura: about:blank corta a mídia → innerHTML='' remove do DOM.
     */
    function destroyIframe() {
      saveCurrentProgress(true);
      stopProgressTracker();

      if (state.iframe) {
        // about:blank antes de remover: corta áudio/banda no Chromium.
        try {
          state.iframe.onload = null;
          state.iframe.onerror = null;
          state.iframe.src = 'about:blank';
        } catch (e) { /* noop */ }
        state.iframe = null;
      }

      // Limpa TUDO do mount (iframe, tela de erro, barrier, etc).
      $mount.innerHTML = '';
    }

    /**
     * Injeta o seletor de servidores (botões flutuantes) por cima do player de vídeo.
     * Mapeia os servidores WarezCDN e VidSrc e cuida do chaveamento reativo.
     *
     * @param {number} tmdbId
     * @param {'movie'|'tv'} type
     * @param {number|null} season
     * @param {number|null} episode
     */
    function injetarSeletorDeServidores(tmdbId, type, season, episode) {
      if (!state.currentItem) return;

      // Remove qualquer seletor anterior para evitar duplicidade
      var oldSelector = $mount.querySelector('.player-servers');
      if (oldSelector) {
        oldSelector.remove();
      }

      var container = document.createElement('div');
      container.className = 'player-servers';
      container.setAttribute('role', 'group');
      container.setAttribute('aria-label', 'Seletor de Servidores');

      var servers = [
        { id: 'warezcdn', name: 'WarezCDN (Dublado)', icon: '🔊' },
        { id: 'vidsrc', name: 'VidSrc (Legendado HD)', icon: '📝' }
      ];

      servers.forEach(function (server) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'player-server-btn';
        btn.dataset.server = server.id;

        var isCurrent = state.activeServer === server.id;
        btn.classList.toggle('player-server-btn--active', isCurrent);
        btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');

        // Cria o conteúdo do botão com ícone + texto
        btn.innerHTML = '<span class="player-server-icon" aria-hidden="true">' + server.icon + '</span> ' +
          '<span>' + server.name + '</span>';

        btn.addEventListener('click', function () {
          switchServer(server.id);
        });

        container.appendChild(btn);
      });

      // Estilização do selectorContainer
      Object.assign(container.style, {
        position: 'relative',
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '10px',
        zIndex: '9999',
        background: 'rgba(10, 10, 10, 0.85)',
        marginBottom: '8px'
      });

      // Injeta como primeiro filho para ficar empilhado acima do iframe
      $mount.insertBefore(container, $mount.firstChild);
    }

    /**
     * Chaveia de forma dinâmica o iframe do player, caçando e destruindo o anterior
     * de forma estrita para evitar memory leaks na GPU do Android.
     *
     * @param {'warezcdn'|'vidsrc'} newServer
     */
    function switchServer(newServer) {
      if (!state.currentItem) return;
      if (state.activeServer === newServer) return;
      state.activeServer = newServer;

      // 1. Destruir iframe anterior
      if (state.iframe) {
        try {
          state.iframe.onload = null;
          state.iframe.onerror = null;
          state.iframe.src = 'about:blank';
        } catch (e) { /* noop */ }
        state.iframe.remove();
      }
      state.iframe = null;

      // 2. Criar e injetar o novo iframe
      var iframe = document.createElement('iframe');
      iframe.setAttribute('frameborder', '0');
      iframe.setAttribute('width', '100%');
      iframe.setAttribute('height', '100%');
      iframe.setAttribute('referrerpolicy', 'origin');
      iframe.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.removeAttribute('sandbox'); // Garante que não possui sandbox

      iframe.style.width = '100%';
      iframe.style.flex = '1';
      iframe.style.border = 'none';
      iframe.style.position = 'relative';
      iframe.style.background = '#000';

      // Adiciona classe de loading e listener onload
      iframe.classList.add('loading');
      iframe.onload = function () {
        iframe.classList.remove('loading');
      };

      var urlGerada = trocarIframePlayer(state.activeServer, state.currentItem.tmdbId, state.currentItem.mediaType, state.currentSeason, state.currentEpisode);
      console.log('[YverFlix Player] URL gerada:', urlGerada);
      console.log('[Player] Geração de URL (switch) - tmdbId:', state.currentItem.tmdbId, 'season:', state.currentSeason, 'episode:', state.currentEpisode, '-> URL:', urlGerada);
      console.log('[Player] Chaveando para ' + (state.activeServer === 'warezcdn' ? 'WarezCDN' : 'VidSrc') + ':', urlGerada);

      iframe.src = urlGerada;
      state.iframe = iframe;

      // Injeta o novo iframe no final do mount (mantendo a pilha flexbox correta)
      $mount.appendChild(iframe);

      // Atualizar o destaque visual dos botões
      var buttons = $mount.querySelectorAll('.player-server-btn');
      buttons.forEach(function (btn) {
        var isCurrent = btn.dataset.server === state.activeServer;
        btn.classList.toggle('player-server-btn--active', isCurrent);
        btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
      });
    }

    /**
     * Fecha o modal e libera TODOS os recursos (iframe + DetailsView).
     */
    function close() {
      if (!state.isOpen) return;

      // 1) Desliga listeners + cancela requests + destrói iframe.
      if (state.cleanups) { state.cleanups.abort(); state.cleanups = null; }
      destroyIframe();

      // 1.1) Reseta acumulador do tracker pra não vazar pra próxima sessão.
      currentProgressSeconds = 0;

      // 2) Cleanup do DetailsView (que cleanup-a SeriesEpisodes em cascata).
      try { DetailsView.destroy(); } catch (e) { /* noop */ }

      // 2.5) FASE 6.2 — desliga botão de favoritos. Invalida quaisquer
      //      promessas pendentes (loadStatus / toggle) — respostas tardias
      //      caem em early-return.
      try { Favorites.detach(); } catch (e) { /* noop */ }

      // 3) Reseta classes e estados visuais.
      $modal.classList.remove('modal--open');
      $modal.classList.remove('modal--view-player');
      $modal.classList.add('modal--view-details');
      $modal.setAttribute('aria-hidden', 'true');
      $detailsView.hidden = false;
      $playerView.hidden = true;
      $back.hidden = true;

      // 4) Restaura body scroll.
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';

      // 5) Restaura o foco.
      if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
        try { state.lastFocused.focus(); } catch (e) { /* noop */ }
      }
      state.lastFocused = null;
      state.currentItem = null;
      state.currentSeason = null;
      state.currentEpisode = null;
      state.view = 'details';
      state.isOpen = false;
    }

    /* ---- handlers ---- */

    function onIframeFail(err) {
      console.error('[Player] Falha definitiva:', err);
      destroyIframe();
      renderErrorState();
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }

    /* ---- estados visuais ---- */

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

      // Botão 'Tentar novamente' — recria o iframe SEM destruir details.
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'grid__retry';
      retry.textContent = 'Tentar novamente';
      retry.addEventListener('click', function () {
        if (!state.currentItem) return;
        // Recria o iframe (createIframe já mostra o spinner internamente).
        createIframe(state.currentItem, state.currentSeason, state.currentEpisode);
      }, { signal: state.cleanups ? state.cleanups.signal : undefined });

      // Link 'Abrir em nova aba' — fallback definitivo.
      var link = document.createElement('a');
      link.className = 'player__error-link';
      link.textContent = 'Abrir em nova aba';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (state.currentItem) {
        link.href = trocarIframePlayer(
          state.activeServer,
          state.currentItem.tmdbId,
          state.currentItem.mediaType,
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
    return { open: open, close: close, injetarSeletorDeServidores: injetarSeletorDeServidores };
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
  // FASE 6.3 — escopa o `.section__sub` ao header do Trending. Antes
  // era `document.querySelector('.section__sub')`, que pegava o
  // PRIMEIRO match — agora a seção "Minha Lista" também tem um
  // `.section__sub` e estaria sendo sobrescrita.
  var $sectionSub = $sectionTitle.parentElement.querySelector('.section__sub');
  var $loadMore = document.getElementById('grid-loadmore');
  var $sentinel = document.getElementById('grid-sentinel');
  var $chips = document.getElementById('genres-chips');

  /* ----- Header dinâmico baseado no modo atual ------------------------- */

  function setHeader() {
    if (state.mode === 'search') {
      $sectionTitle.textContent = 'Resultados para "' + state.query + '"';
      $sectionSub.textContent = 'Filmes e séries encontrados na TMDB';
    } else if (state.mode === 'genre') {
      $sectionTitle.textContent = 'Gênero: ' + state.genreName;
      $sectionSub.textContent = 'Filmes mais populares deste gênero';
    } else {
      $sectionTitle.textContent = 'Em alta nesta semana';
      $sectionSub.textContent = 'Filmes e séries mais populares no momento';
    }
  }

  function getEmptyMessage() {
    if (state.mode === 'search') return 'Nenhum resultado para "' + state.query + '".';
    if (state.mode === 'genre') return 'Nenhum filme encontrado neste gênero.';
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
    if (state.mode === 'genre') return getByGenre(state.genreId, page, signal);
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

  /* ===== Click delegation no grid (cards → ContentModal) =============== */

  function onCardClick(event) {
    var card = event.target.closest('.card');
    if (!card || !card.dataset.id) return;       // ignora skeletons/msgs
    var titleEl = card.querySelector('.card__title');

    // FASE 8 — deep linking: cards de "Continuar Assistindo" carregam
    // data-autoplay (e data-resume-* pra séries). ContentModal.open lê
    // esses opts e pula direto pro player view, com S/E correto.
    var opts = null;
    if (card.dataset.autoplay === '1') {
      opts = {
        autoplay: true,
        resumeSeason: card.dataset.resumeSeason
          ? Number(card.dataset.resumeSeason) : undefined,
        resumeEpisode: card.dataset.resumeEpisode
          ? Number(card.dataset.resumeEpisode) : undefined,
      };
    }

    ContentModal.open({
      tmdbId: Number(card.dataset.id),
      mediaType: card.dataset.mediaType,
      title: titleEl ? titleEl.textContent : '',
      // FASE 6.2 — passa pro Favorites pra gravar no Supabase.
      // Pode ser undefined (filme/série sem poster); a tabela aceita null.
      posterPath: card.dataset.posterPath || null,
    }, opts);
  }
  function onCardKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var card = event.target.closest('.card');
    if (!card || !card.dataset.id) return;
    event.preventDefault();
    card.click();
  }
  $grid.addEventListener('click', onCardClick);
  $grid.addEventListener('keydown', onCardKeydown);

  // FASE 6.3 — mesma delegação no rail "Minha Lista" (cards têm o mesmo markup).
  var $myListRail = document.getElementById('my-list');
  if ($myListRail) {
    $myListRail.addEventListener('click', onCardClick);
    $myListRail.addEventListener('keydown', onCardKeydown);
  }

  // FASE 8 — mesma delegação no rail "Continuar Assistindo".
  var $continueRail = document.getElementById('continue-list');
  if ($continueRail) {
    $continueRail.addEventListener('click', onCardClick);
    $continueRail.addEventListener('keydown', onCardKeydown);
  }

  /* ===== 6.1 Search wiring (Fase 3) ==================================== */

  var $searchInput = document.getElementById('search-input');
  var $searchClear = document.getElementById('search-clear');
  var $searchForm = document.getElementById('search-form');

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

  /* ===== 6.1b Search Suggestions (predictive dropdown) ================== */

  (function initSearchSuggestions() {
    var $suggestions = document.getElementById('search-suggestions');
    if (!$searchInput || !$suggestions) return;

    var abortCtrl = null;
    var gen = 0;

    function hideSuggestions() {
      $suggestions.hidden = true;
      $suggestions.innerHTML = '';
      if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    }

    function showSuggestions() {
      $suggestions.hidden = false;
    }

    function renderItems(items) {
      $suggestions.innerHTML = '';
      if (!items.length) {
        var empty = document.createElement('div');
        empty.className = 'search-suggestion__empty';
        empty.textContent = 'Nenhum resultado.';
        $suggestions.appendChild(empty);
        showSuggestions();
        return;
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var row = document.createElement('div');
        row.className = 'search-suggestion';
        row.setAttribute('role', 'option');
        row.dataset.tmdbId = item.tmdbId;
        row.dataset.mediaType = item.type;
        row.dataset.posterPath = item.posterPath || '';
        row.tabIndex = 0;

        var poster = document.createElement('img');
        poster.className = 'search-suggestion__poster';
        poster.src = item.posterUrl || '';
        poster.alt = '';
        poster.loading = 'lazy';
        if (!item.posterUrl) poster.style.visibility = 'hidden';

        var info = document.createElement('div');
        info.className = 'search-suggestion__info';

        var title = document.createElement('span');
        title.className = 'search-suggestion__title';
        title.textContent = item.title || 'Sem título';

        var meta = document.createElement('span');
        meta.className = 'search-suggestion__meta';

        var year = (item.releaseDate || '').slice(0, 4);
        if (year) {
          var yearSpan = document.createElement('span');
          yearSpan.textContent = year;
          meta.appendChild(yearSpan);
        }

        var typeTag = document.createElement('span');
        typeTag.className = 'search-suggestion__type';
        typeTag.textContent = item.type === 'movie' ? 'Filme' : 'Série';
        meta.appendChild(typeTag);

        info.appendChild(title);
        info.appendChild(meta);
        row.appendChild(poster);
        row.appendChild(info);
        frag.appendChild(row);
      }
      $suggestions.appendChild(frag);
      showSuggestions();
    }

    function fetchSuggestions(query) {
      if (abortCtrl) { abortCtrl.abort(); }
      abortCtrl = new AbortController();
      var myGen = ++gen;

      searchMulti(query, 1, abortCtrl.signal)
        .then(function (result) {
          if (myGen !== gen) return;
          renderItems(result.items.slice(0, 6));
        })
        .catch(function (err) {
          if (myGen !== gen) return;
          if (err.name === 'AbortError') return;
          console.warn('[Suggestions] fetch erro:', err);
          hideSuggestions();
        });
    }

    var debouncedFetch = debounce(function (query) {
      if (!query || query.trim().length < 2) {
        hideSuggestions();
        return;
      }
      fetchSuggestions(query.trim());
    }, 300);

    // Input listener para sugestões (separado do debouncedApplyQuery existente).
    $searchInput.addEventListener('input', function () {
      debouncedFetch(this.value);
    });

    // Click em sugestão → abre modal + limpa busca.
    $suggestions.addEventListener('click', function (e) {
      var row = e.target.closest('.search-suggestion');
      if (!row) return;

      ContentModal.open({
        tmdbId: Number(row.dataset.tmdbId),
        mediaType: row.dataset.mediaType,
        title: row.querySelector('.search-suggestion__title').textContent,
        posterPath: row.dataset.posterPath || null,
      });

      hideSuggestions();
      $searchInput.value = '';
      $searchClear.hidden = true;
      debouncedApplyQuery.cancel();
      applyQuery('');
    });

    // Teclado (Enter/Space) na sugestão.
    $suggestions.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target.closest('.search-suggestion');
      if (!row) return;
      e.preventDefault();
      row.click();
    });

    // ESC fecha sugestões.
    $searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        hideSuggestions();
        debouncedFetch.cancel();
      }
    });

    // Fora → fecha sugestões (com delay pra permitir click).
    document.addEventListener('click', function (e) {
      if (!$searchForm.contains(e.target)) {
        hideSuggestions();
      }
    });

    // Clear button também fecha sugestões.
    $searchClear.addEventListener('click', function () {
      hideSuggestions();
      debouncedFetch.cancel();
    });
  })();

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

  /* ----------------------- 9. Auth (FASE 7.1) --------------------------- */

  /**
   * FASE 7.1 — Auth Email/Senha via Supabase Auth.
   *
   * Decisões de segurança e UX:
   *
   * 1. **Validação client-side dupla** — regex de email + comprimento >= 8.
   *    NÃO substitui validação server-side (Supabase tem suas próprias
   *    regras), mas evita request inúteis e dá feedback instantâneo.
   *
   * 2. **`disabled` durante request** — atributo HTML real (não só CSS).
   *    Defesa em profundidade: o submit do form e clicks no botão são
   *    bloqueados pelo browser. O flag `submitting` no closure é segunda
   *    linha (caso o disabled seja burlado via DevTools).
   *
   * 3. **Rate-limit (429) tratado explicitamente** — Supabase retorna
   *    `error.status === 429` ou message contendo "rate limit". Mostro
   *    banner amarelo ("aguarde alguns segundos") em vez de erro vermelho
   *    genérico. Mantém o submit disabled por 10s como cooldown extra,
   *    pra não dar pro usuário insistir e bater de novo no rate-limit.
   *
   * 4. **Erros mapeados** — códigos comuns (Invalid login, User already
   *    registered, Email not confirmed) viram mensagens em PT-BR amigáveis.
   *
   * 5. **Tabs Login/Signup compartilham form** — sem re-mount do DOM.
   *    Toggle só muda label do submit + autocomplete + handler interno.
   *
   * 6. **NÃO loga senha em console** mesmo em erro. O Supabase também
   *    não retorna a senha em payload de erro, mas reforço aqui.
   */
  var Auth = (function () {
    var $modal = document.getElementById('auth-modal');
    var $form = document.getElementById('auth-form');
    var $tabLogin = document.getElementById('auth-tab-login');
    var $tabSignup = document.getElementById('auth-tab-signup');
    var $title = document.getElementById('auth-modal-title');
    var $email = document.getElementById('auth-email');
    var $password = document.getElementById('auth-password');
    var $emailErr = document.getElementById('auth-email-error');
    var $passErr = document.getElementById('auth-password-error');
    var $banner = document.getElementById('auth-banner');
    var $submit = document.getElementById('auth-submit');
    var $submitLbl = document.getElementById('auth-submit-label');

    var $headerWrap = document.getElementById('auth-header');
    var $loginBtn = document.getElementById('auth-login-btn');
    var $userWrap = document.getElementById('auth-header-user');
    var $userEmail = document.getElementById('auth-header-email');
    var $logoutBtn = document.getElementById('auth-logout-btn');

    /** Modo atual: 'login' ou 'signup'. */
    var mode = 'login';

    /** Flag que bloqueia submit duplo enquanto request em voo. */
    var submitting = false;

    /** Cooldown ID (rate-limit) — clearable se o usuário fechar o modal. */
    var rateLimitTimer = null;

    /* ---- Validação client-side ---------------------------------------- */

    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var PASSWORD_MIN = 8;

    function isEmailValid(v) {
      return EMAIL_RE.test(String(v || '').trim());
    }
    function isPasswordValid(v) {
      return String(v || '').length >= PASSWORD_MIN;
    }

    function validate() {
      var emailOk = isEmailValid($email.value);
      var passOk = isPasswordValid($password.value);
      $submit.disabled = !(emailOk && passOk) || submitting;
      return { emailOk: emailOk, passOk: passOk, ok: emailOk && passOk };
    }

    function showFieldError($input, $err, msg) {
      $input.parentElement.classList.add('auth-field--invalid');
      $err.textContent = msg;
      $err.hidden = false;
    }
    function clearFieldError($input, $err) {
      $input.parentElement.classList.remove('auth-field--invalid');
      $err.textContent = '';
      $err.hidden = true;
    }
    function clearAllErrors() {
      clearFieldError($email, $emailErr);
      clearFieldError($password, $passErr);
      hideBanner();
    }

    /* ---- Banner top-level (rate-limit / erros gerais) ------------------ */

    function showBanner(msg, kind) {
      $banner.textContent = msg;
      $banner.className = 'auth-modal__banner auth-modal__banner--' + (kind || 'error');
      $banner.hidden = false;
    }
    function hideBanner() {
      $banner.hidden = true;
      $banner.textContent = '';
      $banner.className = 'auth-modal__banner';
    }

    /* ---- Tab toggle ---------------------------------------------------- */

    function setMode(next) {
      mode = next === 'signup' ? 'signup' : 'login';
      $tabLogin.classList.toggle('auth-modal__tab--active', mode === 'login');
      $tabSignup.classList.toggle('auth-modal__tab--active', mode === 'signup');
      $tabLogin.setAttribute('aria-selected', mode === 'login' ? 'true' : 'false');
      $tabSignup.setAttribute('aria-selected', mode === 'signup' ? 'true' : 'false');
      $title.textContent = mode === 'signup' ? 'Criar sua conta' : 'Entrar na sua conta';
      $submitLbl.textContent = mode === 'signup' ? 'Criar conta' : 'Entrar';
      // autocomplete hint pra password manager:
      $password.setAttribute(
        'autocomplete',
        mode === 'signup' ? 'new-password' : 'current-password'
      );
      clearAllErrors();
      validate();
    }

    /* ---- Open / Close ------------------------------------------------- */

    function open() {
      $modal.hidden = false;
      // Pequeno delay pra evitar conflito com focus do botão "Entrar"
      // que abriu o modal (acessibilidade — focus trap simples).
      setTimeout(function () { $email.focus(); }, 50);
      document.addEventListener('keydown', onKeyDown);
    }

    function close() {
      $modal.hidden = true;
      $form.reset();
      clearAllErrors();
      setLoading(false);
      if (rateLimitTimer) {
        clearTimeout(rateLimitTimer);
        rateLimitTimer = null;
      }
      submitting = false;
      $submit.disabled = true;
      document.removeEventListener('keydown', onKeyDown);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') close();
    }

    /* ---- Loading state ------------------------------------------------- */

    function setLoading(loading) {
      submitting = !!loading;
      $submit.classList.toggle('auth-modal__submit--loading', !!loading);
      // Inputs também vão pra disabled durante a request — UX consistente
      // (não dá pra editar o email enquanto a senha tá sendo verificada).
      $email.disabled = !!loading;
      $password.disabled = !!loading;
      // submit fica disabled por loading OU validação inválida — re-evalua
      validate();
    }

    /* ---- Mapeamento de erros do Supabase ------------------------------- */

    function isRateLimitError(err) {
      if (!err) return false;
      if (err.status === 429) return true;
      var msg = String(err.message || '').toLowerCase();
      return msg.indexOf('rate limit') >= 0 ||
        msg.indexOf('too many requests') >= 0;
    }

    function friendlyError(err) {
      if (!err) return 'Erro desconhecido. Tente de novo.';
      var msg = String(err.message || '').toLowerCase();
      if (isRateLimitError(err)) {
        return 'Muitas tentativas. Aguarde alguns segundos e tente de novo.';
      }
      if (msg.indexOf('invalid login') >= 0 ||
        msg.indexOf('invalid credentials') >= 0) {
        return 'Email ou senha incorretos.';
      }
      if (msg.indexOf('user already registered') >= 0 ||
        msg.indexOf('already been registered') >= 0) {
        return 'Esse email já tem conta. Tente fazer login.';
      }
      if (msg.indexOf('email not confirmed') >= 0) {
        return 'Confirme seu email antes de entrar (verifique a caixa de entrada).';
      }
      if (msg.indexOf('password') >= 0 && msg.indexOf('weak') >= 0) {
        return 'Senha muito fraca. Use no mínimo 8 caracteres.';
      }
      if (msg.indexOf('network') >= 0 || msg.indexOf('failed to fetch') >= 0) {
        return 'Sem conexão com o servidor. Confira sua internet.';
      }
      // Fallback — mostra mensagem original do Supabase (já em PT em alguns casos)
      return err.message || 'Algo deu errado. Tente de novo.';
    }

    /* ---- Submit -------------------------------------------------------- */

    function onSubmit(e) {
      e.preventDefault();
      if (submitting) return;          // bloqueio duplo (defesa em profundidade)

      clearAllErrors();
      var v = validate();

      if (!v.emailOk) {
        showFieldError($email, $emailErr, 'Formato de email inválido.');
      }
      if (!v.passOk) {
        showFieldError(
          $password, $passErr,
          'Senha precisa ter pelo menos ' + PASSWORD_MIN + ' caracteres.'
        );
      }
      if (!v.ok) return;

      var supa = (window.YverFlix && window.YverFlix.supabase) || null;
      if (!supa) {
        showBanner('Cliente Supabase indisponível. Recarregue a página.', 'error');
        return;
      }

      var email = String($email.value).trim();
      var password = String($password.value);

      setLoading(true);

      var op = mode === 'signup'
        ? supa.auth.signUp({ email: email, password: password })
        : supa.auth.signInWithPassword({ email: email, password: password });

      op
        .then(function (res) {
          if (res.error) return handleAuthError(res.error);

          // Sucesso. SIGNED_IN dispara via onAuthStateChange e fecha o
          // modal. Aqui só tratamos signup com email_confirmed=null,
          // que NÃO dispara SIGNED_IN automaticamente.
          if (mode === 'signup' && res.data && res.data.user &&
            !res.data.session) {
            // Confirmação por email habilitada no projeto → dá feedback
            // pro usuário verificar a caixa de entrada.
            setLoading(false);
            showBanner(
              'Conta criada! Verifique seu email pra confirmar antes de entrar.',
              'success'
            );
          }
          // Se vier session, onAuthStateChange já vai disparar e
          // o handler central fecha o modal + atualiza header.
        })
        .catch(function (err) {
          handleAuthError(err);
        });
    }

    function handleAuthError(err) {
      console.warn('[Auth]', mode, 'erro:', err && err.message);
      setLoading(false);
      var msg = friendlyError(err);

      if (isRateLimitError(err)) {
        showBanner(msg, 'warn');
        // Cooldown de 10s — desabilita submit pra não bater de novo
        // imediatamente (o servidor já vai recusar mesmo, mas evitamos
        // mais 1 round-trip + log).
        $submit.disabled = true;
        rateLimitTimer = setTimeout(function () {
          rateLimitTimer = null;
          validate();        // re-habilita se inputs continuam válidos
        }, 10000);
      } else {
        showBanner(msg, 'error');
      }
    }

    /* ---- Logout -------------------------------------------------------- */

    function signOut() {
      var supa = (window.YverFlix && window.YverFlix.supabase) || null;
      if (!supa) return;
      $logoutBtn.disabled = true;     // race protection
      supa.auth.signOut()
        .then(function (res) {
          if (res && res.error) {
            console.error('[Auth] signOut erro:', res.error);
          }
        })
        .catch(function (err) { console.error('[Auth] signOut catch:', err); })
        .finally(function () {
          $logoutBtn.disabled = false;
        });
    }

    /* ---- Header UI sync ------------------------------------------------ */

    function updateHeaderUI(session) {
      $headerWrap.hidden = false;
      if (session && session.user) {
        $loginBtn.hidden = true;
        $userWrap.hidden = false;
        $userEmail.textContent = session.user.email || '';
      } else {
        $loginBtn.hidden = false;
        $userWrap.hidden = true;
        $userEmail.textContent = '';
      }
    }

    /* ---- Wire-up ------------------------------------------------------- */

    function bind() {
      $tabLogin.addEventListener('click', function () { setMode('login'); });
      $tabSignup.addEventListener('click', function () { setMode('signup'); });

      $email.addEventListener('input', function () {
        clearFieldError($email, $emailErr);
        validate();
      });
      $password.addEventListener('input', function () {
        clearFieldError($password, $passErr);
        validate();
      });

      $form.addEventListener('submit', onSubmit);

      // Fechar modal: backdrop, X, ESC. Tudo via data-auth-close.
      $modal.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.matches && t.matches('[data-auth-close]')) close();
      });

      $loginBtn.addEventListener('click', open);
      $logoutBtn.addEventListener('click', signOut);

      validate();
    }

    return {
      bind: bind,
      open: open,
      close: close,
      updateHeaderUI: updateHeaderUI,
      signOut: signOut,
    };
  })();

  /* ===== Cleanup ao descartar a página ================================= */

  window.addEventListener('pagehide', function () {
    if (currentController) currentController.abort();
    imageObserver.disconnect();
    sentinelObserver.disconnect();
    ContentModal.close();
  }, { once: true });

  /* ===== Kick-off ====================================================== */

  loadGenres();          // chips em paralelo (não bloqueia o grid)
  loadFirstPage();       // primeira página do Trending
  smokeTestSupabase();   // FASE 6.1 — valida conectividade (não bloqueia)
  MyList.init();         // registra listener de favorites-changed (sem fetch)
  ContinueWatching.init(); // registra listener de history-changed (sem fetch)
  Auth.bind();           // FASE 7.1 — wire-up dos handlers do auth modal

  /**
   * Limpa listas do usuário no DOM e state. Chamado no SIGNED_OUT pra
   * zerar a UI antes de aguardar a próxima resolução de sessão.
   */
  function resetUserInterface() {
    MyList.clear();
    if (typeof ContinueWatching !== 'undefined' && ContinueWatching.clear) {
      ContinueWatching.clear();
    }
    if (typeof HistoryService !== 'undefined' && HistoryService.invalidate) {
      HistoryService.invalidate();
    }
  }

  /**
   * FASE 7.1 — onAuthStateChange é o ÚNICO ponto que dispara fetches
   * de dados do usuário (Favoritos, Continue Watching).
   *
   * init() dos módulos agora SOMENTE registra listeners de eventos
   * customizados — o fetch inicial acontece aqui, quando a sessão é
   * confirmada. Sem sessão real (null), getCurrentUserId() retorna null
   * e a UI é limpa via resetUserInterface().
   *
   * Eventos:
   *   - INITIAL_SESSION: boot — session = sessão do localStorage ou null.
   *   - SIGNED_IN: login/signup bem-sucedido.
   *   - SIGNED_OUT: signOut() ou JWT expirado.
   *   - TOKEN_REFRESHED: refresh automático (não muda user).
   *   - USER_UPDATED: mudou senha/email.
   */
  if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange(function (event, session) {
      console.log('[Auth] event:', event, 'user:', session && session.user && session.user.email);

      currentSession = session || null;
      Auth.updateHeaderUI(session);

      if (event === 'SIGNED_IN') {
        Auth.close();
      }

      if (event === 'SIGNED_OUT') {
        resetUserInterface();
        try { localStorage.removeItem('yverflix-history'); } catch (e) { /* noop */ }
        return;
      }

      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
        // INITIAL_SESSION: primeira resolução de sessão no boot.
        // SIGNED_IN: login bem-sucedido.
        // Em ambos, dispara fetch SOMENTE se houver sessão real.
        if (!session || !session.user) {
          resetUserInterface();
          return;
        }
        MyList.reload();
        if (typeof HistoryService !== 'undefined' && HistoryService.invalidate) {
          HistoryService.invalidate();
        }
        if (typeof ContinueWatching !== 'undefined' && ContinueWatching.reload) {
          ContinueWatching.reload();
        }
      }
    });
  }

  // FASE 6.3 — expõe pra debug no DevTools (mesmo padrão do Supabase
  // client da Fase 6.1). Não usado pelo app em runtime.
  window.YverFlix = window.YverFlix || {};
  window.YverFlix.Favorites = Favorites;
  window.YverFlix.MyList = MyList;
  window.YverFlix.Auth = Auth;
  window.YverFlix.getCurrentUserId = getCurrentUserId;
})();
