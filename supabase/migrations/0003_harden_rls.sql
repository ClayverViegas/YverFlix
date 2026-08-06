-- ============================================================================
-- YverFlix — Hardening de RLS em `favorites` e `watch_history`
-- ----------------------------------------------------------------------------
-- Como rodar (1× só):
--   1. Abra https://supabase.com/dashboard/project/oxgibqccznmysncubkct/sql/new
--   2. Cole TODO o conteúdo deste arquivo
--   3. Click em "Run" (canto inferior direito)
-- ----------------------------------------------------------------------------
-- POR QUÊ: as policies das migrations 0001/0002 eram `USING (true)` —
-- permissivas "de propósito" enquanto não havia auth real. Isso significa
-- que qualquer cliente com a publishable key (que é pública, embutida no
-- app.js) pode ler/escrever/apagar os favoritos e o histórico de QUALQUER
-- usuário, bastando trocar o `user_id` na chamada REST — o filtro por dono
-- só existia no front (getCurrentUserId()).
--
-- Agora que a auth real (FASE 7.1) está em produção, trocamos a policy para
-- exigir `auth.uid() = user_id`: cada usuário só enxerga/mexe nas próprias
-- linhas, e requisições anônimas (`anon`) deixam de ter qualquer acesso.
--
-- NOTA: `user_id` continua TEXT (não alteramos o tipo da coluna) — a
-- comparação faz cast de auth.uid() (uuid) para text. Linhas legadas com
-- user_id = 'user_teste_123' (se existirem) ficam órfãs/inacessíveis a
-- partir daqui, já que nenhum auth.uid() real bate com esse valor — isso é
-- intencional (dado de teste, não de usuário real).
-- ============================================================================

-- 1. favorites -----------------------------------------------------------

DROP POLICY IF EXISTS favorites_select_all ON public.favorites;
DROP POLICY IF EXISTS favorites_insert_all ON public.favorites;
DROP POLICY IF EXISTS favorites_delete_all ON public.favorites;

CREATE POLICY favorites_select_own ON public.favorites
  FOR SELECT TO authenticated USING (auth.uid()::text = user_id);

CREATE POLICY favorites_insert_own ON public.favorites
  FOR INSERT TO authenticated WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY favorites_delete_own ON public.favorites
  FOR DELETE TO authenticated USING (auth.uid()::text = user_id);

-- 2. watch_history ---------------------------------------------------------

DROP POLICY IF EXISTS watch_history_select_all ON public.watch_history;
DROP POLICY IF EXISTS watch_history_insert_all ON public.watch_history;
DROP POLICY IF EXISTS watch_history_update_all ON public.watch_history;
DROP POLICY IF EXISTS watch_history_delete_all ON public.watch_history;

CREATE POLICY watch_history_select_own ON public.watch_history
  FOR SELECT TO authenticated USING (auth.uid()::text = user_id);

CREATE POLICY watch_history_insert_own ON public.watch_history
  FOR INSERT TO authenticated WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY watch_history_update_own ON public.watch_history
  FOR UPDATE TO authenticated USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY watch_history_delete_own ON public.watch_history
  FOR DELETE TO authenticated USING (auth.uid()::text = user_id);
