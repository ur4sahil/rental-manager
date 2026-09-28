// The wizard must not write stale values over newer ones.
//
// commit_property_wizard writes EIGHT tables, and reopening a COMPLETED
// wizard restored all of them from wizard_data -- a snapshot of the form as
// it was when the wizard last finished. An edit made afterwards on the
// Utilities, HOA, Loans, Insurance, Tax Bills or Tenants page was therefore
// overwritten the next time anyone saved the wizard for any reason.
//
// The tenant step was the last and worst, because fixing it exposed a second
// bug underneath: the deposit and first month's rent are de-duplicated by a
// reference built from the lease START DATE. Reading a corrected date changes
// the reference, the duplicate check misses, and the deposit posts AGAIN.
// The stale snapshot had been hiding that by writing the old date back.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

const props = fs.readFileSync(path.join(__dirname, "..", "src", "components", "Properties.js"), "utf8");

console.log("\n=== WIZARD / PAGES SYNC ===\n");

// ---- 1. the live tables are read on reopening a completed wizard ---------
assert("reopening a completed wizard reads the live tables",
  /await loadLiveWizardData\(addr\)/.test(props),
  "restoring only from wizard_data is what overwrote newer edits");

for (const [what, needle] of [
  ["hoa_payments", 'from("hoa_payments")'],
  ["utilities", 'from("utilities")'],
  ["property_loans", 'from("property_loans")'],
  ["property_insurance", 'from("property_insurance")'],
  ["property_taxes", 'from("property_taxes")'],
  ["tenants", 'from("tenants")'],
  ["leases", 'from("leases")'],
  ["recurring_journal_entries", 'from("recurring_journal_entries")'],
]) {
  const fn = props.slice(props.indexOf("async function loadLiveWizardData"),
                         props.indexOf("async function commitWizard"));
  assert(`the live read covers ${what}`, fn.includes(needle),
    `${what} is written by the commit, so it must be read back or it gets stale values`);
}

// ---- 2. the deposit posts at most once, whatever the date does ----------
// The references are DEP-T<id>-<leaseStart>. Matching them EXACTLY meant a
// corrected lease start produced a reference that was not in the posted set,
// and the deposit posted again. The prefix is stable; the date is not.
assert("the deposit check is the SHARED cross-path one",
  /const depPosted = await depositAlreadyPosted\(companyId, resTenantId\)/.test(props),
  "four places post this deposit; each having its own check is how it double-posted");

assert("first-month and prorated rent match by reference PREFIX, not the date",
  /\.like\('reference', fam \+ tPrefix \+ '%'\)/.test(props)
  && /const tPrefix = escapeFilterValue\('T' \+ resTenantId \+ '-'\)/.test(props),
  "an exact-reference check charges the first month again when the lease start moves");

assert("a FAILED posted-already lookup counts as posted",
  /r\.error \|\| \(r\.data \|\| \[\]\)\.length/.test(props),
  "treating a query error as 'nothing posted' is how a duplicate deposit gets through");

// REGRESSION GUARD. Gating these posts on 'first commit' looks like the
// obvious fix and silently breaks onboarding: "Add Tenant" on an existing
// vacant property opens the wizard with a property id ALREADY set, so a
// first-commit gate skips a genuine first deposit -- and it would also skip
// autoPostRecurringEntries, which sits in the same block and must run every
// time to catch up missed periods.
assert("the posts are NOT gated on being a first commit",
  !/isFirstCommit/.test(props),
  "savedPropertyId is set at mount for Add Tenant and every Edit; gating on it stops real postings");

assert("the recurring catch-up still runs on every commit",
  /await autoPostRecurringEntries\(companyId\)/.test(props),
  "this is what posts rent for periods between the lease start and today");

assert("the lease is treated as the authority on its own dates",
  /lease\?\.start_date \|\| primary\.lease_start/.test(props),
  "tenants carries a denormalised copy of the lease dates that can lag behind");

assert("recurring start_date is NOT overwritten from next_post_date",
  /Deliberately NOT overwriting start_date from next_post_date/.test(props),
  "next_post_date rolls forward, so copying it would drag the floor forward every save");

// ---- 3. the commit deletes only what the user removed -------------------
assert("the commit reports what the form was holding",
  /hoas_seen: seenHoaNames\.current/.test(props) && /utilities_seen: seenUtilProviders\.current/.test(props),
  "without this the RPC cannot tell 'removed' from 'added while you were editing'");

// ---- 4. an in-progress wizard still trusts its snapshot ----------------
// The live read now also runs on the in-progress resume path (so an archive-all
// commit can't wipe live rows a stale snapshot never held), but it only
// OVERRIDES the form when live rows actually exist. A genuine new draft -- work
// committed nowhere else -- has no live rows, so its snapshot is left untouched.
// That guard is the guarantee, not the absence of the call.
assert("the live read only overrides when live rows exist (new drafts keep their snapshot)",
  // 4dbc3d8 added `&& !xTouched.current` so the async load can't clobber an
  // edit made while it was in flight; the rows-exist guard is still first.
  /if \(utilRows\.length(?: && !utilTouched\.current)?\) setUtilities/.test(props) &&
  /if \(hoaRows\.length(?: && !hoaTouched\.current)?\) setHoas/.test(props),
  "an in-progress draft with nothing committed must keep its snapshot -- nothing else holds that work");

// ---- 5. an address edit in the wizard cascades BEFORE any lookup by it ---
// commit_property_wizard UPDATEs the address components, sync_addr_upd
// re-derives properties.address, and every later step keys on the NEW string.
// Without a cascade first, each lookup (tenants, leases, utilities, HOA, loans,
// insurance, taxes, acct_classes) missed and INSERTed a duplicate: a second
// tenant "Jasmine Morgan" at "7919 Mandan Rd, 303, ..." beside the original.
// A utility with an account number made it worse -- the re-insert hit
// idx_utilities_company_provider_account and the whole commit aborted.
{
  const migDir = path.join(__dirname, "..", "supabase", "migrations");
  const migs = fs.readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
  const latestDefining = (fn) => {
    const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`);
    const hits = migs.filter(f => re.test(fs.readFileSync(path.join(migDir, f), "utf8")));
    return hits.length ? hits[hits.length - 1] : null;
  };

  const wizFile = latestDefining("commit_property_wizard");
  const wiz = wizFile ? fs.readFileSync(path.join(migDir, wizFile), "utf8") : "";
  assert("latest commit_property_wizard is at or after the rename-cascade fix",
    !!wizFile && wizFile >= "20260928030000", `latest definition: ${wizFile}`);
  assert("commit_property_wizard stays SECURITY DEFINER",
    /LANGUAGE plpgsql\s+SECURITY DEFINER/.test(wiz));

  const editStart = wiz.indexOf("IF v_mode = 'edit' AND v_property_id_in IS NOT NULL THEN");
  const oldRead = wiz.search(/SELECT address INTO v_old_address FROM properties\s+WHERE id = v_property_id_in AND company_id = v_company_id\s+FOR UPDATE;/);
  const propUpdate = wiz.indexOf("UPDATE properties SET\n      address_line_1", editStart);
  const cascade = wiz.indexOf("PERFORM public._cascade_property_rename(v_company_id, v_old_address, v_address)");
  const classUpsert = wiz.indexOf("INSERT INTO acct_classes");
  const tenantLookup = wiz.indexOf("SELECT id INTO v_existing_tenant_id FROM tenants");
  const firstAddrLookup = Math.min(...[
    classUpsert, tenantLookup,
    wiz.indexOf("FROM leases"), wiz.indexOf("FROM utilities"), wiz.indexOf("FROM hoa_payments"),
    wiz.indexOf("FROM property_loans"), wiz.indexOf("FROM property_insurance"),
    wiz.indexOf("FROM property_taxes"), wiz.indexOf("FROM recurring_journal_entries"),
  ].filter(i => i >= 0));

  assert("edit mode reads the OLD address (row-locked) before the components UPDATE",
    editStart >= 0 && oldRead > editStart && propUpdate > oldRead,
    "without the pre-UPDATE read there is nothing to cascade from");
  assert("the rename cascade runs after the UPDATE and before ANY lookup by address",
    cascade > propUpdate && cascade < firstAddrLookup,
    "a lookup that runs first keys on the new address, misses, and inserts a duplicate");
  assert("the cascade only fires when the derived address actually changed",
    /v_old_address IS DISTINCT FROM v_address THEN\s+PERFORM public\._cascade_property_rename/.test(wiz));

  // The class upsert after the cascade is ON CONFLICT (company_id, name): it
  // only reuses the property's class if the cascade renamed that class.
  const casFile = latestDefining("_cascade_property_rename");
  const cas = casFile ? fs.readFileSync(path.join(migDir, casFile), "utf8") : "";
  assert("_cascade_property_rename renames acct_classes.name",
    /UPDATE acct_classes SET name = p_new\s+WHERE company_id = p_company_id AND name = p_old/.test(cas),
    `latest definition: ${casFile}; otherwise the wizard's class upsert creates a second class`);
  for (const t of ["tenants", "leases", "utilities", "hoa_payments", "property_loans",
                   "property_insurance", "property_taxes", "recurring_journal_entries"]) {
    assert(`_cascade_property_rename covers ${t}`,
      new RegExp(`UPDATE ${t}\\s+SET property = p_new WHERE company_id = p_company_id AND property = p_old`).test(cas),
      `the wizard looks ${t} up by the new address right after the cascade`);
  }

  // The client must keep sending edit mode with the numeric property id --
  // that is the only path on which the RPC knows the old address.
  assert("the wizard commit sends mode 'edit' + property_id_for_edit",
    /mode: numericPropertyId \? 'edit' : 'fresh'/.test(props) &&
    /property_id_for_edit: numericPropertyId/.test(props));
}

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
