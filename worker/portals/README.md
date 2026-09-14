# Utility portal bill fetching

Fetches the current bill from WSSC and Washington Gas. **It never logs in.**

## Why not

Both portals run reCAPTCHA — WSSC shows a visible challenge, Washington Gas
runs v3 invisibly. Defeating either breaks their terms and would not be
defensible if a run went wrong on an account holding your bank details.

But the captcha guards the **login**, not the account. So you sign in once
by hand, and every run afterwards reuses that session and goes straight to
the bill. Nothing is circumvented; it is your own session.

## Once per portal

    node worker/portals/enroll.js wssc

A real browser window opens. Sign in yourself, solve the captcha, press
Enter. The session is verified (it refuses to save if you are still on the
login page) and written to `~/.housy-sessions/<portal>.json`, mode 0600.

That file is a bearer token for the account. Do not copy it around.

## Every run after

    node worker/portals/fetch-bill.js wssc

Outcomes:

| outcome | meaning |
|---|---|
| `ok` | found an amount, and a due date if one was shown |
| `needs_signin` | session expired — run enroll again |
| `not_found` | signed in, no amount — bill not issued yet, or the page changed |
| `error` | the run itself failed |

`not_found` and `changed` are deliberately separate from `error`. A bill
that has not been issued looks exactly like a page that was redesigned, and
guessing between them is how a wrong amount reaches the books.

## What it does not do

Nothing is written to `utilities` or to the ledger. A fetched amount is a
proposal that a person confirms — same rule as every other thing Housy
produces.

It also does not pay anything. Retrieval first; payment is a separate
decision with a separate gate.

## Locators

Every locator is by ROLE and ACCESSIBLE NAME — what a person reads on
screen — not by CSS class or DOM position. Those survive the redesigns that
break scrapers. Probed live 2026-09-13:

| portal | entry | sign-in marker |
|---|---|---|
| WSSC | `my.wsscwater.com/` | textbox "User ID*" |
| Washington Gas | `my.washingtongas.com/portal/` | textbox "UserName1" |

Note both differ from the URLs stored in the app: WSSC's `selfcare/views/public`
404s, and Pepco's stored link is an expired OAuth URL.
