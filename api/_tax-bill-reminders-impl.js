// Vercel API Route: Property Tax Bill Reminders
// Daily cron — two responsibilities:
//   1. Scan property_tax_bills and queue email reminders at
//      30/14/7/0 day buckets before due (and 1d post-due as a safety net).
//      Tracked via last_reminder_day_bucket so we don't re-notify the
//      same bucket twice.
//   2. Year-rollforward: for each property with a county, generate the
//      next tax year's bills if we're within 60 days of that year's
//      first installment AND no bill exists yet for that year.
//
// Auth: Bearer CRON_SECRET (matches teller-sync-transactions pattern).
const { createClient } = require("@supabase/supabase-js");
const { isCronSecretBearer, cronSecretMatches } = require("./_auth");

const CRON_SECRET = process.env.CRON_SECRET || "";

const REMINDER_BUCKETS = [-1, 0, 7, 14, 30];

// Must stay in sync with src/utils/helpers.js → COUNTY_TAX_SCHEDULES;
// tests/county-schedule.test.js fails if they drift.
//
// They HAD drifted, in a way that mattered: this file billed Maryland as
// two halves (30 Sep and 31 Dec) while the app billed it as one annual
// instalment due 30 September. Maryland bills non-owner-occupied property
// annually in full by 30 September -- the semi-annual split is an election
// open to owner-occupants, which a rental portfolio is not. The app's
// version is the correct one for these properties and this file now
// matches it.
//
// If a property genuinely pays semi-annually, that belongs in
// property_taxes.billing_frequency (which exists, and is null on all 36
// Sigma rows) rather than in a jurisdiction-wide default.
// Duplicated here because the API route is Node + no bundler; the helper
// file is browser-side ESM. Keep the two in sync on schedule changes.
const COUNTY_TAX_SCHEDULES = {
  "District of Columbia|DC": [{ label: "1st half (DC)", month: 3, day: 31 }, { label: "2nd half (DC)", month: 9, day: 15 }],
  "Anne Arundel County|MD":    [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Baltimore County|MD":       [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Baltimore City|MD":         [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Calvert County|MD":         [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Charles County|MD":         [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Frederick County|MD":       [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Harford County|MD":         [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Howard County|MD":          [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Montgomery County|MD":      [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Prince George's County|MD": [{ label: "Annual (MD)", month: 9, day: 30 }],
  "St. Mary's County|MD":      [{ label: "Annual (MD)", month: 9, day: 30 }],
  "Loudoun County|VA":         [{ label: "1st half (VA)", month: 6, day: 5  }, { label: "2nd half (VA)", month: 12, day: 5 }],
  "Stafford County|VA":        [{ label: "1st half (VA)", month: 6, day: 5  }, { label: "2nd half (VA)", month: 12, day: 5 }],
  "Spotsylvania County|VA":    [{ label: "1st half (VA)", month: 6, day: 5  }, { label: "2nd half (VA)", month: 12, day: 5 }],
  "Fauquier County|VA":        [{ label: "1st half (VA)", month: 6, day: 5  }, { label: "2nd half (VA)", month: 12, day: 5 }],
  "Fredericksburg City|VA":    [{ label: "1st half (VA)", month: 12, day: 5 }, { label: "2nd half (VA)", month: 6, day: 5 }],
  "Fairfax County|VA":         [{ label: "1st half (VA)", month: 7, day: 28 }, { label: "2nd half (VA)", month: 12, day: 5 }],
  "Fairfax City|VA":           [{ label: "1st half (VA)", month: 7, day: 28 }, { label: "2nd half (VA)", month: 12, day: 5 }],
  "Arlington County|VA":       [{ label: "1st half (VA)", month: 6, day: 15 }, { label: "2nd half (VA)", month: 10, day: 5 }],
  "Alexandria City|VA":        [{ label: "1st half (VA)", month: 6, day: 15 }, { label: "2nd half (VA)", month: 11, day: 15 }],
  "Falls Church City|VA":      [{ label: "1st half (VA)", month: 12, day: 5 }, { label: "2nd half (VA)", month: 6, day: 5 }],
  "Manassas Park City|VA":     [{ label: "1st half (VA)", month: 12, day: 5 }, { label: "2nd half (VA)", month: 6, day: 5 }],
  "Prince William County|VA":  [{ label: "1st half (VA)", month: 7, day: 15 }, { label: "2nd half (VA)", month: 12, day: 5 }],
  "Manassas City|VA":          [{ label: "1st half (VA)", month: 12, day: 5 }, { label: "2nd half (VA)", month: 6, day: 5 }],
  "Richmond City|VA":          [{ label: "1st half (VA)", month: 1, day: 14 }, { label: "2nd half (VA)", month: 6, day: 14 }],
  "York County|PA":            [{ label: "County & Municipal (PA)", month: 4, day: 30 }, { label: "School District (PA)", month: 10, day: 31 }],
};

function daysBetween(todayIso, dueIso) {
  const today = new Date(todayIso + "T00:00:00Z");
  const due = new Date(dueIso + "T00:00:00Z");
  return Math.round((due - today) / 86_400_000);
}

function chooseBucket(daysUntil) {
  if (daysUntil < 0) return -1;
  if (daysUntil <= 0) return 0;
  if (daysUntil <= 7) return 7;
  if (daysUntil <= 14) return 14;
  if (daysUntil <= 30) return 30;
  return null;
}

function isoDate(y, m, d) {
  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

// Walk a schedule in order, advancing the calendar year every time a
// later installment's month is EARLIER than the previous one. Handles
// fiscal-year jurisdictions whose halves span two calendar years (e.g.
// Fredericksburg: Dec 5 then Jun 5 → Jun 5 belongs to next year).
// Keeps this file independent of utils/taxes.js so the cron still runs
// without a shared import.
// Look up a tax schedule tolerantly. MIRRORS src/utils/helpers.js →
// findCountySchedule; tests/county-schedule.test.js asserts the two agree.
//
// The table is keyed "Charles County|MD" while properties store the county
// as it was typed -- "Charles". This cron did a bare equality lookup, so on
// Sigma Housing LLC it missed 58 of 61 properties (Prince George's alone is
// 54) and counted them as out-of-area. No tax bill was ever generated for
// them and nothing said why; Maryland's 1st-half is due 30 September.
//
// Ambiguity is not resolved by guessing: Maryland has both a "Baltimore
// County" and a "Baltimore City", and a bare "Baltimore" matches both.
function findCountySchedule(county, state) {
  const st = String(state || "").trim().toUpperCase();
  const raw = String(county || "").trim().replace(/\s+/g, " ");
  if (!raw || !st) return { schedule: null, key: null, reason: "missing_input" };

  const exact = COUNTY_TAX_SCHEDULES[raw + "|" + st];
  if (exact) return { schedule: exact, key: raw + "|" + st, reason: "exact" };

  const bare = (v) => v.replace(/\s+(County|City|Parish|Borough)$/i, "").toLowerCase();
  const want = bare(raw);
  const matches = Object.keys(COUNTY_TAX_SCHEDULES).filter(k => {
    const [name, keySt] = k.split("|");
    return keySt === st && bare(name) === want;
  });
  if (matches.length === 1) {
    return { schedule: COUNTY_TAX_SCHEDULES[matches[0]], key: matches[0], reason: "normalised" };
  }
  if (matches.length > 1) return { schedule: null, key: null, reason: "ambiguous", candidates: matches };
  return { schedule: null, key: null, reason: "no_schedule_for_jurisdiction" };
}

function resolveDueDates(schedule, startingYear) {
  const out = [];
  let y = startingYear;
  let prevMonth = 0;
  for (const inst of schedule) {
    if (prevMonth && inst.month < prevMonth) y++;
    out.push({ ...inst, dueDate: isoDate(y, inst.month, inst.day) });
    prevMonth = inst.month;
  }
  return out;
}

async function rollforwardNextYear(supabase, todayIso) {
  // For each property with a county + state, check if next year's bills
  // exist. If not AND we're within 60 days of next year's first
  // installment, generate them.
  const today = new Date(todayIso + "T00:00:00Z");
  const thisYear = today.getUTCFullYear();
  const nextYear = thisYear + 1;

  // company-scope-exempt: this is a CRON job, not a user request. It scans
  // every company's properties to generate tax-bill reminders and carries
  // company_id through to each reminder it creates. There is no "current
  // company" here because there is no user -- scoping it to one would mean
  // 36 scheduled jobs instead of one, and silently missing any company
  // added afterwards.
  const { data: props } = await supabase
    .from("properties")
    .select("id, address, county, state, company_id")
    .is("archived_at", null)
    .not("county", "is", null);

  // Escrowed properties must not be billed: the mortgage servicer pays
  // those, so a reminder is a prompt to pay something already paid. 17 of
  // Sigma Housing LLC's 36 tax records are escrowed. This job built from
  // `properties` alone and had no idea.
  //
  // The same lookup carries annual_tax_amount, so a generated instalment
  // says what is owed instead of showing a blank.
  const taxByProperty = new Map();
  for (let from = 0; ; from += 1000) {
    const { data: taxRows, error: taxErr } = await supabase
      .from("property_taxes")
      .select("property_id, escrow_paid_by_lender, annual_tax_amount, billing_frequency")
      .range(from, from + 999);
    if (taxErr) break;
    (taxRows || []).forEach(t => { if (t.property_id) taxByProperty.set(t.property_id, t); });
    if (!taxRows || taxRows.length < 1000) break;
  }

  let generated = 0, skipped = 0, noSchedule = 0, escrowed = 0;

  for (const p of props || []) {
    const found = findCountySchedule(p.county, p.state);
    const schedule = found.schedule;
    if (!schedule || schedule.length === 0) {
      if (found.reason === "ambiguous") {
        // Never guess between Baltimore County and Baltimore City: filing
        // against the wrong jurisdiction's dates is worse than filing none.
        console.warn("tax rollforward: ambiguous county", p.county, p.state, found.candidates);
      }
      noSchedule++; continue;
    }

    const taxRec = taxByProperty.get(p.id);
    if (taxRec && taxRec.escrow_paid_by_lender) { escrowed++; continue; }

    // TWO years are considered, not just the next one.
    //
    // This job only ever generated `nextYear`, and only inside a 60-day
    // window before its earliest due date. That leaves no path back: if the
    // window is missed the year is never generated at all. Which is exactly
    // what happened -- when the window for 30 September 2026 opened in
    // August, the county lookup was broken, every property fell through,
    // and the gap was permanent and silent.
    //
    // The current year is therefore always a candidate (bounded to one year
    // of catch-up, so this cannot walk backwards through history), and next
    // year still enters on the 60-day window.
    const candidates = [];
    for (const inst of resolveDueDates(schedule, thisYear)) candidates.push({ ...inst, year: thisYear });
    const nextResolved = resolveDueDates(schedule, nextYear);
    const earliestNext = nextResolved
      .map(inst => new Date(inst.dueDate + "T00:00:00Z"))
      .sort((a, b) => a - b)[0];
    if (Math.round((earliestNext - today) / 86_400_000) <= 60) {
      for (const inst of nextResolved) candidates.push({ ...inst, year: nextYear });
    }
    const resolved = candidates;
    if (resolved.length === 0) { skipped++; continue; }

    // Dedup by the actual due dates we're about to write, not by
    // tax_year alone. A fiscal schedule can legitimately reuse a
    // calendar year across two cycles; tax_year is advisory.
    const candidateDates = resolved.map(r => r.dueDate);
    const { data: existing } = await supabase
      .from("property_tax_bills")
      .select("id, due_date")
      .eq("company_id", p.company_id)
      .eq("property", p.address)
      .in("due_date", candidateDates)
      .is("archived_at", null);
    const existingDates = new Set((existing || []).map(b => b.due_date));
    const toInsert = resolved.filter(r => !existingDates.has(r.dueDate));
    if (toInsert.length === 0) { skipped++; continue; }

    // Batch all installments for this property in a single insert.
    // Previously the cron made N serial inserts per property — fine at 10
    // properties, pressure at 500. One call per property is plenty.
    const rows = toInsert.map(inst => ({
      company_id: p.company_id,
      property: p.address,
      property_id: p.id || null,
      tax_year: inst.year,
      installment_label: inst.label,
      due_date: inst.dueDate,
      // Split the annual figure across however many instalments the
      // jurisdiction has, so a half-year bill does not claim the full year.
      expected_amount: taxRec && taxRec.annual_tax_amount
        ? Math.round((Number(taxRec.annual_tax_amount) / schedule.length) * 100) / 100
        : null,
      status: "pending",
      auto_generated: true,
    }));
    const { error: insErr } = await supabase.from("property_tax_bills").insert(rows);
    if (insErr) {
      console.error("rollforward insert failed for", p.address, insErr.message);
      continue;
    }
    generated += rows.length;
  }
  return { generated, skipped, noSchedule, escrowed };
}

const { setCors } = require("./_cors");

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const authHeader = req.headers.authorization || "";
  const bodySecret = (req.body && typeof req.body === "object" && req.body.cron_secret) || "";
  const isCronAuth = CRON_SECRET && CRON_SECRET.length >= 8 && (
    isCronSecretBearer(authHeader, CRON_SECRET) || cronSecretMatches(bodySecret, CRON_SECRET)
  );
  if (!isCronAuth) return res.status(401).json({ error: "Unauthorized" });

  try {
    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const todayIso = new Date().toISOString().slice(0, 10);

    // ─── 1. Year-rollforward ────────────────────────────────────────────
    const roll = await rollforwardNextYear(supabase, todayIso);

    // ─── 2. Bill-due reminders ─────────────────────────────────────────
    const lookbackIso = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const lookaheadIso = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 10);
    const { data: bills, error } = await supabase
      .from("property_tax_bills")
      .select("id, company_id, property, tax_year, installment_label, due_date, expected_amount, status, last_reminder_day_bucket")
      .is("archived_at", null)
      .eq("status", "pending")
      .gte("due_date", lookbackIso)
      .lte("due_date", lookaheadIso);
    if (error) {
      console.error("tax-bill-reminders: fetch failed", error.message);
      return res.status(500).json({ error: "Fetch failed" });
    }

    let scanned = bills.length;
    let queued = 0;
    let skippedAlreadySent = 0;
    let skippedOutOfWindow = 0;
    let skippedNoRecipients = 0;
    let errors = 0;
    // Pre-fetch members for every company that has a bill in one query
    // instead of N lookups in the loop. At 50 companies × 500 bills that's
    // 50 queries vs 500.
    const uniqueCompanyIds = [...new Set(bills.map(b => b.company_id))];
    const memberCache = new Map();
    if (uniqueCompanyIds.length > 0) {
      const { data: allMems } = await supabase.from("company_members")
        .select("company_id, user_email, role")
        .in("company_id", uniqueCompanyIds)
        .eq("status", "active")
        .in("role", ["admin", "owner", "pm", "office_assistant"]);
      for (const m of (allMems || [])) {
        if (!m.user_email) continue;
        const list = memberCache.get(m.company_id) || [];
        list.push(m.user_email);
        memberCache.set(m.company_id, list);
      }
    }

    for (const b of bills) {
      const d = daysBetween(todayIso, b.due_date);
      const bucket = chooseBucket(d);
      if (bucket === null) { skippedOutOfWindow++; continue; }

      // Don't resend same-or-wider bucket. Tighter bucket = smaller number
      // (7 < 14 < 30 < null). -1 (overdue) always fires once.
      if (b.last_reminder_day_bucket !== null && b.last_reminder_day_bucket !== undefined) {
        if (bucket >= b.last_reminder_day_bucket && bucket !== -1) { skippedAlreadySent++; continue; }
        if (bucket === -1 && b.last_reminder_day_bucket === -1) { skippedAlreadySent++; continue; }
      }

      const recipients = memberCache.get(b.company_id) || [];
      if (recipients.length === 0) { skippedNoRecipients++; continue; }

      const subjectLine = bucket === -1
        ? `OVERDUE: ${b.installment_label} for ${b.property.split(",")[0]}`
        : bucket === 0
          ? `Due today: ${b.installment_label} for ${b.property.split(",")[0]}`
          : `${b.installment_label} due in ${d} days — ${b.property.split(",")[0]}`;

      const notifData = {
        bill_id: b.id,
        property: b.property,
        installment_label: b.installment_label,
        tax_year: b.tax_year,
        due_date: b.due_date,
        expected_amount: b.expected_amount,
        days_until_due: d,
        bucket,
        subject: subjectLine,
      };

      const rows = recipients.map(email => ({
        company_id: b.company_id,
        type: "property_tax_bill_due",
        recipient_email: email.toLowerCase(),
        data: notifData,
        status: "pending",
      }));
      const { error: insErr } = await supabase.from("notification_queue").insert(rows);
      if (insErr) { errors++; console.error("insert queue", insErr.message); continue; }

      const { error: updErr } = await supabase.from("property_tax_bills")
        .update({ last_reminder_sent_at: new Date().toISOString(), last_reminder_day_bucket: bucket })
        .eq("id", b.id);
      if (updErr) { errors++; console.error("update bucket", updErr.message); }

      queued += rows.length;
    }

    return res.status(200).json({
      rollforward: roll,
      scanned,
      queued_emails: queued,
      skipped_already_sent: skippedAlreadySent,
      skipped_out_of_window: skippedOutOfWindow,
      skipped_no_recipients: skippedNoRecipients,
      errors,
    });
  } catch (e) {
    console.error("tax-bill-reminders error:", e.message);
    return res.status(500).json({ error: "Reminder scan failed" });
  }
};
