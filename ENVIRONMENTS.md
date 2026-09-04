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

## Refreshing the test data

The test database starts as a copy of the live one. It drifts as you
experiment. To reset it to a fresh copy:

```bash
export PROD_DB_URL='...'   # live database connection string
export TEST_DB_URL='...'   # test database connection string
./scripts/clone-prod-to-test.sh
```

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
| `RESEND_API_KEY` | unset | outbound email falls back to logging |

Scheduled jobs (nightly bank sync, reminders, late fees) only run on the
live site — Vercel runs crons against production deployments only, so the
test site stays quiet on its own.

**The test database holds a copy of real data**, including tenant names
and emails. That is deliberate: the bugs worth catching only show up
against real data. It also means the switches above are not optional.

## Branches

- `main` — the live site. Only ever updated by promoting from `staging`.
- `staging` — the test site. All work lands here first.
