-- ============================================================================
-- YverFlix — FASE 6.2 — Tabela `favorites`
-- ----------------------------------------------------------------------------
-- Como rodar (1× só):
--   1. Abra https://supabase.com/dashboard/project/oxgibqccznmysncubkct/sql/new
--   2. Cole TODO o conteúdo deste arquivo
--   3. Click em "Run" (canto inferior direito)
-- ============================================================================

-- 1. Tabela ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.favorites (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  tmdb_id     INTEGER NOT NULL,
  media_type  TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  title       TEXT,
  poster_path TEXT,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, tmdb_id, media_type)
);

-- Índice pra leitura rápida da listagem do usuário (próxima fase: tela
-- "Minha Lista"). PostgreSQL já cria índice automático na UNIQUE constraint,
-- mas um índice dedicado em (user_id, added_at) acelera ORDER BY.
CREATE INDEX IF NOT EXISTS favorites_user_added_idx
  ON public.favorites (user_id, added_at DESC);

-- 2. Row Level Security ------------------------------------------------------
-- IMPORTANTE: nesta fase ainda usamos um user_id fixo no front
-- ('user_teste_123') porque não temos auth real. As policies abaixo são
-- PERMISSIVAS de propósito — qualquer cliente com a publishable key pode
-- ler/escrever favoritos de qualquer user_id.
--
-- Quando entrarmos em auth (Fase 6.3+) vamos:
--   1. Trocar user_id TEXT por user_id UUID REFERENCES auth.users(id)
--   2. Substituir as policies abaixo por: USING (auth.uid() = user_id)
--      → cada usuário só lê/escreve as próprias linhas.
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS favorites_select_all ON public.favorites;
CREATE POLICY favorites_select_all ON public.favorites
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS favorites_insert_all ON public.favorites;
CREATE POLICY favorites_insert_all ON public.favorites
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS favorites_delete_all ON public.favorites;
CREATE POLICY favorites_delete_all ON public.favorites
  FOR DELETE TO anon, authenticated USING (true);

-- (Sem policy de UPDATE — favoritos não são editáveis, só toggle on/off.)
