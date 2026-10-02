// Document templates the app itself depends on.
//
// A button like "Renew lease" opens a template by its stable key. If a
// company does not have that template the button would dead-end, and the
// older built-ins (copied once from a seed company that only exists in
// production) carry no signers and no key. So the templates the tenant
// workflows need are defined here, in code, and installed into a company
// the first time they are wanted. Once installed they are the company's
// own: staff can edit the wording in the Document Builder, and nothing here
// overwrites an existing template.
//
// The wording is deliberately plain. It is a starting point, not legal
// advice: have it reviewed before relying on it. ([LAW] in the plan.)
import { supabase } from "../supabase";
import { pmError } from "./errors";

const field = (name, label, type, section, prefill_from = "", required = false) => ({ name, label, type, section, required, options: [], default_value: "", prefill_from });
const SIGNERS = [
  { role: "tenant", label: "Tenant", order: 1, required: true },
  { role: "tenant_2", label: "Co-tenant 2", order: 1, required: false },
  { role: "tenant_3", label: "Co-tenant 3", order: 1, required: false },
  { role: "landlord", label: "Landlord", order: 2, required: true },
];
const H1 = (t) => `<h1 style="text-align:center;font-size:20px;margin-bottom:24px;">${t}</h1>`;
const SIGN_BLOCK = `<p style="margin-top:32px;border-top:1px solid #999;padding-top:12px;"><strong>Landlord:</strong> {{landlord_name}}<br/>Signature: ______________________________ &nbsp; Date: ______________</p>
<p><strong>Tenant(s):</strong> {{tenant_name}}<br/>Signature: ______________________________ &nbsp; Date: ______________</p>`;

export const STANDARD_TEMPLATES = {
  // ── Phase 2 ─────────────────────────────────────────────────────────
  lease_renewal: {
    name: "Lease Renewal Agreement", category: "leases", template_type: "html", signing_mode: "sequential", signer_roles: SIGNERS,
    description: "Renews an existing lease for a new term. Signed by every tenant, then the landlord. The new term and rent take effect on the start date.",
    fields: [
      field("agreement_date", "Date of this agreement", "date", "Parties", "today", true),
      field("landlord_name", "Landlord", "text", "Parties", "company.name", true),
      field("tenant_name", "Tenant(s)", "text", "Parties", "tenant.all_names", true),
      field("property_address", "Premises", "text", "Parties", "property.address", true),
      field("original_lease_date", "Original lease start date", "date", "Parties", "lease.start_date"),
      field("renewal_start", "Renewal term starts", "date", "Renewal term", "", true),
      field("renewal_end", "Renewal term ends", "date", "Renewal term", "", true),
      field("new_rent", "Monthly rent for the renewal term", "currency", "Renewal term", "lease.rent_amount", true),
      field("security_deposit", "Security deposit held", "currency", "Renewal term", "lease.security_deposit"),
      field("additional_terms", "Other changes (optional)", "textarea", "Renewal term"),
    ],
    field_config: {},
    body: `${H1("LEASE RENEWAL AGREEMENT")}
<p><strong>Date:</strong> {{agreement_date}}</p>
<p>This agreement renews the lease that began on <strong>{{original_lease_date}}</strong> (the "Lease") between <strong>{{landlord_name}}</strong> ("Landlord") and <strong>{{tenant_name}}</strong> ("Tenant") for the premises at <strong>{{property_address}}</strong>.</p>
<h2 style="font-size:16px;">1. Renewal term</h2>
<p>The Lease is renewed for a term beginning <strong>{{renewal_start}}</strong> and ending <strong>{{renewal_end}}</strong>.</p>
<h2 style="font-size:16px;">2. Rent</h2>
<p>Beginning {{renewal_start}}, the monthly rent is <strong>{{new_rent}}</strong>, due as the Lease provides.</p>
<h2 style="font-size:16px;">3. Security deposit</h2>
<p>The security deposit of {{security_deposit}} already held under the Lease continues to be held under it for the renewal term.</p>
<h2 style="font-size:16px;">4. Other changes</h2>
<p>{{additional_terms}}</p>
<h2 style="font-size:16px;">5. Everything else stays the same</h2>
<p>Except as changed above, every term of the Lease remains in full force for the renewal term.</p>
${SIGN_BLOCK}`,
  },

  lease_change_addendum: {
    name: "Lease Addendum (signed)", category: "leases", template_type: "html", signing_mode: "sequential", signer_roles: SIGNERS,
    description: "Changes an existing lease: a person joining or leaving, a change to the monthly rent, or other wording. Signed by every tenant, then the landlord.",
    fields: [
      field("addendum_date", "Date of this addendum", "date", "Parties", "today", true),
      field("landlord_name", "Landlord", "text", "Parties", "company.name", true),
      field("tenant_name", "Tenant(s)", "text", "Parties", "tenant.all_names", true),
      field("property_address", "Premises", "text", "Parties", "property.address", true),
      field("original_lease_date", "Lease start date", "date", "Parties", "lease.start_date"),
      field("effective_date", "This change takes effect on", "date", "Change", "", true),
      field("addendum_text", "What changes", "textarea", "Change", "", true),
    ],
    field_config: {},
    body: `${H1("ADDENDUM TO LEASE")}
<p><strong>Date:</strong> {{addendum_date}}</p>
<p>This addendum changes the lease that began on <strong>{{original_lease_date}}</strong> (the "Lease") between <strong>{{landlord_name}}</strong> ("Landlord") and <strong>{{tenant_name}}</strong> ("Tenant") for the premises at <strong>{{property_address}}</strong>.</p>
<h2 style="font-size:16px;">Change</h2>
<p>Effective <strong>{{effective_date}}</strong>:</p>
<p>{{addendum_text}}</p>
<h2 style="font-size:16px;">Everything else stays the same</h2>
<p>Except as changed above, every term of the Lease remains in full force.</p>
${SIGN_BLOCK}`,
  },

  rent_increase_notice: {
    name: "Rent Increase Notice", category: "notices", template_type: "html", signing_mode: "none", signer_roles: [],
    description: "Written notice of a change to the monthly rent. Not signed by the tenant.",
    fields: [
      field("notice_date", "Notice date", "date", "Notice", "today", true),
      field("tenant_name", "Tenant(s)", "text", "Notice", "tenant.all_names", true),
      field("property_address", "Premises", "text", "Notice", "property.address", true),
      field("effective_date", "New rent starts", "date", "Rent", "", true),
      field("current_rent", "Current monthly rent", "currency", "Rent", "lease.rent_amount", true),
      field("new_rent", "New monthly rent", "currency", "Rent", "", true),
      field("notice_days", "Days of notice given", "number", "Rent"),
      field("increase_reason", "Reason (optional)", "textarea", "Rent"),
      field("sender_name", "Sent by", "text", "From", "user.name"),
      field("landlord_name", "Landlord", "text", "From", "company.name"),
    ],
    field_config: {},
    body: `${H1("NOTICE OF RENT CHANGE")}
<p><strong>Date:</strong> {{notice_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{property_address}}</p>
<p>This is written notice that, beginning <strong>{{effective_date}}</strong>, the monthly rent for the premises above changes from <strong>{{current_rent}}</strong> to <strong>{{new_rent}}</strong>.</p>
<p>{{increase_reason}}</p>
<p>This notice is given {{notice_days}} days before the change takes effect. Every other term of your lease stays the same.</p>
<p style="margin-top:32px;">{{sender_name}}<br/>{{landlord_name}}</p>`,
  },

  // ── Phase 3: notices and move-out ───────────────────────────────────
  move_out_acknowledgment: {
    name: "Acknowledgment of Notice to Vacate", category: "notices", template_type: "html", signing_mode: "none", signer_roles: [],
    description: "Confirms in writing that the tenant has given notice, the date it was received and the move-out date. Not signed.",
    fields: [
      field("letter_date", "Date", "date", "Notice", "today", true),
      field("tenant_name", "Tenant(s)", "text", "Notice", "tenant.all_names", true),
      field("property_address", "Premises", "text", "Notice", "property.address", true),
      field("notice_received", "Notice received on", "date", "Notice", "", true),
      field("move_out_date", "Move-out date", "date", "Notice", "", true),
      field("deposit_days", "Days to return the deposit", "number", "Deposit"),
      field("sender_name", "Sent by", "text", "From", "user.name"),
      field("landlord_name", "Landlord", "text", "From", "company.name"),
    ],
    field_config: {},
    body: `${H1("ACKNOWLEDGMENT OF NOTICE TO VACATE")}
<p><strong>Date:</strong> {{letter_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{property_address}}</p>
<p>We received your notice on <strong>{{notice_received}}</strong> that you will move out of the premises above. Your tenancy ends, and the premises must be vacated, on <strong>{{move_out_date}}</strong>.</p>
<p>Rent remains due as your lease provides until that date.</p>
<h2 style="font-size:16px;">Before you leave</h2>
<ul><li>Return every key and access device.</li><li>Remove all belongings and leave the premises clean.</li><li>Give us your forwarding address in writing, so your security deposit accounting reaches you.</li><li>Transfer or close the utilities in your name.</li></ul>
<h2 style="font-size:16px;">Your security deposit</h2>
<p>You may be present when the premises are inspected; tell us in writing if you wish to be. Within {{deposit_days}} days after your tenancy ends we will send, to your forwarding address, your deposit and a written list of anything withheld from it.</p>
<p style="margin-top:32px;">{{sender_name}}<br/>{{landlord_name}}</p>`,
  },

  notice_to_vacate: {
    name: "Notice to Vacate", category: "notices", template_type: "html", signing_mode: "none", signer_roles: [],
    description: "Notice from the landlord that the tenancy will not continue past a date. Not signed by the tenant.",
    fields: [
      field("notice_date", "Notice date", "date", "Notice", "today", true),
      field("tenant_name", "Tenant(s)", "text", "Notice", "tenant.all_names", true),
      field("property_address", "Premises", "text", "Notice", "property.address", true),
      field("vacate_date", "Vacate by", "date", "Notice", "", true),
      field("vacate_reason", "Reason (optional)", "textarea", "Notice"),
      field("sender_name", "Sent by", "text", "From", "user.name"),
      field("landlord_name", "Landlord", "text", "From", "company.name"),
    ],
    field_config: {},
    body: `${H1("NOTICE TO VACATE")}
<p><strong>Date:</strong> {{notice_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{property_address}}</p>
<p>This is written notice that your tenancy at the premises above will end on <strong>{{vacate_date}}</strong>. You are required to vacate and surrender possession of the premises on or before that date.</p>
<p>{{vacate_reason}}</p>
<p>Rent remains due as your lease provides until that date. Please return every key, remove all belongings, and give us your forwarding address in writing for your security deposit accounting.</p>
<p style="margin-top:32px;">{{sender_name}}<br/>{{landlord_name}}</p>`,
  },

  late_fee_notice: {
    name: "Late Rent Notice", category: "notices", template_type: "html", signing_mode: "none", signer_roles: [],
    description: "Tells the tenant that rent is past due, what is owed and any late charge. Not signed.",
    fields: [
      field("notice_date", "Notice date", "date", "Notice", "today", true),
      field("tenant_name", "Tenant(s)", "text", "Notice", "tenant.all_names", true),
      field("property_address", "Premises", "text", "Notice", "property.address", true),
      field("total_due", "Total now due", "currency", "Amounts", "tenant.balance", true),
      field("late_fee_amount", "Late charge included", "currency", "Amounts"),
      field("rent_period", "For the period", "text", "Amounts"),
      field("sender_name", "Sent by", "text", "From", "user.name"),
      field("landlord_name", "Landlord", "text", "From", "company.name"),
    ],
    field_config: {},
    body: `${H1("LATE RENT NOTICE")}
<p><strong>Date:</strong> {{notice_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{property_address}}</p>
<p>Our records show that rent for <strong>{{rent_period}}</strong> has not been paid in full. The total now due is <strong>{{total_due}}</strong>, which includes a late charge of {{late_fee_amount}} as your lease provides.</p>
<p>Please pay the total due now. If you have already paid, or believe this is in error, contact us right away.</p>
<p style="margin-top:32px;">{{sender_name}}<br/>{{landlord_name}}</p>`,
  },

  deposit_disposition: {
    name: "Security Deposit Statement", category: "notices", template_type: "html", signing_mode: "none", signer_roles: [],
    description: "The itemised accounting of a security deposit after move-out: what was held, what was withheld and why, and what is returned or still owed.",
    fields: [
      field("letter_date", "Date", "date", "Statement", "today", true),
      field("tenant_name", "Former tenant(s)", "text", "Statement", "tenant.all_names", true),
      field("forwarding_address", "Sent to (forwarding address)", "textarea", "Statement", "", true),
      field("property_address", "Premises", "text", "Statement", "property.address", true),
      field("move_out_date", "Tenancy ended", "date", "Statement", "", true),
      field("deposit_held", "Security deposit held", "currency", "Amounts", "", true),
      field("deposit_interest", "Interest on the deposit", "currency", "Amounts"),
      field("deductions_list", "Withheld: each item, its cost", "textarea", "Amounts"),
      field("total_deductions", "Total withheld", "currency", "Amounts"),
      field("other_owed", "Unpaid rent and charges applied", "currency", "Amounts"),
      field("amount_returned", "Amount returned to you", "currency", "Amounts"),
      field("balance_owed", "Balance you still owe", "currency", "Amounts"),
      field("sender_name", "Sent by", "text", "From", "user.name"),
      field("landlord_name", "Landlord", "text", "From", "company.name"),
    ],
    field_config: {},
    body: `${H1("SECURITY DEPOSIT STATEMENT")}
<p><strong>Date:</strong> {{letter_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{forwarding_address}}</p>
<p><strong>Premises:</strong> {{property_address}}<br/><strong>Tenancy ended:</strong> {{move_out_date}}</p>
<p>This is the written accounting of your security deposit.</p>
<table style="width:100%;border-collapse:collapse;margin:12px 0;">
<tr><td style="padding:6px 0;border-bottom:1px solid #ddd;">Security deposit held</td><td style="padding:6px 0;border-bottom:1px solid #ddd;text-align:right;">{{deposit_held}}</td></tr>
<tr><td style="padding:6px 0;border-bottom:1px solid #ddd;">Interest</td><td style="padding:6px 0;border-bottom:1px solid #ddd;text-align:right;">{{deposit_interest}}</td></tr>
<tr><td style="padding:6px 0;border-bottom:1px solid #ddd;">Withheld for damage (itemised below)</td><td style="padding:6px 0;border-bottom:1px solid #ddd;text-align:right;">{{total_deductions}}</td></tr>
<tr><td style="padding:6px 0;border-bottom:1px solid #ddd;">Applied to unpaid rent and charges</td><td style="padding:6px 0;border-bottom:1px solid #ddd;text-align:right;">{{other_owed}}</td></tr>
<tr><td style="padding:6px 0;"><strong>Returned to you</strong></td><td style="padding:6px 0;text-align:right;"><strong>{{amount_returned}}</strong></td></tr>
<tr><td style="padding:6px 0;"><strong>Balance you still owe</strong></td><td style="padding:6px 0;text-align:right;"><strong>{{balance_owed}}</strong></td></tr>
</table>
<h2 style="font-size:16px;">Items withheld, and the cost actually incurred</h2>
<p>{{deductions_list}}</p>
<p style="margin-top:32px;">{{sender_name}}<br/>{{landlord_name}}</p>`,
  },

  // ── Phase 1B: applicants ────────────────────────────────────────────
  home_leased_notice: {
    name: "Home No Longer Available", category: "notices", template_type: "html", signing_mode: "none", signer_roles: [],
    description: "Tells an applicant that the home they applied for has been leased to someone else. Sent only when staff choose to.",
    fields: [
      field("letter_date", "Date", "date", "Letter", "today", true),
      field("recipient_name", "Applicant", "text", "Letter", "tenant.name", true),
      field("property_address", "Home applied for", "text", "Letter", "property.address", true),
      field("closing_note", "Anything to add (optional)", "textarea", "Letter"),
      field("sender_name", "Sent by", "text", "From", "user.name"),
      field("landlord_name", "Landlord", "text", "From", "company.name"),
    ],
    field_config: {},
    body: `<p>{{letter_date}}</p>
<p>Dear {{recipient_name}},</p>
<p>Thank you for your interest in <strong>{{property_address}}</strong>. The home has now been leased to another applicant, so we are not able to offer it to you. Any lease that was sent to you for it has been withdrawn and does not need to be signed.</p>
<p>{{closing_note}}</p>
<p>We appreciate the time you put into applying and would be glad to hear from you about other homes.</p>
<p style="margin-top:32px;">{{sender_name}}<br/>{{landlord_name}}</p>`,
  },
};

// The stable key decides which kind of document a template makes; see
// DOC_KIND_BY_TEMPLATE_KEY in docService.js.

/**
 * Make sure a company has the standard template with this key. Returns the
 * template row, or null if it is not a standard one or could not be made.
 * Never touches a template the company already has under the key.
 */
export async function ensureStandardTemplate(companyId, templateKey, createdBy = "") {
  const def = STANDARD_TEMPLATES[templateKey];
  if (!def || !companyId) return null;
  const find = () => supabase.from("doc_templates").select("*").eq("company_id", companyId).eq("template_key", templateKey).eq("is_active", true).limit(1).maybeSingle();
  const existing = await find();
  if (existing.data) return existing.data;
  if (existing.error) { pmError("PM-7003", { raw: existing.error, context: "look up standard template " + templateKey, silent: true }); return null; }
  const { data, error } = await supabase.from("doc_templates").insert([{
    company_id: companyId, template_key: templateKey, name: def.name, category: def.category, description: def.description,
    template_type: def.template_type, signing_mode: def.signing_mode, signer_roles: def.signer_roles,
    body: def.body, fields: def.fields, field_config: def.field_config, is_active: true, is_system: true, created_by: createdBy || "standard-template",
  }]).select("*").maybeSingle();
  if (!error && data) return data;
  // Two screens asking at once: the unique index on (company, key) let one
  // of them win. Use the winner's.
  const again = await find();
  if (again.data) return again.data;
  pmError("PM-7003", { raw: error, context: "install standard template " + templateKey, silent: true });
  return null;
}

/** Install every standard template a company lacks. Returns the rows that were added. */
export async function ensureStandardTemplates(companyId, existingTemplates = [], createdBy = "") {
  const have = new Set((existingTemplates || []).map(t => t.template_key).filter(Boolean));
  const added = [];
  for (const key of Object.keys(STANDARD_TEMPLATES)) {
    if (have.has(key)) continue;
    const row = await ensureStandardTemplate(companyId, key, createdBy);
    if (row) added.push(row);
  }
  return added;
}
