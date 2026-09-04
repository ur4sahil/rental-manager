# Two environments: test and live

Plain-language guide. Nothing here needs a technical background.

## The two sites

| | Test | Live |
|---|---|---|
| Address | `test.housify365.com` | `housify365.com` |
| Database | Its own separate copy | The real one |
| Who uses it | You, to check new work | Everyone |
| Can it email a real tenant? | **No** | Yes |
| Can it charge a real card? | **No** | Yes |
| Can it touch real bank feeds? | **No** | Yes |

The two share nothing. Anything you do on the test site — delete a
property, run an import, break a report — cannot reach the live site.

## How work flows

```
  I build a change  ->  it appears on test.housify365.com
                        you click around and check it
                        you say "ship it"
                     -> it goes live on housify365.com
```

You never run a command. You look at the test site and say yes or no.

**Database changes follow the same path.** Table and rule changes are
applied to the test database first and only reach the live one after the
test site proves them out. This is the part that matters most — a bad
database change is the one kind of mistake that is genuinely hard to undo.

## Current state (verified 2026-09-04)

- Test project `vpeewlplgxthckpidhxo`, Postgres 17.6 — an exact match for production
- Schema identical: 73 tables, 1199 columns, 185 RLS policies, 74 functions, 26 triggers, 253 indexes, 45 foreign keys
- Holds **Sahil LLC only** — 41 properties, 73 tenants, 212 accounts, 41 classes, 7,722 entries, 16,548 lines, DR = CR = $53,671,220.15
- 73 MB, well inside the free tier
- Log in with your normal email and password

## Refreshing the test data

The test database starts as a copy of the live one. It drifts as you
experiment. To reset it to a fresh copy:

```bash
export PROD_DB_URL='postgresql://postgres:<pw>@db.hoymytpyaudjvsgiiibn.supabase.co:5432/postgres'
export TEST_DB_URL='postgresql://postgres.vpeewlplgxthckpidhxo:<pw>@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
./scripts/clone-prod-to-test.sh
```

Passwords come from each project's Settings → Database, URL-encoded (`#` → `%23`, `!` → `%21`). Set `KEEP_COMPANY` to keep a different company instead of Sahil LLC.

Production is only ever read. The script refuses to run if the two
addresses match, or if the destination is the live project.

## The safety switches

The test site is kept harmless by settings, not by good intentions. Each
of these must be set on the test environment in Vercel:

| Setting | Test value | Why |
|---|---|---|
| `REACT_APP_SUPABASE_URL` / `..._ANON_KEY` | test project | points the app at the test database |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | test project | same, for the server side |
| `NOTIFICATIONS_PAUSED` | `true` | no email or push reaches a real tenant |
| `STRIPE_SECRET_KEY` / `REACT_APP_STRIPE_PUBLISHABLE_KEY` | Stripe **test** keys | cards are fake by construction |
| `PLAID_ENV` / `PLAID_SECRET` | `sandbox` | fake banks, not real accounts |
| `RESEND_API_KEY` | blank | outbound email falls back to logging |
| `STRIPE_SECRET_KEY` etc. | dead values | the live keys were scoped to Preview too, so the test site would have inherited them |

Scheduled jobs (nightly bank sync, reminders, late fees) only run on the
live site — Vercel runs crons against production deployments only, so the
test site stays quiet on its own.

**The test database holds a copy of real data**, including tenant names
and emails. That is deliberate: the bugs worth catching only show up
against real data. It also means the switches above are not optional.

## Branches

- `main` — the live site. Only ever updated by promoting from `staging`.
- `staging` — the test site. All work lands here first.

## Two things worth knowing

**Access comes from `company_members`, not `app_users`.** Every RLS policy routes
through `get_user_company_ids()`, which reads `company_members` by the email in
the JWT. An account can have an `app_users` row and still see nothing at all.
This is also why nobody can open Sahil LLC in production — it has no members.

**The migrations cannot rebuild the database.** Not one of the 15 core tables is
created by any of the 158 migration files; they were made in the dashboard
before migrations were kept, and the first migration already assumes `payments`
exists. So `supabase db push` against an empty project fails immediately, and the
schema here was copied with `pg_dump` instead. If production were lost, those
files would not restore it — Supabase's backups are the only recovery. Worth
fixing with a baseline migration, and the test database is the place to prove it.
