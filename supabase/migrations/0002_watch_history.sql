-- =============================================================================
-- FASE 8 — Watch History (Persistência "Onde você parou")
-- =============================================================================
--
-- 1 row por (user_id, tmdb_id, media_type). UPSERT atualiza S/E + updated_at.
--
-- Política de RLS: permissiva por enquanto (igual favorites na 6.2). Hardening
-- com auth.uid() = user_id quando a 8.1+ for endurecer o RLS junto com
-- migration de dados do `user_teste_123` legacy.
--
-- Idempotente: pode rodar mais de uma vez sem erro.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.watch_history (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT      NOT NULL,
  tmdb_id         INTEGER   NOT NULL,
  media_type      TEXT      NOT NULL CHECK (media_type IN ('movie', 'tv')),
  title           TEXT,
  poster_path     TEXT,
  season          INTEGER,                        -- null para filme
  episode         INTEGER,                        -- null para filme
  episode_title   TEXT,                           -- nome do ep ("Pilot")
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, tmdb_id, media_type)
);

-- Index pra cobrir o "Continuar Assistindo" (top 10 por updated_at desc).
CREATE INDEX IF NOT EXISTS watch_history_user_updated_idx
  ON public.watch_history (user_id, updated_at DESC);

-- RLS permissiva (espelho da 6.2). Refinar quando entrar auth.uid() filter.
ALTER TABLE public.watch_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS watch_history_select_all ON public.watch_history;
CREATE POLICY watch_history_select_all ON public.watch_history
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS watch_history_insert_all ON public.watch_history;
CREATE POLICY watch_history_insert_all ON public.watch_history
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS watch_history_update_all ON public.watch_history;
CREATE POLICY watch_history_update_all ON public.watch_history
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS watch_history_delete_all ON public.watch_history;
CREATE POLICY watch_history_delete_all ON public.watch_history
  FOR DELETE TO anon, authenticated USING (true);
