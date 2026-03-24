-- Allow reading system templates (sentinel company_id) for template cloning
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'doc_templates' AND schemaname = 'public') THEN
    DROP POLICY IF EXISTS "doc_templates_system_read" ON doc_templates;
    CREATE POLICY "doc_templates_system_read" ON doc_templates FOR SELECT
      USING (company_id = '00000000-0000-0000-0000-000000000000' OR company_id IN (
        SELECT cm.company_id FROM company_members cm
        WHERE lower(cm.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
        AND cm.status = 'active'
      ));
  END IF;
END $$;
