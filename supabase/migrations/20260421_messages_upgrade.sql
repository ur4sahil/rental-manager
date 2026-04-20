-- Messaging UI overhaul: add columns the new chat UI needs.
-- All nullable so old rows still render. `read_at` replaces the legacy
-- boolean `read` semantically (we keep the boolean in sync for any older
-- callers still flipping it). `sender_role` distinguishes staff vs tenant
-- bubbles in the thread. `attachment_url`/`attachment_name` reserve space
-- for the optional upload slot in the composer.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS sender_email    text,
  ADD COLUMN IF NOT EXISTS sender_role     text,
  ADD COLUMN IF NOT EXISTS read_at         timestamptz,
  ADD COLUMN IF NOT EXISTS attachment_url  text,
  ADD COLUMN IF NOT EXISTS attachment_name text;

-- Treat every previously-flagged row as read at its creation time so the
-- new UI's read-receipt logic matches what the user already saw.
UPDATE public.messages
  SET read_at = COALESCE(read_at, created_at)
  WHERE read = true AND read_at IS NULL;

-- Best-effort sender_role backfill. Legacy rows stored free-text in
-- `sender`; anything literally 'admin' → admin, everything else is tenant.
UPDATE public.messages SET sender_role = 'admin'
  WHERE sender_role IS NULL AND lower(sender) = 'admin';
UPDATE public.messages SET sender_role = 'tenant'
  WHERE sender_role IS NULL AND sender IS NOT NULL;

-- Conversation pane paginates by (company, tenant, created_at DESC).
CREATE INDEX IF NOT EXISTS idx_messages_company_tenant_created
  ON public.messages (company_id, tenant_id, created_at DESC);

-- Unread-count sidebar badge + per-conversation unread dot both filter on
-- read_at IS NULL — partial index keeps the scan small.
CREATE INDEX IF NOT EXISTS idx_messages_company_unread
  ON public.messages (company_id, tenant_id)
  WHERE read_at IS NULL;
