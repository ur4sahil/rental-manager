// What each utility portal looks like, and how to get from a signed-in
// session to the current bill.
//
// These are NOT scraped selectors. Every locator here is by ROLE and
// ACCESSIBLE NAME -- the same thing a person reads on screen -- because
// those survive a redesign that changes class names and DOM structure,
// which is what actually breaks scrapers.
//
// NO PLAYBOOK LOGS IN. WSSC presents a visible reCAPTCHA and Washington
// Gas runs reCAPTCHA v3; defeating either would break their terms. The
// person signs in once and the session is reused. A playbook that finds
// itself on a login page reports needs_signin and stops.
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
const AMOUNT_CANDIDATES = [
  { labelled: /(?:total\s+)?amount\s+due\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  { labelled: /total\s+due\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  { labelled: /current\s+(?:balance|charges)\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  { labelled: /balance\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  { labelled: /please\s+pay\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
  // Role-based last: if the labels all miss, the heading tells fetch-bill
  // where on the page to look for a nearby figure.
  { role: "heading", name: /amount due|total due|balance|current charges/i },
];

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
    signedOutSignals: [
      { role: "textbox", name: /User ID/i },
      { role: "button", name: /^Log In$/i },
    ],
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
  },

  washington_gas: {
    provider: "Washington Gas",
    // "Wash Gas" is what two of the three production rows actually say.
    aliases: ["washington gas", "wash gas", "washington gas light", "wgl", "wgl gas"],
    verified: true,
    entry: "https://my.washingtongas.com/portal/",
    signedOutSignals: [
      { role: "textbox", name: /UserName/i },
      { role: "button", name: /^Log In$/i },
    ],
    amount: [
      { role: "heading", name: /amount due|current charges|balance/i },
      { labelled: /current\s+balance[^$]{0,40}\$\s?([\d,]+\.\d{2})/i },
      { labelled: /total\s+to\s+pay\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
    ],
    dueDate: DUE_DATE_CANDIDATES,
    // Washington Gas numbers its accounts and switches between them, so a
    // reading identifies itself by account rather than by address.
    identifyBy: "account",
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
    provider: "Pepco",
    aliases: ["pepco", "potomac electric", "potomac electric power"],
    verified: false,
    // Pepco is an Exelon utility; secure.pepco.com is the account portal
    // rather than the marketing site. Exelon's siblings (BGE below) share
    // this shape, which is why their locators are identical -- if one is
    // wrong, both are, and that is worth knowing in one go.
    entry: "https://secure.pepco.com/",
    signedOutSignals: COMMON_SIGNED_OUT,
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
    // Exelon portals commonly put the balance on a dashboard card and the
    // due date only on the billing page behind this link.
    dueDateFollow: { role: "link", name: /billing|bill\s*&?\s*payment|my bill/i },
  },

  bge: {
    provider: "BGE",
    aliases: ["bge", "baltimore gas and electric", "baltimore gas & electric"],
    verified: false,
    entry: "https://secure.bge.com/",
    signedOutSignals: COMMON_SIGNED_OUT,
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
    dueDateFollow: { role: "link", name: /billing|bill\s*&?\s*payment|my bill/i },
  },

  smeco: {
    provider: "SMECO",
    aliases: ["smeco", "southern maryland electric", "southern maryland electric cooperative"],
    verified: false,
    // A cooperative, not an investor-owned utility, so it does not share
    // the Exelon portal shape. No SMECO utility row exists in production
    // yet -- this playbook is ready for when one is added.
    entry: "https://myaccount.smeco.coop/",
    signedOutSignals: COMMON_SIGNED_OUT,
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
  },

  fairfax_water: {
    provider: "Fairfax Water",
    aliases: ["fairfax water", "fairfax county water", "fcwa"],
    verified: false,
    // Fairfax Water hands payment off to a third-party processor
    // (Paymentus). The READING should come from their own account pages;
    // a playbook that follows a pay link ends up on a processor page whose
    // figures belong to a checkout, not to the account.
    entry: "https://www.fairfaxwater.org/",
    signedOutSignals: COMMON_SIGNED_OUT,
    amount: AMOUNT_CANDIDATES,
    dueDate: DUE_DATE_CANDIDATES,
    identifyBy: "address",
  },

  dominion: {
    provider: "Dominion",
    aliases: ["dominion", "dominion energy", "dominion virginia power", "dominion power"],
    verified: false,
    entry: "https://mya.dominionenergy.com/",
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
    entry: "https://www.novec.com/",
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

module.exports = { PLAYBOOKS, playbookFor, knownProviderAliases };
