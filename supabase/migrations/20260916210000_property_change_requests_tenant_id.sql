-- A tenant-archive request has to name the tenant, not describe them.
--
-- Staff archive requests were filed as request_type 'delete_tenant' with the
-- tenant's NAME written into the `address` column and nothing else. Approving
-- one therefore had to guess which person was meant -- and this database holds
-- five groups of same-name tenants, so guessing is not theoretical.
--
-- tenants.id is integer, not uuid.
alter table public.property_change_requests
  add column if not exists tenant_id integer;

-- A column holding a reference to another table gets a real FK. Tenants are
-- soft-deleted (archived_at), so this rarely fires -- but nothing else stops a
-- request pointing at a row id that no longer exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'property_change_requests_tenant_id_fkey'
  ) then
    alter table public.property_change_requests
      add constraint property_change_requests_tenant_id_fkey
      foreign key (tenant_id) references public.tenants(id)
      on update cascade on delete set null;
  end if;
end $$;

create index if not exists idx_pcr_pending_tenant
  on public.property_change_requests (company_id, tenant_id)
  where status = 'pending';

comment on column public.property_change_requests.tenant_id is
  'For request_type=delete_tenant: the tenant to archive. Null on rows filed before 2026-09-16, which carry the tenant NAME in `address` and must be resolved by name -- refusing when ambiguous.';
