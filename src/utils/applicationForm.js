// The rental application: what it asks, and what counts as complete.
// PURE -- no imports -- so the public page, the staff view and the tests all
// read the same definition.
//
// Deliberately NOT asked: Social Security number, date of birth, bank
// account details, criminal history. They are not needed to keep a record
// of what an applicant told us, and each would be a liability to hold.
// What may be asked, and any fee, has Maryland and county rules: [LAW] in
// docs/PLAN-tenant-documents.md.

const f = (key, label, type = "text", required = false, extra = {}) => ({ key, label, type, required, ...extra });

export const APPLICATION_SECTIONS = [
  { title: "About you", fields: [
    f("full_name", "Full legal name", "text", true),
    f("phone", "Phone", "tel", true),
    f("email", "Email", "email", true),
    f("current_address", "Current address", "textarea", true),
    f("current_since", "Living there since (month and year)", "text", true),
    f("current_landlord", "Current landlord or manager (name and phone)", "text"),
    f("current_rent", "Current monthly rent", "money"),
    f("reason_for_moving", "Reason for moving", "textarea"),
  ] },
  { title: "Work and income", fields: [
    f("employer", "Employer (or source of income)", "text", true),
    f("position", "Position", "text"),
    f("employed_since", "With them since (month and year)", "text"),
    f("monthly_income", "Monthly income before tax", "money", true),
    f("employer_contact", "Supervisor or HR contact (name and phone)", "text"),
    f("other_income", "Any other income (source and monthly amount)", "textarea"),
  ] },
  { title: "Who will live in the home", fields: [
    f("other_occupants", "Everyone else who will live there (name and age)", "textarea"),
    f("pets", "Pets (kind, breed, weight) or \"none\"", "text", true),
    f("vehicles", "Vehicles (make, model, plate) or \"none\"", "text"),
  ] },
  { title: "Rental history", fields: [
    f("previous_address", "Previous address, and the landlord's name and phone", "textarea"),
    f("ever_evicted", "Have you ever been evicted or asked to move out?", "yesno", true),
    f("eviction_details", "If yes, when and why", "textarea", false, { showWhen: { key: "ever_evicted", equals: "yes" }, requiredWhenShown: true }),
  ] },
  { title: "Emergency contact", fields: [
    f("emergency_name", "Name", "text", true),
    f("emergency_phone", "Phone", "tel", true),
    f("emergency_relationship", "Relationship to you", "text"),
  ] },
];

export const APPLICATION_CERTIFICATION =
  "I certify that everything in this application is true and complete. I understand that false or incomplete information may be a reason to deny this application or to end a tenancy. I authorize the landlord to verify what I have stated, including with my employer and my current and previous landlords.";

const isShown = (field, answers) => !field.showWhen || String(answers?.[field.showWhen.key] || "").toLowerCase() === field.showWhen.equals;
const blank = (v) => v === null || v === undefined || String(v).trim() === "";
export const applicationFields = () => APPLICATION_SECTIONS.flatMap(s => s.fields);

/** @returns {{ ok: boolean, errors: Record<string,string>, first?: string }} */
export function validateApplication(answers, signedName, certified) {
  const errors = {};
  for (const field of applicationFields()) {
    if (!isShown(field, answers)) continue;
    const v = answers?.[field.key];
    const required = field.required || (field.requiredWhenShown && field.showWhen);
    if (required && blank(v)) { errors[field.key] = "Please answer this."; continue; }
    if (blank(v)) continue;
    if (field.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim())) errors[field.key] = "That email address does not look right.";
    if (field.type === "tel" && String(v).replace(/\D/g, "").length < 10) errors[field.key] = "Please give a full phone number.";
    if (field.type === "money" && !(Number(String(v).replace(/[^0-9.]/g, "")) >= 0 && /\d/.test(String(v)))) errors[field.key] = "Please enter an amount.";
    if (field.type === "yesno" && !["yes", "no"].includes(String(v).toLowerCase())) errors[field.key] = "Please choose yes or no.";
    if (String(v).length > 2000) errors[field.key] = "That is too long.";
  }
  if (blank(signedName)) errors._signed = "Type your full name to sign.";
  if (!certified) errors._certified = "Please confirm the certification.";
  const keys = Object.keys(errors);
  return { ok: keys.length === 0, errors, first: keys[0] };
}

/** Only the answers the form knows about, trimmed; hidden follow-ups dropped. */
export function cleanAnswers(answers) {
  const out = {};
  for (const field of applicationFields()) {
    if (!isShown(field, answers)) continue;
    const v = answers?.[field.key];
    if (blank(v)) continue;
    out[field.key] = String(v).trim().slice(0, 2000);
  }
  return out;
}

/** For the staff view and for printing: [{ title, rows: [{ label, value }] }]. */
export function applicationSummary(answers) {
  return APPLICATION_SECTIONS.map(s => ({
    title: s.title,
    rows: s.fields.filter(field => isShown(field, answers) && !blank(answers?.[field.key]))
      .map(field => ({ label: field.label, value: field.type === "yesno" ? (String(answers[field.key]).toLowerCase() === "yes" ? "Yes" : "No") : String(answers[field.key]) })),
  })).filter(s => s.rows.length);
}
export const isFieldShown = isShown;

// ── What a prospect has handed in ──────────────────────────────────────
// prospects.checklist = { <key>: { done, at, by } }. "application" ticks
// itself when an application is submitted.
export const PROSPECT_CHECKLIST = [
  { key: "application", label: "Application received" },
  { key: "id", label: "Photo ID" },
  { key: "income", label: "Proof of income" },
  { key: "insurance", label: "Renter's insurance" },
];
export function checklistProgress(checklist) {
  const done = PROSPECT_CHECKLIST.filter(i => checklist?.[i.key]?.done).length;
  return { done, total: PROSPECT_CHECKLIST.length };
}
export function toggleChecklist(checklist, key, by, at) {
  const cur = { ...(checklist || {}) };
  if (cur[key]?.done) delete cur[key]; else cur[key] = { done: true, at, by };
  return cur;
}
