// The rental application and the prospect checklist (Phase 1B).
import fs from "fs";
import { APPLICATION_SECTIONS, APPLICATION_CERTIFICATION, applicationFields, validateApplication, cleanAnswers, applicationSummary, PROSPECT_CHECKLIST, checklistProgress, toggleChecklist } from "../src/utils/applicationForm.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
const good = { full_name: "Pat Applicant", phone: "(301) 555-0111", email: "pat@example.com", current_address: "9 Old Rd", current_since: "June 2023", employer: "Acme", monthly_income: "$5,200", pets: "none", ever_evicted: "no", emergency_name: "Sam", emergency_phone: "2405550122" };

// ── what it asks
const keys = applicationFields().map(f => f.key);
ok("every question has its own key", new Set(keys).size === keys.length && keys.length >= 20);
ok("it never asks for a Social Security number, a date of birth, bank details or criminal history", !keys.some(k => /ssn|social|birth|dob|bank|routing|account|crim|felony|convict/i.test(k)) && !APPLICATION_SECTIONS.some(s => s.fields.some(f => /social security|date of birth|bank account|criminal|felony|convicted/i.test(f.label))));
ok("the certification says the answers are true and authorises verification", /true and complete/.test(APPLICATION_CERTIFICATION) && /authorize the landlord to verify/.test(APPLICATION_CERTIFICATION));

// ── what counts as complete
ok("a complete application passes", validateApplication(good, "Pat Applicant", true).ok);
let v = validateApplication({}, "", false);
ok("an empty one lists every required answer, the signature and the certification", !v.ok && ["full_name", "phone", "email", "current_address", "employer", "monthly_income", "pets", "ever_evicted", "emergency_name", "emergency_phone", "_signed", "_certified"].every(k => v.errors[k]) && v.first === "full_name", Object.keys(v.errors).join(","));
ok("optional answers may be left blank", !validateApplication(good, "Pat", true).errors.vehicles && !validateApplication(good, "Pat", true).errors.other_income);
ok("a bad email and a short phone are refused", !!validateApplication({ ...good, email: "pat@" }, "Pat", true).errors.email && !!validateApplication({ ...good, phone: "555-0111" }, "Pat", true).errors.phone);
ok("income must be an amount", !!validateApplication({ ...good, monthly_income: "a lot" }, "Pat", true).errors.monthly_income && !validateApplication({ ...good, monthly_income: "5200.50" }, "Pat", true).errors.monthly_income);
ok("'yes' to the eviction question makes the details required", !!validateApplication({ ...good, ever_evicted: "yes" }, "Pat", true).errors.eviction_details && validateApplication({ ...good, ever_evicted: "yes", eviction_details: "2019, lease dispute" }, "Pat", true).ok);
ok("'no' does not ask for details", !validateApplication(good, "Pat", true).errors.eviction_details);
ok("it must be signed and certified", !validateApplication(good, " ", true).ok && !validateApplication(good, "Pat", false).ok);
ok("an answer of absurd length is refused", !!validateApplication({ ...good, reason_for_moving: "x".repeat(2001) }, "Pat", true).errors.reason_for_moving);

// ── what is stored
let c = cleanAnswers({ ...good, eviction_details: "should not be kept", made_up: "<script>", reason_for_moving: "  closer to work  " });
ok("only known answers are kept, trimmed; a hidden follow-up and unknown keys are dropped", c.reason_for_moving === "closer to work" && !("eviction_details" in c) && !("made_up" in c) && c.full_name === "Pat Applicant");
ok("blank answers are not stored", !("vehicles" in cleanAnswers({ ...good, vehicles: "   " })));
const sum = applicationSummary({ ...good, ever_evicted: "no" });
ok("the staff view groups answers by section and says Yes/No in words", sum.some(s => s.title === "Work and income" && s.rows.some(r => r.value === "Acme")) && sum.some(s => s.rows.some(r => r.label.startsWith("Have you ever been evicted") && r.value === "No")));
ok("a section with no answers is left out", !applicationSummary({ full_name: "Pat" }).some(s => s.title === "Emergency contact"));

// ── checklist
ok("four items, the application first", PROSPECT_CHECKLIST.length === 4 && PROSPECT_CHECKLIST[0].key === "application");
ok("progress counts what is done", checklistProgress({ id: { done: true }, income: { done: false } }).done === 1 && checklistProgress(null).done === 0 && checklistProgress({}).total === 4);
let t = toggleChecklist({}, "id", "staff@x.com", "2026-10-02T12:00:00Z");
ok("ticking records who and when; ticking again clears it", t.id.done && t.id.by === "staff@x.com" && !("id" in toggleChecklist(t, "id", "x", "y")));
ok("ticking one item leaves the others alone, and the input is not mutated", (() => { const before = { application: { done: true } }; const after = toggleChecklist(before, "income", "a", "b"); return after.application.done && after.income.done && !("income" in before); })());

// ── wiring
const page = read("src/components/PublicApplyPage.js"), app = read("src/App.js"), prospects = read("src/components/Prospects.js"),
  mig = read("supabase/migrations/20261003060000_prospect_applications.sql"), api = read("api/_doc-email-impl.js"), std = read("src/utils/standardTemplates.js");
ok("the application page is reached without any login", /if \(path\.startsWith\("\/apply\/"\)\) \{/.test(app) && app.indexOf('path.startsWith("/apply/")') < app.indexOf("<AppInner />"));
ok("the page talks only to the two token functions, never to a table", /rpc\("get_application_by_token"/.test(page) && /rpc\("submit_application"/.test(page) && !/\.from\(/.test(page));
ok("what is sent is the cleaned answers and the certification text shown", /p_answers: cleanAnswers\(answers\)/.test(page) && /p_consent_text: APPLICATION_CERTIFICATION/.test(page));
ok("the link functions are the only thing the public key may call; the table is closed", /REVOKE ALL ON public\.prospect_applications FROM anon;/.test(mig) && /GRANT EXECUTE ON FUNCTION public\.get_application_by_token\(text\) TO anon/.test(mig) && /REVOKE ALL ON FUNCTION public\.create_prospect_application\(uuid, text, text\) FROM PUBLIC, anon;/.test(mig));
ok("an application can be submitted once, and not after it expires or is withdrawn", /IF v_a\.status NOT IN \('sent', 'opened'\) THEN RETURN jsonb_build_object\('error', 'already submitted or withdrawn'/.test(mig) && /IF v_a\.token_expires_at < v_now THEN RETURN jsonb_build_object\('error', 'expired'\)/.test(mig));
ok("the submission is fingerprinted with the signed name", /digest\(p_answers::text \|\| '\|' \|\| btrim\(p_signed_name\)/.test(mig));
ok("an oversized submission is refused", /length\(p_answers::text\) > 60000/.test(mig));
ok("asking the same person again withdraws their earlier unsubmitted link, never a submitted one", /SET status = 'withdrawn'[\s\S]{0,160}status IN \('sent', 'opened'\)/.test(mig));
ok("submitting ticks 'application received' on the prospect", /jsonb_build_object\('application', jsonb_build_object\('done', true/.test(mig));
ok("a link reveals only the applicant's own name, the company and the home", /jsonb_build_object\('status', 'open', 'applicant_name'/.test(mig) && !/answers|signer_ip|integrity_hash/.test(mig.slice(mig.indexOf("FUNCTION public.get_application_by_token"), mig.indexOf("REVOKE ALL ON FUNCTION public.get_application_by_token"))));
ok("the email goes through the logged sender, staff only, and extends the link", /if \(op === "application-request"\)/.test(api) && api.indexOf('op === "application-request"') > api.indexOf("const auth = await requireMember") && /kind: "application_request"/.test(api));
ok("staff make a link per person and can copy it or open it in their own mail app", /rpc\("create_prospect_application", \{ p_prospect_id: p\.id, p_name: person\.name, p_email: person\.email \|\| null \}\)/.test(prospects) && /applicationMailto\(\{ application: a, origin: window\.location\.origin \}\)/.test(prospects));
ok("telling a losing applicant is a button, never automatic", /Tell them it is leased/.test(prospects) && /templateKey: "home_leased_notice", prospectId: p\.id/.test(prospects) && !/home_leased_notice/.test(read("supabase/migrations/20261003011000_prospect_convert.sql")));
ok("the 'home no longer available' letter is a standard template", /\n  home_leased_notice: \{/.test(std) && /has now been leased to another applicant/.test(std));
ok("the migration needs no approval prompt to run again (no DROP)", !/\bDROP\b/.test(mig));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
