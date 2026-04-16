// ============ APP CONFIGURATION ============
// UI constants that don't need per-company customization.
// Business logic defaults are in COMPANY_DEFAULTS below and stored
// per-company in the company_settings DB table.

// ---- File Upload Limits (bytes) ----
export const MAX_FILE_SIZE_DOCS = 25 * 1024 * 1024;      // 25 MB — documents
export const MAX_FILE_SIZE_PHOTOS = 10 * 1024 * 1024;     // 10 MB — work order photos
export const MAX_FILE_SIZE_AVATAR = 2 * 1024 * 1024;      // 2 MB — profile avatars

// ---- Session & Guard Timeouts (ms) ----
export const SESSION_IDLE_TIMEOUT = 30 * 60 * 1000;       // 30 minutes
export const GUARD_SUBMIT_TIMEOUT = 30000;                 // 30 seconds
export const GUARD_CLEANUP_INTERVAL = 300000;              // 5 minutes

// ---- Toast Durations (ms) ----
export const TOAST_DURATION_CRITICAL = 10000;
export const TOAST_DURATION_ERROR = 6000;
export const TOAST_DURATION_DEFAULT = 4000;

// ---- Signed URL ----
export const SIGNED_URL_EXPIRY = 3600;                     // 1 hour in seconds

// ---- Pagination ----
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_LARGE = 200;
export const PAGE_SIZE_MAX = 500;

// ---- Encryption ----
export const PBKDF2_ITERATIONS = 100000;

// ---- Input Limits ----
export const MAX_LENGTH_EMAIL = 254;
export const MAX_LENGTH_PHONE = 14;
export const MAX_LENGTH_TEXT = 200;
export const MAX_LENGTH_TEXTAREA = 5000;

// ============ COMPANY DEFAULTS ============
// These are the default values for new companies. Once a company
// saves their settings, the DB values override these.
export const COMPANY_DEFAULTS = {
  // Late Fees
  late_fee_grace_days: 5,
  late_fee_amount: 50,
  late_fee_type: "flat",            // "flat" or "percent"

  // Lease Defaults
  default_lease_months: 12,
  default_deposit_months: 1,
  rent_escalation_pct: 3,
  payment_due_day: 1,
  renewal_notice_days: 60,

  // Notification Thresholds
  rent_due_reminder_days: 3,        // days before due date
  lease_expiry_warning_days: 60,    // days before expiry
  insurance_expiry_warning_days: 90,

  // Legal / Lease Template
  deposit_return_days: 30,          // days after move-out
  termination_notice_days: 30,      // written notice required

  // Data Retention
  archive_retention_days: 180,

  // Voucher / HAP
  hoa_upcoming_window_days: 14,
  voucher_reexam_window_days: 120,
};
