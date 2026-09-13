// Housy: the app's assistant.
//
// The name lives in ONE constant so it is a single edit to change, and so
// no component hard-codes it into a sentence. Every string the user reads
// is built from HOUSY.name -- which is the same lesson as the design
// tokens: a value spelled at forty call sites is a value nobody can
// change.
export const HOUSY = {
  name: "Housy",
  // What it is, in the user's terms, not ours. Shown on the review queue
  // and wherever a proposal appears.
  tagline: "reads your documents and proposes what to fill in",
  icon: "auto_awesome",
};

// Every kind of job Housy can produce, with the words a person should see.
// `writes` names the table a proposal would change once approved, which is
// what makes the review queue able to say what is at stake.
export const HOUSY_JOB_KINDS = {
  extract_license: {
    label: "Rental license",
    describe: (j) => j.output?.license_number
      ? `License ${j.output.license_number}`
      : "License details",
    writes: "property_licenses",
  },
  abstract_lease: { label: "Lease terms", describe: () => "Lease details", writes: "leases" },
  categorise_txn: { label: "Transaction coding", describe: () => "Account and class", writes: "acct_journal_lines" },
  draft_notice:   { label: "Tenant notice", describe: () => "Drafted message", writes: "documents" },
};

export const HOUSY_STATUS = {
  // A job exists before the model has run: long documents are queued and
  // picked up by the worker on the box, because a 12-page lease takes
  // ~2 minutes to read and cannot be an HTTP request anyone waits on.
  queued:    { label: "Queued",       tone: "neutral" },
  running:   { label: "Reading\u2026",    tone: "info" },
  proposed:  { label: "Needs review", tone: "warn" },
  approved:  { label: "Approved",     tone: "success" },
  rejected:  { label: "Rejected",     tone: "neutral" },
  executing: { label: "Applying",     tone: "info" },
  done:      { label: "Applied",      tone: "success" },
  failed:    { label: "Failed",       tone: "danger" },
};

/**
 * How much of a proposal Housy actually filled in.
 *
 * Shown because a model's own confidence is not calibrated and must never
 * be the only signal: "4 of 6 fields" is something a reviewer can check,
 * where "0.91 confident" is not.
 */
export function proposalCoverage(output) {
  if (!output || typeof output !== "object") return { filled: 0, total: 0 };
  // Keys prefixed with _ are context for the reviewer, not fields to write.
  const keys = Object.keys(output).filter(k => !k.startsWith("_"));
  const filled = keys.filter(k => output[k] !== null && output[k] !== undefined && output[k] !== "").length;
  return { filled, total: keys.length };
}
