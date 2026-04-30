# YverFlix

Streaming MVP em **Vanilla JavaScript** (sem frameworks, sem build) consumindo
a [TMDB API](https://www.themoviedb.org/) + player via iframe da
`superflixapi.online`.

> Preparado para ser plugado em um backend (Django) no futuro — toda a camada
> de serviço está isolada na seção 3 de `app.js`.

## Demo local

```bash
git clone https://github.com/ClayverViegas/YverFlix.git
cd YverFlix
python3 -m http.server 8080
# abrir http://localhost:8080
```

Sem `npm install`, sem build step, sem dependência externa de runtime.

## Stack

- HTML5 semântico + `<template>` cloning
- CSS3 com variáveis, `aspect-ratio`, `backdrop-filter: blur`, grid
- JavaScript (IIFE + `'use strict'`, ES2017+)
- Fetch API com timeout, retry e `AbortController`
- IntersectionObserver (lazy-load de imagens **e** infinite scroll)

## Funcionalidades

### Fase 1 — Catálogo
- Trending semanal (`/trending/all/week`)
- Grid responsivo com pôsteres lazy-loaded
- Skeleton shimmer durante o carregamento
- Estado de erro com botão de retry

### Fase 2 — Player
- Modal Netflix-style com `backdrop-filter: blur`
- Iframe injetado dinamicamente (`/filme/{id}` ou `/serie/{id}`)
- Cleanup completo ao fechar (`src='about:blank'` + `removeChild` → corta áudio/banda)
- Body scroll lock + foco trap + ESC fecha + clique no backdrop fecha
- Timeout de 12s com fallback "Player indisponível"

### Fase 3 — Busca
- Input pílula com ícone SVG inline e botão de limpar
- Debounce de 500ms (`input` event)
- `/search/multi` filtrando movie/tv
- AbortController cancela request anterior a cada nova tecla
- Atalho `/` foca a busca
- Volta automaticamente pra Home quando o input é limpo

### Fase 4 — Escalabilidade
- **Infinite scroll** com IntersectionObserver (`rootMargin: 400px`) para Home, busca e gênero
- **Filtros por gênero** (chips) carregados de `/genre/movie/list`
- **Estado central unificado** (`mode | search | genre`, mutuamente exclusivos)
- Reset automático de `page=1` + grid limpo ao trocar de modo
- Spinner inferior "Carregando mais…" para `page ≥ 2` (page 1 usa skeletons)

## Arquitetura

```
app.js  (1 arquivo, IIFE)
├── 1. CONFIG               — API key, base URLs, timeouts
├── 2. HTTP layer           — fetchWithTimeout + retry + AbortController
├── 3. TMDB Service         — getTrending, searchMulti, getMovieGenres,
│                              getByGenre, normalizeMedia, assertApiKey
├── 4. UI / Render          — renderCards, appendCards, createCard,
│                              showSkeletons, showError, observer de imagens
├── 5. PlayerModal          — open/close, iframe lifecycle, cleanup completo
└── 6. Bootstrap            — estado central, loadFirstPage, loadMore,
                              sentinel observer, chips, search wiring
```

## Configuração

A API key da TMDB está em `CONFIG.TMDB_API_KEY` no `app.js`. Para produção,
mover para um backend (Django) que faça proxy das chamadas.

## Decisões técnicas notáveis

- **Sem `<dialog>` nativo:** modal usa `<div role="dialog">` para controle total
  de focus trap e backdrop com blur.
- **`AbortController` único** no PlayerModal: agrupa todos os listeners do modal —
  1 `abort()` desliga tudo no `close()`.
- **Sentinel pattern** para infinite scroll: invisível (`height: 1px`),
  observado com `rootMargin: '400px 0px'` para começar a carregar antes do
  usuário chegar no final.
- **Image observer compartilhado:** uma única instância de IntersectionObserver
  para TODAS as imagens lazy do app. Re-observar imagens já observadas é no-op.
- **Reset de modo aborta request anterior:** `currentController.abort()` antes
  de cada nova chamada → evita race conditions de search-as-you-type.

## Roadmap

- [ ] Backend Django com cache + proxy da TMDB
- [ ] Autenticação de usuário e watchlist
- [ ] Player próprio (sem iframe externo)
- [ ] PWA com Service Worker

## Créditos

- Catálogo: [TMDB](https://www.themoviedb.org/) (este produto usa a API mas não
  é endossado nem certificado pela TMDB).
- Stream: `superflixapi.online`.
