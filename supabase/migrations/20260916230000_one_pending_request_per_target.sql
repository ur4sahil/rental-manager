-- One pending request per thing, not one per click.
--
-- Sanya filed six archive requests for the same tenant. Three before
-- tenant_id existed (19:45, 20:02, 20:22), all approved by a handler that had
-- no branch for them and therefore did nothing; then three more inside eight
-- seconds (21:16:01, :06, :09) -- not a double-click but someone clicking
-- again because nothing appeared to happen. One was approved and archived the
-- tenant; the other two sat pending, asking for something already done.
--
-- Partial, so the constraint applies only while a request is PENDING. Once
-- approved or rejected it stops blocking, which is what lets a restored
-- tenant be archived again later and lets a rejected request be re-filed once
-- whatever caused the rejection is fixed. Verified both ways against the test
-- database: the second identical insert raises 23505, and re-filing after a
-- rejection is allowed.
--
-- NOT for use with ON CONFLICT. A partial unique index cannot serve it unless
-- the statement repeats the WHERE predicate, and PostgREST's onConflict=
-- cannot express one -- that mistake broke every reconciliation save earlier
-- today. These back plain inserts, so a duplicate surfaces as 23505 and the
-- client turns it into "already waiting for approval".
create unique index if not exists idx_pcr_one_pending_per_tenant
  on public.property_change_requests (company_id, request_type, tenant_id)
  where status = 'pending' and tenant_id is not null;

create unique index if not exists idx_pcr_one_pending_per_property
  on public.property_change_requests (company_id, request_type, property_id)
  where status = 'pending' and property_id is not null;
