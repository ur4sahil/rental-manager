// What each utility portal looks like, and how to get from a signed-in
// session to the current bill.
//
// These are NOT scraped selectors. Every locator here is by ROLE and
// ACCESSIBLE NAME -- the same thing a person reads on screen -- because
// those survive a redesign that changes class names and DOM structure,
// which is what actually breaks scrapers. Probed live 2026-09-13.
//
// NO PLAYBOOK LOGS IN. WSSC presents a visible reCAPTCHA and Washington
// Gas runs reCAPTCHA v3; defeating either would break their terms. The
// person signs in once and the session is reused. A playbook that finds
// itself on a login page reports needs_signin and stops.

const PLAYBOOKS = {
  wssc: {
    provider: "WSSC",
    // The stored URL in the app (my.wsscwater.com/selfcare/views/public)
    // 404s. This is the entry that actually resolves.
    entry: "https://my.wsscwater.com/",
    // Any of these on the page means the session is gone. Checked BEFORE
    // anything is clicked, so an expired session never turns into a blind
    // click on a login form.
    signedOutSignals: [
      { role: "textbox", name: /User ID/i },
      { role: "button", name: /^Log In$/i },
    ],
    // Where the amount lives once signed in. Several candidates, tried in
    // order: portals move a balance between a card and a table without
    // warning, and a single brittle locator is the usual reason these
    // break silently.
    amount: [
      { labelled: /balance\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
      { labelled: /amount\s+due\s*:?\s*\$\s?([\d,]+\.\d{2})/i },
      { role: "heading", name: /amount due|balance/i },
    ],
    dueDate: [
      // Label first, bare date second. WSSC renders "Due Date: 10-05-2026"
      // with dashes, so both separators are accepted -- a slash-only
      // pattern found the amount and lost the date.
      { text: /due\s*date\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i },
      { text: /due\s+(?:by|on)?\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i },
      { text: /due\s+on\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i },
      { text: /due\s+on\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i },
      { text: /\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/ },
    ],
  },

  washington_gas: {
    provider: "Washington Gas",
    entry: "https://my.washingtongas.com/portal/",
    signedOutSignals: [
      { role: "textbox", name: /UserName/i },
      { role: "button", name: /^Log In$/i },
    ],
    amount: [
      { role: "heading", name: /amount due|current charges|balance/i },
      { labelled: /current\s+balance[^$]{0,40}\$\s?([\d,]+\.\d{2})/i },
    ],
    dueDate: [
      // Label first, bare date second. WSSC renders "Due Date: 10-05-2026"
      // with dashes, so both separators are accepted -- a slash-only
      // pattern found the amount and lost the date.
      { text: /due\s*date\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i },
      { text: /due\s+(?:by|on)?\s*:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i },
      { text: /due\s+on\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i },
      { text: /\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/ },
    ],
  },
};

module.exports = { PLAYBOOKS };
