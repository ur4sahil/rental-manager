// The clock (Phase 5): what needs attention, the morning email, automatic
// reminders to signers, and when late fees run.
import fs from "fs";
import { createRequire } from "module";
import { CLOCK_KINDS, clockAction, clockCounts, clockSummary, sortClockItems, clockPage, clockKindsPresent } from "../src/utils/leaseClockRules.js";

const require = createRequire(import.meta.url);
// The job's pure parts. Requiring it must not need any environment.
const job = require("../api/_lease-clock-impl.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

const item = (o) => ({ item_key: "k" + Math.random(), kind: "renewal_due", severity: "normal", title: "T", detail: "D", due_date: null, tenant_id: null, lease_id: null, prospect_id: null, doc_id: null, ...o });

// ── where each line takes you
let a = clockAction(item({ kind: "renewal_due", tenant_id: 7 }));
ok("a lease ending opens that tenant", a.page === "tenants" && a.action.openTenantId === 7);
ok("a lease ending with no tenant on record still goes somewhere", clockAction(item({ kind: "renewal_due" })).page === "leases");
a = clockAction(item({ kind: "unsigned_doc", prospect_id: "p1", tenant_id: 7 }));
ok("an unsigned prospect lease opens the prospect, not a tenant", a.page === "prospects" && a.action.openProspectId === "p1");
ok("an unsigned tenant document opens the tenant", clockAction(item({ kind: "unsigned_doc", tenant_id: 9 })).action.openTenantId === 9);
ok("an unsigned document tied to nobody opens the Document Builder", clockAction(item({ kind: "unsigned_doc" })).page === "doc_builder");
ok("tenant id 0 is a tenant, not 'nobody'", clockAction(item({ kind: "unsigned_doc", tenant_id: 0 })).page === "tenants");
a = clockAction(item({ kind: "prospect_not_converted", prospect_id: "p2" }));
ok("a prospect whose start date has come opens the prospect", a.page === "prospects" && a.action.openProspectId === "p2");
a = clockAction(item({ kind: "deposit_statement_due", tenant_id: "12", lease_id: "L1" }));
ok("a deposit statement due starts the statement for that tenant and lease, and comes back to the dashboard", a.page === "doc_builder" && a.action.templateKey === "deposit_disposition" && a.action.tenantId === 12 && a.action.leaseId === "L1" && a.action.returnTo.page === "dashboard");
a = clockAction(item({ kind: "move_out_due", tenant_id: 5 }));
ok("a move-out due opens the move-out with the tenant chosen", a.page === "moveout" && a.action.tenantId === 5);
a = clockAction(item({ kind: "late_notice_due", tenant_id: 5 }));
ok("a late fee with no notice starts the late notice", a.page === "doc_builder" && a.action.templateKey === "late_fee_notice" && a.action.tenantId === 5);
ok("a failed lease change opens the tenant", clockAction(item({ kind: "lease_change_failed", tenant_id: 3 })).page === "tenants");
ok("an unknown kind, or nothing, has no button", clockAction(item({ kind: "something_new" })) === null && clockAction(null) === null);
ok("a kind that needs a tenant has no button without one", clockAction(item({ kind: "move_out_due" })) === null && clockAction(item({ kind: "late_notice_due" })) === null && clockAction(item({ kind: "deposit_statement_due" })) === null);
ok("every kind the database can return has a label", ["renewal_due", "unsigned_doc", "prospect_not_converted", "deposit_statement_due", "move_out_due", "lease_change_failed", "late_notice_due"].every(k => CLOCK_KINDS[k] && CLOCK_KINDS[k].label));

// ── counting and order
const list = [item({ item_key: "a", severity: "normal", due_date: "2026-12-01" }), item({ item_key: "b", severity: "overdue", due_date: "2026-09-01" }), item({ item_key: "c", severity: "high" }), item({ item_key: "d", severity: "high", due_date: "2026-10-05" }), item({ item_key: "e", severity: "overdue", due_date: "2026-08-01" })];
let c = clockCounts(list);
ok("counts by urgency", c.overdue === 2 && c.high === 2 && c.normal === 1 && c.total === 5);
ok("an unknown urgency counts as coming up, a hole in the list is skipped", clockCounts([item({ severity: "weird" }), null]).normal === 1 && clockCounts([null]).total === 0);
ok("the summary names only what is not zero", clockSummary(list) === "2 overdue, 2 soon, 1 coming up" && clockSummary([item({ severity: "high" })]) === "1 soon" && clockSummary([]) === "");
ok("most urgent first; then the earliest date; undated last", sortClockItems(list).map(i => i.item_key).join("") === "ebdca", sortClockItems(list).map(i => i.item_key).join(""));
ok("sorting does not reorder the caller's list", list[0].item_key === "a");
ok("equal lines keep the order the database gave", sortClockItems([item({ item_key: "x", severity: "high" }), item({ item_key: "y", severity: "high" })]).map(i => i.item_key).join("") === "xy");

// ── what is drawn
const many = Array.from({ length: 9 }, (_, n) => item({ item_key: "u" + n, kind: n < 7 ? "unsigned_doc" : "renewal_due" }));
let p = clockPage(many);
ok("six lines to begin with, the rest counted", p.shown.length === 6 && p.hidden === 3 && p.total === 9);
ok("expanded shows everything", clockPage(many, { expanded: true }).shown.length === 9 && clockPage(many, { expanded: true }).hidden === 0);
p = clockPage(many, { kind: "renewal_due" });
ok("a filter shows only that kind", p.shown.length === 2 && p.hidden === 0 && p.shown.every(i => i.kind === "renewal_due"));
ok("an empty list draws nothing", clockPage([]).shown.length === 0 && clockPage(null).total === 0);
const kinds = clockKindsPresent(many);
ok("the filter chips list the kinds present, biggest first", kinds.length === 2 && kinds[0].kind === "unsigned_doc" && kinds[0].count === 7 && kinds[1].label === "Lease ending");

// ── the morning email: said once
const items = [item({ item_key: "renewal:1:90" }), item({ item_key: "unsigned:2" }), item({ item_key: "moveout:3" })];
ok("only what has not been said before is new", job.pickNew(items, ["unsigned:2"]).map(i => i.item_key).join() === "renewal:1:90,moveout:3");
ok("nothing said before: everything is new; everything said: nothing is", job.pickNew(items, []).length === 3 && job.pickNew(items, null).length === 3 && job.pickNew(items, items.map(i => i.item_key)).length === 0);
ok("a renewal reminded at 90 days is new again at 60 (the key carries the band)", job.pickNew([item({ item_key: "renewal:1:60" })], ["renewal:1:90"]).length === 1);
ok("a line without a key is never emailed", job.pickNew([{ title: "x" }, null], []).length === 0);
const mail = job.digest({ newItems: [item({ title: "Pat <b>Lee</b>: lease ends Dec 1", detail: "In 60 days.", severity: "high" }), item({ title: "Second", detail: "x", severity: "overdue" })], total: 5, company: { name: "Acme & Sons" }, base: "https://example.test" });
ok("the subject counts what is new and names the company", mail.subject === "2 things need attention — Acme & Sons", mail.subject);
ok("one thing is singular", job.digest({ newItems: [item({})], total: 1, company: { name: "" }, base: "" }).subject === "1 thing needs attention");
ok("names and titles are escaped in the email", mail.html.includes("Pat &lt;b&gt;Lee&lt;/b&gt;") && !mail.html.includes("<b>Lee</b>"));
ok("it links to the dashboard and says how many are waiting in all", mail.html.includes("https://example.test/dashboard") && /5 things are waiting in all/.test(mail.html) && mail.text.includes("https://example.test/dashboard"));
const big = job.digest({ newItems: Array.from({ length: 27 }, (_, n) => item({ title: "Line " + n })), total: 27, company: { name: "A" }, base: "" });
ok("a long list is cut to twenty lines and says how many more", (big.html.match(/<tr>/g) || []).length === 20 && /And 7 more\./.test(big.html) && /And 7 more\./.test(big.text));

// ── automatic reminders to signers
const now = Date.parse("2026-10-10T12:00:00Z");
const sig = (o) => ({ id: "s", status: "sent", request_emailed_at: "2026-10-01T12:00:00Z", last_reminded_at: null, reminder_count: 0, ...o });
ok("off (0, blank, nonsense) reminds nobody", job.signersDue([sig()], 0, now).length === 0 && job.signersDue([sig()], null, now).length === 0 && job.signersDue([sig()], "abc", now).length === 0 && job.signersDue([sig()], -3, now).length === 0);
ok("asked nine days ago, every 3 days: due", job.signersDue([sig()], 3, now).length === 1);
ok("exactly on the day counts", job.signersDue([sig({ request_emailed_at: "2026-10-07T12:00:00Z" })], 3, now).length === 1);
ok("a minute short of the day does not", job.signersDue([sig({ request_emailed_at: "2026-10-07T12:01:00Z" })], 3, now).length === 0);
ok("the wait runs from the last reminder, not the first request", job.signersDue([sig({ last_reminded_at: "2026-10-09T12:00:00Z", reminder_count: 1 })], 3, now).length === 0);
ok("three reminders is the limit", job.signersDue([sig({ reminder_count: 3 })], 3, now).length === 0 && job.signersDue([sig({ reminder_count: 2 })], 3, now).length === 1 && job.MAX_AUTO_REMINDERS === 3);
ok("someone never emailed is not 'reminded' (their request was never sent)", job.signersDue([sig({ request_emailed_at: null })], 3, now).length === 0);
ok("only a signer whose turn it is: not pending, signed, declined or cancelled", ["pending", "signed", "declined", "voided"].every(s => job.signersDue([sig({ status: s })], 3, now).length === 0) && job.signersDue([sig({ status: "viewed" })], 3, now).length === 1);
ok("a broken date is skipped, not treated as long ago", job.signersDue([sig({ request_emailed_at: "not a date" })], 3, now).length === 0);

// ── wiring
const mig = read("supabase/migrations/20261003070000_lease_clock.sql"), impl = read("api/_lease-clock-impl.js"), disp = read("api/daily-reminders.js"),
  vercel = JSON.parse(read("vercel.json")), dash = read("src/components/Dashboard.js"), card = read("src/components/LeaseClock.js"), docApi = read("api/_doc-email-impl.js"),
  late = read("api/_late-fees-impl.js");
const fn = mig.slice(mig.indexOf("CREATE OR REPLACE FUNCTION public.lease_clock_items"), mig.indexOf("REVOKE ALL ON FUNCTION public.lease_clock_items"));
ok("the list is closed to the public key and checks the caller is staff of that company", /REVOKE ALL ON FUNCTION public\.lease_clock_items\(text\) FROM PUBLIC, anon;/.test(mig) && /NOT public\.is_company_staff\(p_company_id\) THEN\s+RAISE EXCEPTION/.test(fn));
ok("every part of the list is scoped to the company asked for", (fn.match(/company_id = p_company_id/g) || []).length >= 12);
ok("a renewal already offered is not nagged about", /c\.kind = 'renewal' AND c\.status IN \('awaiting_signature', 'scheduled'\)/.test(fn));
ok("renewals come at 90, 60 and 30 days, each a new line", /WHEN l\.end_date - v_today <= 30 THEN '30' WHEN l\.end_date - v_today <= 60 THEN '60' ELSE '90'/.test(fn) && /l\.end_date BETWEEN v_today AND v_today \+ 90/.test(fn));
ok("the deposit deadline uses the company's own number of days", /SELECT cs\.deposit_return_days INTO v_dep_days/.test(fn) && /t\.move_out \+ v_dep_days/.test(fn));
ok("a deposit statement already made (not a draft) clears the line", /d\.doc_kind = 'deposit_disposition' AND d\.archived_at IS NULL AND COALESCE\(d\.status, ''\) <> 'draft'/.test(fn));
ok("a late fee counts only when posted, and by the same reference the fee is posted under", /je\.reference = 'LATEFEE-' \|\| t\.id::text \|\| '-' \|\| v_month AND je\.status = 'posted'/.test(fn) && /'YYYYMM'/.test(fn));
ok("dismissed lines stay away", /NOT EXISTS \(SELECT 1 FROM lease_clock_dismissed x WHERE x\.company_id = p_company_id AND x\.item_key = i\.item_key\)/.test(fn));
ok("the 'already emailed' table is for the server only", /REVOKE ALL ON public\.lease_clock_notified FROM anon, authenticated;/.test(mig));
ok("dismissals are staff-only and cannot be read by the public key", /lease_clock_dismissed_staff[\s\S]{0,200}is_company_staff\(company_id\)/.test(mig) && /REVOKE ALL ON public\.lease_clock_dismissed FROM anon;/.test(mig));
ok("automatic reminders to signers are OFF unless a company turns them on", /auto_remind_signers_days integer NOT NULL DEFAULT 0/.test(mig) && /if \(remindDays > 0\)/.test(impl));
ok("the migration needs no approval prompt to run again (no DROP)", !/\bDROP\b/.test(mig));
ok("the job is cron-only", /if \(!isCronAuth\) \{ res\.status\(401\)/.test(impl) && /CRON_SECRET\.length >= 8/.test(impl));
ok("it applies due lease changes before it looks", impl.indexOf('rpc("apply_due_lease_changes"') > 0 && impl.indexOf('rpc("apply_due_lease_changes"') < impl.indexOf('rpc("lease_clock_items"'));
ok("every email goes through the one logged, test-safe sender", /docEmail\.deliver\(sb, \{ companyId: company\.id, kind: "clock_digest"/.test(impl) && /docEmail\.remindSigner\(/.test(impl) && !/new Resend|resend\.emails/.test(impl));
ok("a line is marked as said only if an email actually left or was logged", /if \(told > 0\) \{[\s\S]{0,300}lease_clock_notified/.test(impl));
ok("the reminder button and the daily job share one reminder", /async function remindSigner\(/.test(docApi) && /await remindSigner\(sb, req, \{ sig, doc, company, createdBy: actor \}\)/.test(docApi) && /token_expires_at: expires/.test(docApi.slice(docApi.indexOf("async function remindSigner("), docApi.indexOf("// After the signed PDF is stored"))));
ok("the dispatcher knows the task", /if \(task === "lease-clock"\) return leaseClockHandler\(req, res\);/.test(disp));
const crons = vercel.crons || [];
const clockCron = crons.find(x => x.path === "/api/daily-reminders?task=lease-clock"), lateCron = crons.find(x => x.path === "/api/daily-reminders?task=late-fees");
ok("the clock runs every day", !!clockCron && /^\d+ \d+ \* \* \*$/.test(clockCron.schedule), JSON.stringify(clockCron));
ok("late fees run every day, not only on the 5th (inside the grace period, when nobody can be charged)", !!lateCron && /^\d+ \d+ \* \* \*$/.test(lateCron.schedule), JSON.stringify(lateCron));
ok("the late-fee job still leaves the rules to the database (one per tenant per month)", /batch_post_late_fees/.test(late) && /Runs EVERY DAY/.test(late));
ok("the dashboard shows the list", /<NeedsAttentionCard companyId=\{companyId\}/.test(dash) && /rpc\("lease_clock_items", \{ p_company_id: companyId \}\)/.test(card));
ok("the card draws nothing when there is nothing, or when the database predates it", /if \(items === null \|\| failed \|\| items\.length === 0\) return null;/.test(card));
ok("dismissing writes who did it", /from\("lease_clock_dismissed"\)\.insert\(\[\{ company_id: companyId, item_key: item\.item_key, dismissed_by:/.test(card));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
