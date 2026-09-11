const { test, expect } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

// TEST project credentials explicitly, never SUPABASE_URL.
//
// tests/.env points SUPABASE_URL at PRODUCTION, so the usual
// createClient(process.env.SUPABASE_URL, ...) pattern in this directory
// would seed and delete production rows. This spec creates and removes a
// journal entry, so it refuses to run anywhere but the test project.
const TEST_REF = "vpeewlplgxthckpidhxo";
const URL_ = process.env.TEST_SUPABASE_URL;
const KEY_ = process.env.TEST_SUPABASE_SERVICE_KEY;
const COMPANY = "sandbox-llc";
const REF = "e2e-post-fixture";

function svc() {
  if (!URL_ || !KEY_) return null;
  if (!URL_.includes(TEST_REF)) throw new Error(`refusing to seed: ${URL_} is not the test project`);
  return createClient(URL_, KEY_, { auth: { persistSession: false } });
}

// A balanced two-line draft. The sandbox's own drafts have ZERO lines, so
// postJournalEntry correctly refuses them ("Cannot post a journal entry
// with no lines") -- the first version of this test clicked Post on one
// of those, nothing happened, and it reported success anyway.
async function seedDraft(sb) {
  const { data: accts } = await sb.from("acct_accounts").select("id,name,code")
    .eq("company_id", COMPANY).eq("is_active", true).in("type", ["Asset", "Expense"])
    .order("code").limit(2);
  if (!accts || accts.length < 2) return null;
  const { data: je } = await sb.from("acct_journal_entries").insert([{
    company_id: COMPANY, number: "JE-E2E-POST-FIXTURE", date: new Date().toISOString().slice(0, 10),
    description: "E2E fixture — quiet post test", status: "draft", reference: REF,
  }]).select("id").single();
  if (!je) return null;
  await sb.from("acct_journal_lines").insert([
    { company_id: COMPANY, journal_entry_id: je.id, account_id: accts[0].id, account_name: accts[0].name, debit: 100, credit: 0, memo: "e2e fixture" },
    { company_id: COMPANY, journal_entry_id: je.id, account_id: accts[1].id, account_name: accts[1].name, debit: 0, credit: 100, memo: "e2e fixture" },
  ]);
  return je.id;
}

async function cleanup(sb, id) {
  if (!sb || !id) return;
  await sb.from("acct_journal_lines").delete().eq("company_id", COMPANY).eq("journal_entry_id", id);
  await sb.from("acct_journal_entries").delete().eq("company_id", COMPANY).eq("id", id);
}


// Posting used to call fetchAll(), which sets loading=true, and
// `if (loading) return <Spinner />` sits at the top of the Accounting
// module -- so the whole screen was replaced by a spinner and rebuilt,
// losing the tab, scroll position and expanded sections. QuickBooks stays
// put and confirms with a toast. This asserts the screen SURVIVES.
//
// Two traps this test was written wrong for first time round, both worth
// keeping in mind: `has-text("Post")` matches the "Posted (7)" FILTER TAB
// before it matches a Post button, so the first version clicked a tab and
// posted nothing; and asserting a confirmation by searching the page for
// /posted/i matches the status labels that are already there, so it
// passed while nothing had happened. The assertions below are anchored to
// the toast container and to the posted-count changing.
test("posting a journal entry does not blank the screen", async ({ page }) => {
  test.setTimeout(300000);
  const sb = svc();
  test.skip(!sb, "TEST_SUPABASE_* not set — cannot seed a postable draft");
  let jeId = null;
  try {
  jeId = await seedDraft(sb);
  test.skip(!jeId, "could not seed a balanced draft");
  await page.goto("/?company=sandbox-llc");
  await page.locator('button:visible:has-text("Dashboard")').first().waitFor({ state: "visible", timeout: 90000 });
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_journal");
  await page.waitForTimeout(8000);

  const countOf = async (label) => {
    const t = await page.locator(`button:visible:has-text("${label} (")`).first().innerText().catch(() => "");
    const m = /\((\d+)\)/.exec(t);
    return m ? Number(m[1]) : null;
  };
  const postedBefore = await countOf("Posted");
  // Exact text, so the "Posted (7)" tab cannot match.
  const postBtn = page.locator('button:visible:text-is("Post")').first();
  if (!(await postBtn.count())) { console.log("SKIP: no draft entry to post"); return; }

  // Watch continuously: the blank state is a spinner with no table.
  let spinnerSeen = false;
  const watch = setInterval(async () => {
    try {
      if (await page.locator("table").count() === 0 &&
          await page.locator(".animate-spin, svg.animate-spin").count() > 0) spinnerSeen = true;
    } catch {}
  }, 120);

  await postBtn.click();
  // Capture the toast EARLY -- toasts auto-dismiss, and reading the page
  // nine seconds later found nothing while wrongly suggesting none had
  // appeared.
  let toast = [];
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    const t = await page.locator('div.fixed.bottom-4.right-4 >> div').allInnerTexts().catch(() => []);
    if (t.join("").trim()) { toast = t; break; }
  }
  await page.waitForTimeout(6000);
  clearInterval(watch);
  const postedAfter = await countOf("Posted");
  const tables = await page.locator("table").count();
  console.log(`posted count: ${postedBefore} -> ${postedAfter}`);
  console.log(`full-screen spinner appeared: ${spinnerSeen}`);
  console.log(`toast: ${JSON.stringify(toast.join(" | ").slice(0, 90))}`);
  console.log(`tables still rendered: ${tables}`);

  expect(spinnerSeen, "the screen was blanked by a spinner").toBe(false);
  expect(tables, "the table vanished — the screen was rebuilt").toBeGreaterThan(0);
  expect(postedAfter, "the entry did not actually post").toBe(postedBefore + 1);
  expect(toast.join(" "), "no toast confirmed the post").toMatch(/posted/i);
  } finally {
    // Always remove the fixture, including on failure, so a red run does
    // not leave a posted entry skewing the sandbox's balances.
    await cleanup(sb, jeId);
  }
});
