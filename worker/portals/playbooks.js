// What each utility portal looks like, and how to get from a signed-in
// session to the current bill.
//
// These are NOT scraped selectors. Every locator here is by ROLE and
// ACCESSIBLE NAME -- the same thing a person reads on screen -- because
// those survive a redesign that changes class names and DOM structure,
// which is what actually breaks scrapers.
//
// SIGNING IN: WHAT IS ACTUALLY TRUE, TESTED 2026-09-14
//
// This file used to say "NO PLAYBOOK LOGS IN", on the grounds that WSSC
// shows a visible reCAPTCHA and Washington Gas runs v3. That was asserted,
// never tested, and it is wrong: WSSC signs in automatically with the
// account holder's own credentials and reads the bill, with three captcha
// elements present on the page. Pepco signs in with no captcha at all.
//
// The line that matters is not "is a captcha present" but "does an honest
// sign-in work". An honest sign-in means the account holder's own
// credentials, typed into the site's own form, once, at human speed. It
// does NOT mean stealth plugins, fingerprint spoofing, rotated IPs or
// solving a challenge -- those defeat a control rather than pass it, and
// are out of scope here whatever a portal does.
//
// A playbook that finds itself on a login page and has no credentials
// still reports needs_signin and stops.
//
// ---------------------------------------------------------------------
// `verified` IS THE IMPORTANT FIELD
//
// true  = every locator below was probed against the live portal while
//         signed in, and the amount and due date were actually read.
// false = written from the shape these billing pages share, and NOT yet
//         confirmed against the real site.
//
// An unverified playbook is a hypothesis. fetch-bill reports what it
// matched and how, so the first run against a real session either confirms
// it or shows exactly which candidate missed -- and explore.js can propose
// replacements. Nothing here is trusted enough to post a payment from
// until it has been verified; pay-bill.js asserts the account and amount on
// the page regardless of what this file claims.
//
// ---------------------------------------------------------------------
// WHY THE AMOUNT AND DUE DATE ARE LISTS
//
// Portals move a balance between a card and a table without warning, and a
// single brittle locator is the usual reason these break silently. Each
// candidate is tried in order. The label-first patterns below are
// deliberately generic: "Amount Due: $123.45" and "Total Due" appear on
// nearly every utility billing page ever built, which makes them a far
// better first guess than any structural selector.
//
// ---------------------------------------------------------------------
// `aliases` EXISTS BECAUSE THE DATA IS MESSY
//
// A playbook is matched to a utility row by utilities.provider, which is
// free text a person typed. Production currently holds "Wash Gas" (2 rows)
// AND "Washington Gas" (1), plus "BGE" and "bge". Exact matching -- even
// case-insensitive -- silently skips the variants, and a skipped utility
// looks identical to one with no bill due. Every spelling that appears in
// the data is listed here.

// Shared candidate sets. A utility bill says one of a small number of
// things, so repeating fifteen regexes per portal would only invite them to
// drift apart.
// A CREDIT BALANCE IS NOT A BILL.
//
// SMECO's overview reads "No payment due  -$4.15" -- the account is in
// credit. None of the labelled patterns below match that, which is the only
// reason it was not misread: a looser "find the first dollar figure" rule
// would have reported a $4.15 bill when the utility actually owes $4.15.
// Reporting a credit as a debt is worse than reporting nothing, so the
// no-payment-due signal is checked FIRST and short-circuits to zero.
const NOTHING_DUE = [
  /no\s+(?:payment|amount|balance)\s+due/i,
  /nothing\s+due/i,
  /(?:your\s+)?balance\s+is\s+\$?0(?:\.00)?\b/i,
  /account\s+is\s+paid\s+in\s+full/i,
  /credit\s+balance/i,
];

const AMOUNT_CANDIDATES = [
  { labelled: /(?:total\s+)?amount\s+due\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  // THE DUE DATE SITS BETWEEN THE LABEL AND THE FIGURE ON OPOWER.
  //
  // Pepco and BGE (both Exelon/Opower dashboards) render the balance as
  // "Total Amount Due by 09/23/2026 $345.00" -- the due date is wedged
  // between "Amount Due" and the dollar amount, so the strict candidate
  // above (which wants the "$" right after the label) matches nothing and
  // the whole read falls through to "no amount found" on a page whose
  // balance is plainly on screen. Verified live 2026-09-22: 11411
  // Abbottswood read $345.00 only once this candidate existed.
  //
  // Deliberately anchored on "by <short date>": it will not reach past a
  // date-shaped gap to a figure elsewhere on the page (the "billing at a
  // glance" trap the whole file is careful about), because the balance is
  // always the first figure after its own label.
  { labelled: /(?:total\s+)?amount\s+due\s+by\s+[A-Za-z0-9,\/. -]{4,22}?\s*\$\s?([\d,]+\.\d{2})/i },
  { labelled: /total\s+due\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  { labelled: /current\s+(?:balance|charges)\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  { labelled: /balance\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  { labelled: /please\s+pay\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  // Role-based last: if the labels all miss, the heading tells fetch-bill
  // where on the page to look for a nearby figure.
  { role: "heading", name: /amount due|total due|balance|current charges/i },
];

// Deliberately NOT in AMOUNT_CANDIDATES: a bare negative figure only means
// a credit when something nearby says so, and matching "-$4.15" anywhere on
// a page would pick up a line item as readily as a balance.
const CREDIT_BALANCE = /(?:no\s+payment\s+due|credit\s+balance)[^$-]{0,40}(-\s?\$\s?[\d,]+\.\d{2})/i;

const DUE_DATE_CANDIDATES = [
  // Label first, bare date last. Both separators: WSSC renders
  // "Due Date: 10-05-2026" with dashes, and a slash-only pattern found the
  // amount and lost the date.
  { text: /(?:payment\s+)?due\s*(?:date)?\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i },
  { text: /due\s+(?:by|on)?\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i },
  { text: /due\s+(?:by|on)\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i },
  { text: /due\s*(?:date)?\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i },
  { text: /\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/ },
];

// Most portals put the same two words on the sign-in form. Listed so an
// expired session is recognised BEFORE anything is clicked -- a blind click
// on a login page is how a scraper starts filling in the wrong form.
const COMMON_SIGNED_OUT = [
  { role: "textbox", name: /^(user\s?name|user\s?id|email|username)/i },
  { role: "button", name: /^(log\s?in|sign\s?in)$/i },
  { role: "link", name: /^(log\s?in|sign\s?in)$/i },
];

const PLAYBOOKS = {
  // ═══════════════════════════════════════════════════════════════════
  // VERIFIED -- probed live 2026-09-13 against a signed-in session
  // ═══════════════════════════════════════════════════════════════════
  wssc: {
    provider: "WSSC",
    aliases: ["wssc", "wssc water", "washington suburban sanitary commission"],
    verified: true,
    // The stored URL in the app (my.wsscwater.com/selfcare/views/public)
    // 404s. This is the entry that actually resolves.
    entry: "https://my.wsscwater.com/",
    // WSSC is a chooser portal, not a switcher one: "My Accounts" lists every
    // account on one page with a View button per row, and the selected
    // account's Balance and Due Date render inline in its own row. Without
    // this the code looked for a switcher that does not exist and reported
    // all fourteen accounts as "not in the switcher" -- four of which were
    // plainly visible in a screenshot of the page.
    selectAccountFirst: { role: "heading", name: /my wssc water/i },
    // Clicking View EXPANDS the account inside its own row instead of
    // navigating, and the Balance and Due Date render there. So selection
    // succeeds while still "on the chooser", and extraction has to be scoped
    // to the row -- with several accounts expanded the page carries several
    // balances, and the first one belongs to somebody else's property.
    inlineChooser: true,
    signedOutSignals: [
      { role: "textbox", name: /User ID/i },
      { role: "button", name: /^Log In$/i },
    ],
    // The official statement PDF: the account row's own "View Bill" link opens
    // that account's bill page, whose "Download Bill" link downloads the PDF.
    // Row-scoped deliberately -- the page-level "View Bill" serves the default
    // account's bill.
    statementDownload: {
      viewBillLink: /view bill/i,
      downloadLink: /download bill/i,
    },
    amount: [
      { labelled: /balance\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
      { labelled: /amount\s+due\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
      { role: "heading", name: /amount due|balance/i },
    ],
    dueDate: [
      { text: /due\s*date\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i },
      { text: /due\s+(?:by|on)?\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i },
      { text: /due\s+on\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i },
      { text: /\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/ },
    ],
    // WSSC shows no account number anywhere -- the property ADDRESS beside
    // the balance is the identity. Captured so a reading is attributed to a
    // property rather than reported as "the WSSC balance", which on an
    // account holding ten properties means nothing.
    identifyBy: "address",
    addressNear: /([\dA-Z][A-Za-z0-9 .'-]{6,44}?(?:ST|AVE|DR|CT|RD|LN|PL|TER|WAY|BLVD|CIR|PKWY))[^$]{0,60}?Balance:\s*\$/i,
    // PAYING -- UNVERIFIED against the live pay form.
    //
    // WSSC is its own platform, not Exelon, so these selectors are guessed
    // from the common shape of a water-utility bill-pay page rather than a
    // shared recipe. No captcha challenge blocked the read sign-in. As
    // everywhere, pay-bill.js aborts if no selector matches -- it never falls
    // back to the full amount -- so a dry run confirms or corrects each one.
    pay: {
      payNav: /^(Make a Payment|Make Payment|Pay Bill|Pay My Bill|Pay Now)$/i,
      amountRadio: /^(Amount Due|Total Amount Due|Current Balance|Full Balance)/i,
      otherAmountRadio: [
        /^Other Amount$/i, /^Other amount/i, /^Pay Other Amount$/i,
        /^Enter Amount/i, /^Custom Amount$/i, /other\s+amount/i,
      ],
      extras: [/round\s*up/i, /donat/i],
      advance: /^(Next|Continue|Review)$/i,
      commit: /^(Submit|Confirm|Make Payment|Pay Now|Submit Payment)$/i,
    },
  },

  washington_gas: {
    provider: "Washington Gas",
    // The login holds many accounts; the sweep enumerates the portal's own
    // chooser and reads EVERY one, matching each to its Housy utility by address.
    enumerateChooser: true,
    // "Wash Gas" is what two of the three production rows actually say.
    aliases: ["washington gas", "wash gas", "washington gas light", "wgl", "wgl gas"],
    verified: true,
    entry: "https://my.washingtongas.com/portal/",
    // The login inputs carry no accessible name, so target them by id.
    loginFields: { user: "#txtLogin", pass: "#txtpwd", submit: "#btnlogin" },
    signedOutSignals: ["#txtLogin", "#btnlogin"],
    amount: [
      { role: "heading", name: /amount due|current charges|balance/i },
      { labelled: /current\s+balance[^$]{0,40}\$\s?([\d,]+\.\d{2})/i },
      { labelled: /total\s+to\s+pay\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
    ],
    dueDate: DUE_DATE_CANDIDATES,
    // Washington Gas numbers its accounts and switches between them, so a
    // reading identifies itself by account rather than by address.
    identifyBy: "account",
    // PAYING. The only portal with a pay recipe, and therefore the only one
    // the app offers a Pay button for. Kept here rather than in pay-bill.js
    // so there is ONE answer to "can this provider be paid": a second list
    // would drift, and the way it would drift is a button that promises a
    // payment nothing can carry out.
    pay: {
      payNav: /^Make Payment$/i,
      amountRadio: /^Amount Due/i,
      // PARTIAL PAYMENTS -- candidates, NOT verified against the live form.
      //
      // Every other locator in this file was confirmed against a signed-in
      // page. These were not: the payment form has only ever been reached in
      // dry runs that stopped at the full amount due, so the label Washington
      // Gas puts on its custom-amount option is unknown. These are the
      // plausible wordings, tried in order.
      //
      // Guessing is safe ONLY because pay-bill.js aborts when none matches.
      // It must never fall back to "Amount Due": that would pay the whole
      // bill when a partial was approved. Confirm these on the first dry run
      // and delete the ones that do not exist.
      otherAmountRadio: [
        /^Other Amount$/i,
        /^Other amount/i,
        /^Another Amount$/i,
        /^Pay Other Amount$/i,
        /other\s+amount/i,
      ],
      // Anything that increases what leaves the account. Both are offered by
      // this portal and both are explicitly cleared, never assumed off.
      extras: [/Washington Area Fuel Fund/i, /round up/i],
      // Multi-step: NEXT leads to a review page before the real commit.
      advance: /^(Next|Continue)$/i,
      commit: /^(Submit|Confirm|Make Payment|Pay Now)$/i,
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // UNVERIFIED -- entry URLs and locators are a starting hypothesis.
  // The first signed-in run confirms or corrects each one.
  //
  // Every one of these is an account the sweep currently SKIPS, because no
  // playbook existed. Production holds: Pepco 4 rows, BGE 6 (5 "BGE" + 1
  // "bge"), Fairfax Water 1, Dominion 1, Novec 1. No SMECO row exists yet.
  //
  // identifyBy is "address" for all of them, because not one utility row in
  // production has an account_number -- 0 of 37. Until those are filled in,
  // sweep.js reads each portal once and the reading has to say which
  // property it belongs to, or it is unattributable.
  // ═══════════════════════════════════════════════════════════════════
  pepco: {
    // Bounced to the public site = signed out. The button names drift with
    // every redesign; the hostname does not.
    signedOutUrl: /^https?:\/\/www\.pepco\.com/,
    // Pepco sessions expire within minutes; a reuse check passes and the next
    // read finds it gone. Fresh-login every sweep (B2C, no captcha, so cheap).
    noSessionReuse: true,
    // Same entry-redirect as BGE, and it hid behind a condition that made it
    // look absent: measured on a fresh session, https://secure.pepco.com/
    // lands on Pages/ChangeAccount.aspx and everything looks fine. Measured
    // again AFTER an account has been selected, the same URL redirects to
    // https://www.pepco.com/ -- the marketing homepage, which is what
    // signedOutUrl above matches.
    //
    // That is the whole reason the chooser fix has twice been written off as
    // "the session had expired". The sweep reads the first account, returns
    // to entry for the second, gets bounced to www.pepco.com, and reports an
    // expired session while the session is alive: ChangeAccount.aspx on that
    // same session still returns ten chooser rows.
    //
    // Checking it once was not enough. The first check was done in the wrong
    // state and cleared a bug that was there.
    signedInEntry: "https://secure.pepco.com/Pages/ChangeAccount.aspx",
    provider: "Pepco",
    // The login holds many accounts; the sweep enumerates the portal's own
    // chooser and reads EVERY one, matching each to its Housy utility by address.
    enumerateChooser: true,
    aliases: ["pepco", "potomac electric", "potomac electric power"],
    // VERIFIED 2026-09-14: signed in end to end and read $513.99 due
    // 09/14/2026 off the dashboard. No captcha, no MFA.
    verified: true,
    // secure.pepco.com redirects to www.pepco.com, whose Sign In link goes
    // to Exelon's Azure B2C. BGE below is the same federation, so what is
    // learned on one applies to the other.
    entry: "https://secure.pepco.com/",
    // The marketing homepage hides the login behind "Sign In", which federates
    // to Exelon's Azure B2C form (both fields on one page).
    signInClick: { role: "link", name: /^sign in$/i },
    // Azure B2C: #signInName (aria "Email or Username") + #password + "Continue".
    // "Sign In" (the marketing link) is the signed-out signal on the homepage.
    signedOutSignals: [
      { role: "textbox", name: /email or username/i },
      { role: "button", name: /^continue$/i },
      { role: "link", name: /^sign in$/i },
    ],
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
    // The dashboard prints the service address as "14302 Colonel Clagett Ct
    // Uppr Marlboro MD 20772" -- captured so a reading records against its property.
    addressNear: /(?<!\d)(\d{1,6}\s+[A-Za-z0-9 .'#-]{2,38}?\b(?:ST|STREET|AVE|AVENUE|DR|DRIVE|CT|COURT|RD|ROAD|LN|LANE|PL|PLACE|TER|TERRACE|WAY|BLVD|CIR|CIRCLE|PKWY|TURN|RUN|ROW|SQ|TRL|HWY|CV|PT|LOOP|XING|CRES))\b/i,
    // Exelon portals commonly put the balance on a dashboard card and the
    // due date only on the billing page behind this link.
    dueDateFollow: { role: "link", name: /billing|bill\s*&?\s*payment|my bill/i },
    // THE OFFICIAL STATEMENT PDF -- Pepco's own way, not WSSC's.
    //
    // The Angular dashboard has no downloadable bill. The WebForms billing
    // app does: Account History lists every issued bill in an accordion
    // ("Bill Issued 09/02/2026  $345.00  View Bill"), and each "View Bill"
    // STREAMS that bill as a PDF download (GUID-named), not a link to follow.
    // So this is a download-on-click flow, and the newest row is the current
    // statement. The page is keyed to the account selected in the chooser --
    // re-confirmed on the page before downloading, because it is a separate
    // app from the dashboard and must never file one property's bill under
    // another. Verified live 2026-09-23: six bills listed for 55037075276,
    // newest "Bill Issued 09/02/2026 $345.00", View Bill saved a real %PDF.
    statementHistory: {
      url: "https://secure.pepco.com/MyAccount/MyBillUsage/Pages/Secure/AccountHistory.aspx",
      viewBill: /^View Bill$/,
      // Each accordion header: issue date + amount + the View Bill control.
      billRow: /Bill Issued\s+(\d{2}\/\d{2}\/\d{4})\s+\$([\d,]+\.\d{2})/i,
    },
    // PAYING -- UNVERIFIED against the live pay form.
    //
    // Pepco and BGE are Exelon portals on the Opower billing UI, so this is
    // the same recipe shape as the read flow already confirmed. But the
    // payment PAGE has only been reached in read runs; these selectors are
    // candidates. Guessing is safe only because pay-bill.js aborts when none
    // matches -- it must never fall back to "Amount Due", which would pay the
    // whole bill when a partial was approved. A dry run confirms or corrects
    // each label, exactly as Washington Gas's did.
    pay: {
      // The account dashboard has a "Pay Bill" BUTTON (the nav link of the same
      // name goes to a marketing page); the generic drive prefers the button.
      payNav: /^Pay Bill$/i,
      amountRadio: /^(Amount Due|Total Amount Due|Current Balance|Pay Full Amount)/i,
      otherAmountRadio: [
        /^Other Amount$/i, /^Other amount/i, /^Pay Other Amount$/i,
        /^Enter an amount/i, /^Custom Amount$/i, /other\s+amount/i,
      ],
      // Exelon offers round-up / charity donations at checkout.
      extras: [/round\s*up/i, /donat/i, /neighbor/i, /fuel\s*fund/i],
      advance: /^(Next|Continue|Review)$/i,
      commit: /^(Submit|Confirm|Make Payment|Pay Now|Submit Payment)$/i,
    },
  },


  bge: {
    // Bounced to the public site = signed out. The button names drift with
    // every redesign; the hostname does not.
    signedOutUrl: /^https?:\/\/www\.bge\.com/,
    provider: "BGE",
    // The login holds many accounts; the sweep enumerates the portal's own
    // chooser and reads EVERY one, matching each to its Housy utility by address.
    enumerateChooser: true,
    aliases: ["bge", "baltimore gas and electric", "baltimore gas & electric"],
    // 2026-09-14: signs in through Azure B2C, then demands a verification
    // code. With the code supplied WHILE THE SESSION IS STILL OPEN it goes
    // straight through and lands on ChangeAccount.aspx -- "Select an
    // Account To View" -- because this login holds several BGE accounts.
    // So sign-in is proven; reading a bill needs an account chosen first,
    // the same shape Washington Gas has and accounts.js already handles.
    //
    // A code is single-use and bound to the session that requested it, so
    // it cannot be handed over after a run ends. Unattended sweeps need
    // either a remembered device or a person on hand.
    verified: true,
    signInOnly: true,
    mfa: "code-on-signin",
    selectAccountFirst: { role: "heading", name: /select an account/i },
    entry: "https://secure.bge.com/",
    // `entry` is where you go to SIGN IN. It is not where you go once you
    // ARE signed in, and BGE makes the difference expensive: with a valid
    // session, https://secure.bge.com/ redirects to https://www.bge.com/ --
    // the marketing homepage -- which is precisely what signedOutUrl below
    // matches. So the first account read fine (the browser was still on the
    // chooser from sign-in) and every account after it was reported
    // "session expired" while the session was perfectly good. Measured, not
    // guessed: loading the saved session and visiting entry landed on
    // www.bge.com with the heading "Welcome to BGE", while
    // /accounts/dashboard on the same session gave "My Dashboard".
    // ChangeAccount.aspx, not /accounts/dashboard. Both load fine with a
    // valid session, but the dashboard carries only a small switcher widget
    // and the sweep then reported all fourteen accounts as "not in the
    // switcher". This is the page sign-in itself lands on for a multi-account
    // login -- "Select an Account To View", with every account listed -- which
    // is the shape selectAccountFirst and accounts.js are written against.
    signedInEntry: "https://secure.bge.com/Pages/ChangeAccount.aspx",
    signInClick: { role: "link", name: /^sign in$/i },
    signedOutSignals: [
      { role: "textbox", name: /email or username/i },
      { role: "button", name: /^continue$/i },
      { role: "link", name: /^sign in$/i },
    ],
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
    // The account dashboard prints the service address as "4229 Crosswick Turn
    // Bowie MD 20715" -- captured so a reading records against its property.
    addressNear: /(?<!\d)(\d{1,6}\s+[A-Za-z0-9 .'#-]{2,38}?\b(?:ST|STREET|AVE|AVENUE|DR|DRIVE|CT|COURT|RD|ROAD|LN|LANE|PL|PLACE|TER|TERRACE|WAY|BLVD|CIR|CIRCLE|PKWY|TURN|RUN|ROW|SQ|TRL|HWY|CV|PT|LOOP|XING|CRES))\b/i,
    dueDateFollow: { role: "link", name: /billing|bill\s*&?\s*payment|my bill/i },
    // Official statement PDFs -- same Exelon WebForms flow as Pepco, on the
    // bge.com host. Account History lists every issued bill in an accordion
    // ("Bill Issued 09/21/2026 $537.18 View Bill") and each "View Bill" streams
    // that bill as a PDF download. Verified live 2026-09-23: six bills listed
    // for 0543163784, View Bill saved a real PDF. Account is re-confirmed on the
    // page before download (a separate app from the dashboard).
    statementHistory: {
      url: "https://secure.bge.com/MyAccount/MyBillUsage/Pages/Secure/AccountHistory.aspx",
      viewBill: /^View Bill$/,
      billRow: /Bill Issued\s+(\d{2}\/\d{2}\/\d{4})\s+\$([\d,]+\.\d{2})/i,
    },
    // PAYING -- UNVERIFIED, and a session needs a PERSON.
    //
    // Same Exelon/Opower pay shape as Pepco. BGE mails a verification code at
    // sign-in (mfa: "code-on-signin"), so ensure-session.js cannot create a
    // session for it unattended and refuses it by name. A payment is still
    // possible: a person runs `enroll.js bge` once, signs in with the code,
    // and ensure-session then REUSES that live session -- it only refuses
    // when it would have to sign in itself. So the Pay button is offered; the
    // requirement is a manual enroll first, not that BGE can never be paid.
    pay: {
      payNav: /^(Make a Payment|Make Payment|Pay Bill|Pay Now)$/i,
      amountRadio: /^(Amount Due|Total Amount Due|Current Balance|Pay Full Amount)/i,
      otherAmountRadio: [
        /^Other Amount$/i, /^Other amount/i, /^Pay Other Amount$/i,
        /^Enter an amount/i, /^Custom Amount$/i, /other\s+amount/i,
      ],
      extras: [/round\s*up/i, /donat/i, /neighbor/i, /fuel\s*fund/i],
      advance: /^(Next|Continue|Review)$/i,
      commit: /^(Submit|Confirm|Make Payment|Pay Now|Submit Payment)$/i,
      needsManualSession: true,
    },
  },


  smeco: {
    provider: "SMECO",
    aliases: ["smeco", "southern maryland electric", "southern maryland electric cooperative"],
    // 2026-09-14: signs in cleanly, no captcha, no MFA, lands on the Opower
    // overview for account 1354954707. Marked verified for SIGN-IN; the
    // account was in credit ("No payment due  -$4.15") so no bill amount
    // has been read off it yet.
    verified: true,
    signInOnly: true,
    // A cooperative, not an investor-owned utility, so it does not share
    // the Exelon portal shape. No SMECO utility row exists in production
    // yet -- this playbook is ready for when one is added.
    // SMECO does not host its own billing portal. The "Sign In" link on
    // smeco.coop points at Opower, which is why every smeco.coop subdomain
    // guessed earlier (myaccount, account, ebill) failed to resolve.
    entry: "https://dss-smcc.opower.com",
    signedOutSignals: COMMON_SIGNED_OUT,
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
  },

  fairfax_water: {
    provider: "Fairfax Water",
    aliases: ["fairfax water", "fairfax county water", "fcwa"],
    verified: true,
    // VERIFIED 2026-09-14: signs in and reads $306.45.
    //
    // Three things were wrong here and NONE of them was a bot control,
    // though it was recorded as one:
    //   1. headless chromium got Cloudflare's "Sorry, you have been
    //      blocked"; system Chrome loads the site fine, same machine, same
    //      IP, seconds later
    //   2. the portal is not on fairfaxwater.org at all -- "Login or
    //      Register" goes to fwcustomer.org
    //   3. the stored username had a typo (gail.com for gmail.com)
    //
    // It also hands PAYMENT off to a third-party processor (Paymentus). The
    // READING must come from fwcustomer.org; following a pay link lands on
    // a checkout whose figures belong to the checkout, not the account.
    entry: "https://www.fwcustomer.org/",
    signedOutSignals: COMMON_SIGNED_OUT,
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
  },

  dominion: {
    provider: "Dominion",
    aliases: ["dominion", "dominion energy", "dominion virginia power", "dominion power"],
    verified: false,
    // mya.dominionenergy.com was a guess and does not resolve at all
    // (ERR_NAME_NOT_RESOLVED). myaccount.dominionenergy.com answers.
    entry: "https://myaccount.dominionenergy.com/",
    signedOutSignals: COMMON_SIGNED_OUT,
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
  },

  novec: {
    provider: "Novec",
    aliases: ["novec", "northern virginia electric", "northern virginia electric cooperative"],
    verified: false,
    // Not on the original list of five, but production has a Novec row and
    // a utility with no playbook is silently skipped by the sweep.
    //
    // 2026-09-14: novec.com's "My Account" leads to My-Service.cfm, which
    // carries no login form. Novec is a cooperative and uses SmartHub --
    // the platform most co-ops use -- on its own domain, which DOES present
    // a working sign-in form with no captcha.
    //
    // The credentials on file were rejected there ("Invalid Login"). Not a
    // bot control and not a broken playbook: the username is wrong for this
    // portal. SmartHub accounts are frequently keyed to an account number
    // rather than an email. NOT retried -- repeated failures lock accounts.
    entry: "https://novec.smarthub.coop/Login.html",
    signedOutSignals: COMMON_SIGNED_OUT,
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
  },
};

// Resolve a utilities.provider string to a playbook. Matching is on the
// alias list, lower-cased and trimmed, because provider is free text a
// person typed: "Wash Gas", "bge", trailing spaces. Returns the portal KEY
// so callers can report which playbook they used.
//
// Deliberately NOT a fuzzy match. "Water" and "City Water" are real
// provider values in production that belong to neither WSSC nor Fairfax
// Water, and guessing between them would attach a reading to the wrong
// utility -- worse than reporting no playbook and being skipped.
function playbookFor(providerText) {
  const p = String(providerText || "").trim().toLowerCase();
  if (!p) return null;
  for (const [key, book] of Object.entries(PLAYBOOKS)) {
    if ((book.aliases || []).some(a => a === p)) return { key, book };
  }
  return null;
}

// Every provider spelling any playbook answers to. sweep.js asks the app
// for utility rows by provider, and it has to ask for the spellings that
// are actually in the data.
function knownProviderAliases() {
  return Object.values(PLAYBOOKS).flatMap(b => b.aliases || []);
}

// Which portals can actually be paid. The app asks this before showing a Pay
// button, so a provider we can only READ never offers one.
function payablePortals() {
  return Object.entries(PLAYBOOKS)
    .filter(([, b]) => b && b.pay)
    .map(([portal, b]) => ({ portal, provider: b.provider, aliases: b.aliases || [] }));
}

module.exports = { PLAYBOOKS, playbookFor, knownProviderAliases, payablePortals, NOTHING_DUE, CREDIT_BALANCE };
