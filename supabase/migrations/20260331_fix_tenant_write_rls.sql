-- Fix: Add explicit INSERT policies for tables where tenants write data
-- FOR ALL with USING works for SELECT/UPDATE/DELETE but INSERT needs WITH CHECK

-- Autopay: tenant can insert/update their own schedules
DROP POLICY IF EXISTS "autopay_tenant" ON autopay_schedules;
CREATE POLICY "autopay_tenant" ON autopay_schedules FOR SELECT USING (tenant = get_tenant_name(company_id));
CREATE POLICY "autopay_tenant_write" ON autopay_schedules FOR INSERT WITH CHECK (tenant = get_tenant_name(company_id));
CREATE POLICY "autopay_tenant_update" ON autopay_schedules FOR UPDATE USING (tenant = get_tenant_name(company_id));

-- Messages: tenant can insert and read their own messages
DROP POLICY IF EXISTS "messages_tenant" ON messages;
CREATE POLICY "messages_tenant_read" ON messages FOR SELECT USING (tenant = get_tenant_name(company_id));
CREATE POLICY "messages_tenant_write" ON messages FOR INSERT WITH CHECK (tenant = get_tenant_name(company_id));
