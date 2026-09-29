// Second safety net for scheduled jobs: "is this record's PROPERTY deleted?"
//
// Deleting a property archives its utilities, utility accounts, unpaid bills,
// taxes, pending tax bills and licences (archive_property_cascade). But a row
// written after the delete, a row the delete could not match, or a property
// deleted before that function existed can still be live under an archived
// property. The tax-bill cron, the licence reminders and the utility sweep
// all run unattended, so each also skips anything whose property is archived.
//
// Records name their property by address text (property_id is often null),
// and an address can be re-used: a property deleted as a mistaken entry is
// commonly re-added at the same address. So a record is treated as belonging
// to an archived property only when its address (or id) matches an archived
// property AND no LIVE property of the same company has that address.
//
// Not a route: the leading underscore keeps Vercel from deploying it.

const PAGE = 1000;

// Addresses are typed by people and copied between tables, so compare them
// loosely: case, surrounding/doubled spaces and commas do not make a
// different property ("1 main st  md" == "1 Main St, MD").
function normAddress(a) {
  return String(a || "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

async function loadPropertyArchiveIndex(sb, companyIds) {
  const ids = [...new Set((companyIds || []).filter(Boolean))];
  const live = new Set();          // company|address
  const archivedAddr = new Set();  // company|address
  const archivedIds = new Set();   // property id (string)
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    for (let from = 0; ; from += PAGE) {
      // company-scope-exempt: a CRON / worker helper with the service key
      // and no signed-in user. It is scoped by .in("company_id", <the
      // companies whose records the job is about to act on>) and returns
      // only an archived/live verdict, never the rows themselves.
      const { data, error } = await sb.from("properties")
        .select("id, company_id, address, archived_at")
        .in("company_id", chunk)
        .order("id")
        .range(from, from + PAGE - 1);
      // This is the SECOND net (the delete itself archives the records), so
      // a failed read must not silence every reminder in the run: log it and
      // filter nothing, rather than abort the job.
      if (error) {
        console.error("property archive lookup failed:", error.message);
        return { ok: false, isArchived: () => false };
      }
      for (const p of data || []) {
        const key = p.company_id + "|" + normAddress(p.address);
        if (p.archived_at) { archivedAddr.add(key); archivedIds.add(String(p.id)); }
        else live.add(key);
      }
      if (!data || data.length < PAGE) break;
    }
  }
  return {
    ok: true,
    // rec: { company_id, property?, property_id? }
    isArchived(rec, companyId) {
      const cid = rec.company_id || companyId;
      const key = cid + "|" + normAddress(rec.property);
      if (rec.property && live.has(key)) return false;
      if (rec.property && archivedAddr.has(key)) return true;
      if (rec.property_id != null && archivedIds.has(String(rec.property_id))) return true;
      return false;
    },
  };
}

module.exports = { loadPropertyArchiveIndex, normAddress };
