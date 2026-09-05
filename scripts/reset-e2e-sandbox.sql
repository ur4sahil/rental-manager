-- Rebuild the E2E sandbox company as a full-fidelity copy of Sahil LLC.
--
-- Functional tests need to CREATE things — properties, tenants, payments,
-- journal entries — and a suite that only ever cancels out of forms proves
-- nothing. This gives them a company with the same 7,722-entry shape as the
-- real data to destroy freely, while Sahil LLC stays pristine as the
-- reference both for comparison and for the read-only specs.
--
-- Every id is regenerated. String references (tenants.property,
-- acct_journal_entries.property) carry over unchanged because addresses and
-- names are copied verbatim, so they still resolve inside the new company.
--
-- Idempotent: drops and recreates the sandbox each time.

\set SRC 'f56be35c-c80d-4f47-8624-cbb317f85461'
\set DST 'e2e-sandbox'

begin;
set local session_replication_role = replica;   -- no audit/balance triggers

-- ── wipe any previous sandbox ────────────────────────────────────────
do $$
declare t record;
begin
  for t in select c.table_name from information_schema.columns c
             join information_schema.tables tb
               on tb.table_schema=c.table_schema and tb.table_name=c.table_name
            where c.table_schema='public' and c.column_name='company_id'
              and tb.table_type='BASE TABLE' and c.table_name <> 'companies'
  loop
    execute format('delete from public.%I where company_id = %L', t.table_name, 'e2e-sandbox');
  end loop;
end $$;
delete from companies where id = 'e2e-sandbox';

-- ── company ──────────────────────────────────────────────────────────
insert into companies (id, name, type, company_code, address, phone, email, created_by, company_role)
select 'e2e-sandbox', 'E2E Sandbox (copy of Sahil LLC)', type, 'E2E', address, phone, email, created_by, company_role
from companies where id = :'SRC';

-- ── classes ──────────────────────────────────────────────────────────
create temp table map_class(old text primary key, new text) on commit drop;
insert into map_class select id, gen_random_uuid()::text from acct_classes where company_id = :'SRC';

insert into acct_classes (id, company_id, name, description, color, is_active)
select m.new, 'e2e-sandbox', c.name, c.description, c.color, c.is_active
from acct_classes c join map_class m on m.old = c.id
where c.company_id = :'SRC';

-- ── properties (serial id) ───────────────────────────────────────────
create temp table map_prop(old bigint primary key, addr text) on commit drop;
insert into map_prop select id, address from properties where company_id = :'SRC';

-- `address` is written explicitly: it is normally derived by the sync_addr
-- trigger, but session_replication_role=replica (which we need to keep the
-- audit and balance triggers quiet) disables that too, and the column is
-- NOT NULL.
insert into properties (company_id, address, address_line_1, address_line_2, city, state, zip, county,
                        short_name, type, status, bedrooms, bathrooms, sqft, owner_name,
                        rent, security_deposit, notes, class_id)
select 'e2e-sandbox', p.address, p.address_line_1, p.address_line_2, p.city, p.state, p.zip, p.county,
       p.short_name, p.type, p.status, p.bedrooms, p.bathrooms, p.sqft, p.owner_name,
       p.rent, p.security_deposit, p.notes, m.new
from properties p left join map_class m on m.old = p.class_id
where p.company_id = :'SRC';

-- ── tenants (serial id) ──────────────────────────────────────────────
create temp table map_tenant(old bigint primary key, nm text, prop text) on commit drop;
insert into map_tenant select id, name, property from tenants where company_id = :'SRC';

insert into tenants (company_id, name, email, phone, property, balance, lease_status,
                     move_in, move_out, rent, lease_start, lease_end_date,
                     first_name, middle_initial, last_name, is_voucher, voucher_number,
                     tenant_portion, voucher_portion)
select 'e2e-sandbox', t.name, t.email, t.phone, t.property, t.balance, t.lease_status,
       t.move_in, t.move_out, t.rent, t.lease_start, t.lease_end_date,
       t.first_name, t.middle_initial, t.last_name, t.is_voucher, t.voucher_number,
       t.tenant_portion, t.voucher_portion
from tenants t where t.company_id = :'SRC';

-- ── accounts (uuid id, tenant_id remapped by name+property) ──────────
create temp table map_acct(old uuid primary key, new uuid) on commit drop;
insert into map_acct select id, gen_random_uuid() from acct_accounts where company_id = :'SRC';

insert into acct_accounts (id, company_id, code, name, type, subtype, is_active, old_text_id, tenant_id)
select m.new, 'e2e-sandbox', a.code, a.name, a.type, a.subtype, a.is_active,
       'e2e-sandbox-' || a.code,
       (select nt.id from tenants nt join map_tenant mt on mt.old = a.tenant_id
         where nt.company_id='e2e-sandbox' and nt.name = mt.nm
           and nt.property is not distinct from mt.prop limit 1)
from acct_accounts a join map_acct m on m.old = a.id
where a.company_id = :'SRC';

-- ── journal entries (text id) ────────────────────────────────────────
create temp table map_je(old text primary key, new text) on commit drop;
insert into map_je select id, gen_random_uuid()::text from acct_journal_entries where company_id = :'SRC';

insert into acct_journal_entries (id, company_id, number, date, description, reference,
                                  property, status, transaction_type, created_at)
select m.new, 'e2e-sandbox', e.number, e.date, e.description, e.reference,
       e.property, e.status, e.transaction_type, e.created_at
from acct_journal_entries e join map_je m on m.old = e.id
where e.company_id = :'SRC';

-- ── journal lines ────────────────────────────────────────────────────
insert into acct_journal_lines (journal_entry_id, company_id, account_id, account_name,
                                debit, credit, class_id, memo, entity_type, entity_id, entity_name)
select mj.new, 'e2e-sandbox', ma.new, l.account_name,
       l.debit, l.credit, mc.new, l.memo, l.entity_type, l.entity_id, l.entity_name
from acct_journal_lines l
join map_je mj on mj.old = l.journal_entry_id
join map_acct ma on ma.old = l.account_id
left join map_class mc on mc.old = l.class_id
where l.company_id = :'SRC';

-- ── membership, so the same accounts can sign in ─────────────────────
insert into company_members (company_id, user_email, user_name, role, status, auth_user_id, invited_by)
select 'e2e-sandbox', user_email, user_name, role, status, auth_user_id, 'e2e-sandbox-reset'
from company_members where company_id = :'SRC';

insert into app_users (id, email, name, role, company_id, user_type, preferences, password_set_at, created_at)
select gen_random_uuid(), u.email, u.name, u.role, 'e2e-sandbox', u.user_type, '{}'::jsonb, now(), now()
from app_users u where u.company_id = :'SRC';

-- ── supporting records that reference properties by address string ───
-- Vendors are copied by a generic column-preserving insert rather than a
-- hand-written column list, which drifts the moment the table changes.
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema='public' and table_name='vendors'
     and column_name not in ('id','company_id');
  execute format(
    'insert into vendors (company_id, %s) select %L, %s from vendors where company_id = %L',
    cols, 'e2e-sandbox', cols, 'f56be35c-c80d-4f47-8624-cbb317f85461');
end $$;

commit;
