// Default email subject + body templates per event type. Single
// source of truth for both the admin editor (which prefills the
// inputs so admins see what'll actually go out) and the worker
// (which uses these as the server-side fallback when an admin hasn't
// set an override). The worker imports this file so the two stay
// aligned without copy-paste drift.
//
// {{tokens}} are resolved against the row's `data` JSON plus the
// app context (company_name, app_url) injected by the worker. Token
// names follow the camelCase convention used by callers — keep new
// additions consistent with eventLabels[type].vars in
// src/components/Notifications.js.

const TEMPLATES = {
  // ── Tenant lifecycle ──────────────────────────────────────────
  move_in: {
    subject: "Welcome to {{property}}!",
    body:
`Hi {{tenant}},

Welcome to {{property}}! Your move-in is confirmed for {{moveInDate}}.

A few things to keep handy:
  • Tenant portal — pay rent, request maintenance, message us: {{app_url}}/#tenant_portal
  • Reach us anytime by replying to this email.

We're glad to have you with us.

— {{company_name}}`,
  },

  move_out: {
    subject: "Move-out confirmed — {{property}}",
    body:
`Hi {{tenant}},

Your move-out from {{property}} on {{moveOutDate}} has been processed in our system.

You'll receive a separate notice once the security deposit settlement is finalized (typically within the timeline required by your state).

Thanks for being a tenant — we wish you well.

— {{company_name}}`,
  },

  lease_created: {
    subject: "Your lease for {{property}} is ready",
    body:
`Hi {{tenant}},

Your lease for {{property}} has been prepared and is ready for signing.

  Term:  {{startDate}} → {{endDate}}
  Rent:  {{rent}}/month

You'll receive a separate email with the signing link shortly. If you don't see it within a few minutes, check spam or reply here and we'll resend.

— {{company_name}}`,
  },

  lease_expiring: {
    subject: "Lease expiring in {{daysLeft}} days — {{property}}",
    body:
`Hi {{tenant}},

Your lease for {{property}} ends on {{date}} ({{daysLeft}} days from now).

Please let us know whether you'd like to renew so we can prepare the next term — or, if you're moving out, what date works.

Reply to this email and we'll take it from here.

— {{company_name}}`,
  },

  lease_expiry: {
    subject: "Lease expiring — {{property}}",
    body:
`Hi {{tenant}},

Your lease for {{property}} ends on {{date}}.

Please contact us to discuss renewal or move-out plans so we can prepare paperwork in time.

— {{company_name}}`,
  },

  // ── Money ─────────────────────────────────────────────────────
  rent_due: {
    subject: "Rent due {{date}} — {{property}}",
    body:
`Hi {{tenant}},

A friendly reminder that your rent of {{amount}} for {{property}} is due on {{date}}.

Pay through the tenant portal: {{app_url}}/#tenant_portal

If you've already paid, please disregard this message.

— {{company_name}}`,
  },

  rent_overdue: {
    subject: "Rent past due — {{property}}",
    body:
`Hi {{tenant}},

Your rent for {{property}} is past due. Current outstanding balance: {{balance}}.

Please pay as soon as possible to avoid additional late fees: {{app_url}}/#tenant_portal

If you're facing a hardship and need to discuss a payment arrangement, reply to this email.

— {{company_name}}`,
  },

  payment_received: {
    subject: "Payment received — {{amount}}",
    body:
`Hi {{tenant}},

We received your payment of {{amount}} on {{date}}. Thank you!

You can view a receipt in your tenant portal: {{app_url}}/#tenant_portal

— {{company_name}}`,
  },

  payment_received_admin: {
    subject: "Payment received — {{amount}} from {{tenant}}",
    body:
`{{tenant}} paid {{amount}} on {{date}} for {{property}}.

View in Housify: {{app_url}}/#payments

— {{company_name}}`,
  },

  payment_failed: {
    subject: "Autopay failed — please update your card",
    body:
`Hi {{tenant}},

Your scheduled rent payment of {{amount}} on {{date}} could not be processed.

Reason from the bank: {{error}}

Please update your card on file so the next charge can go through cleanly: {{app_url}}/#tenant_autopay

If your card details haven't changed, your bank may have flagged the charge — calling them to release it usually fixes it.

— {{company_name}}`,
  },

  payment_failed_admin: {
    subject: "Autopay failed — {{tenant}}",
    body:
`Autopay charge for {{tenant}} failed on {{date}}.

  Amount attempted: {{amount}}
  Property:         {{property}}
  Bank reason:      {{error}}

The tenant has been emailed and prompted to update their card.

View in Housify: {{app_url}}/#payments

— {{company_name}}`,
  },

  late_fee_applied: {
    subject: "Late fee applied — {{property}}",
    body:
`Hi {{tenant}},

A late fee of {{amount}} has been applied to your account ({{daysLate}} day(s) past due).

Updated balance: {{balance}}

To avoid further fees, please pay as soon as possible: {{app_url}}/#tenant_portal

— {{company_name}}`,
  },

  // ── Maintenance ───────────────────────────────────────────────
  work_order_created: {
    subject: "New maintenance request — {{property}}",
    body:
`A new maintenance request was submitted.

  Tenant:   {{tenant}}
  Property: {{property}}
  Issue:    {{issue}}
  Priority: {{priority}}

Open in Housify: {{app_url}}/#maintenance

— {{company_name}}`,
  },

  work_order_completed: {
    subject: "Maintenance completed — {{property}}",
    body:
`Hi {{tenant}},

Your maintenance request "{{issue}}" has been marked complete.

If anything's still wrong, reply to this email or open a new request through the tenant portal.

— {{company_name}}`,
  },

  work_order_update: {
    subject: "Maintenance update — {{property}}",
    body:
`Hi {{tenant}},

Status update on your maintenance request "{{issue}}": {{status}}.

Track progress in your tenant portal: {{app_url}}/#tenant_portal

— {{company_name}}`,
  },

  inspection_due: {
    subject: "Inspection scheduled — {{property}}",
    body:
`This is a reminder that an inspection is scheduled for {{property}} on {{date}}.

Tenant has been notified separately. Please ensure access to the unit on the scheduled date.

— {{company_name}}`,
  },

  insurance_expiring: {
    subject: "Vendor insurance expiring — {{vendor}}",
    body:
`The Certificate of Insurance on file for {{vendor}} expires on {{date}}.

Please request an updated COI before scheduling any new work — vendors without current insurance should not be dispatched.

— {{company_name}}`,
  },

  // ── Communication ─────────────────────────────────────────────
  message_received: {
    subject: "New message from {{sender}}",
    body:
`{{sender}} sent you a message:

{{preview}}

Reply at {{app_url}}/#messages

— {{company_name}}`,
  },

  // ── Operations ────────────────────────────────────────────────
  deposit_returned: {
    subject: "Security deposit settlement — {{property}}",
    body:
`Hi {{tenant}},

Your security deposit for {{property}} has been settled.

  Returned to you: {{returned}}
  Deductions:      {{deducted}}

A detailed breakdown is available in your tenant portal: {{app_url}}/#tenant_portal

— {{company_name}}`,
  },

  approval_pending: {
    subject: "Approval needed — {{summary}}",
    body:
`A request from {{requester}} is waiting on your review:

  {{summary}}

Open in Housify: {{app_url}}/#tasks

— {{company_name}}`,
  },

  approval_request: {
    subject: "Approval needed — {{summary}}",
    body:
`A request from {{requester}} is waiting on your review:

  {{summary}}

Open in Housify: {{app_url}}/#tasks

— {{company_name}}`,
  },

  owner_statement: {
    subject: "Owner statement available — {{period}}",
    body:
`Hi {{owner}},

Your owner statement for {{period}} is now available.

  Net distribution: {{net}}

View the full statement in your owner portal: {{app_url}}/#owner_portal

— {{company_name}}`,
  },

  signed_doc_copy: {
    subject: "Your signed copy: {{doc_name}}",
    body:
`Hi {{signer_name}},

Your signed copy of "{{doc_name}}" is ready.

A short-lived download link will follow shortly. If you misplaced it, contact {{company_name}} for another copy.

— {{company_name}}`,
  },

  document_uploaded: {
    subject: "New document uploaded — {{doc_name}}",
    body:
`A new document "{{doc_name}}" has been added{{tenant ? " to " + tenant + "'s file" : ""}}{{property ? " for " + property : ""}}.

View in Housify: {{app_url}}/#documents

— {{company_name}}`,
  },

  invoice_approved: {
    subject: "Invoice approved — {{vendor}} {{amount}}",
    body:
`Invoice from {{vendor}} for {{amount}} has been approved for payment.

View in Housify: {{app_url}}/#vendors

— {{company_name}}`,
  },

  invoice_rejected: {
    subject: "Invoice rejected — {{vendor}}",
    body:
`Invoice from {{vendor}} for {{amount}} was rejected.

  Reason: {{reason}}

View in Housify: {{app_url}}/#vendors

— {{company_name}}`,
  },

  error_reported: {
    subject: "Account error — {{code}}",
    body:
`A critical error was logged in your account.

  Code:    {{code}}
  Context: {{context}}

The development team has been notified automatically. If this is impacting daily operations, reply to this email.

— {{company_name}}`,
  },
};

function defaultTemplateFor(type) {
  return TEMPLATES[type] || { subject: "", body: "" };
}

// CommonJS export so api/_notification-worker-impl.js (require) and the
// React editor (import) can both pull from one source. CRA/webpack
// handles the ESM-import-from-CJS interop transparently.
module.exports = { TEMPLATES, defaultTemplateFor };
