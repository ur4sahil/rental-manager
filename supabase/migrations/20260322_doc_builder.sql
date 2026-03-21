-- ============================================================
-- Document Builder: Templates + Generated Documents
-- ============================================================

-- Templates: reusable document templates with merge fields
CREATE TABLE IF NOT EXISTS doc_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT DEFAULT '',
  -- HTML body with {{merge_field}} placeholders
  body TEXT NOT NULL DEFAULT '',
  -- JSON array of field definitions
  -- Each: { name, label, type, required, section, options, default_value, prefill_from }
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Whether this is a system-seeded template (non-deletable)
  is_system BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Generated documents: instances created from templates
CREATE TABLE IF NOT EXISTS doc_generated (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL,
  template_id UUID REFERENCES doc_templates(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  -- Snapshot of field values used to generate this document
  field_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Final rendered HTML body (merge fields replaced)
  rendered_body TEXT NOT NULL DEFAULT '',
  -- Status: draft, final, sent
  status TEXT DEFAULT 'draft',
  -- Optional linkage
  property_id TEXT,
  property_address TEXT,
  tenant_name TEXT,
  -- Recipients for email delivery
  recipients JSONB DEFAULT '[]'::jsonb,
  -- Storage path for exported PDF
  file_path TEXT,
  -- Metadata
  created_by TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_doc_templates_company ON doc_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_doc_generated_company ON doc_generated(company_id);
CREATE INDEX IF NOT EXISTS idx_doc_generated_template ON doc_generated(template_id);
CREATE INDEX IF NOT EXISTS idx_doc_generated_status ON doc_generated(status);

-- RLS
ALTER TABLE doc_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_generated ENABLE ROW LEVEL SECURITY;

CREATE POLICY "doc_templates_company" ON doc_templates
  FOR ALL USING (company_id IN (
    SELECT company_id FROM company_members WHERE auth_user_id = auth.uid() AND status = 'active'
  ));

CREATE POLICY "doc_generated_company" ON doc_generated
  FOR ALL USING (company_id IN (
    SELECT company_id FROM company_members WHERE auth_user_id = auth.uid() AND status = 'active'
  ));

-- ============================================================
-- Seed starter templates (company_id will be set per-company on first load)
-- We use a special sentinel company_id '00000000-0000-0000-0000-000000000000'
-- for system templates. The app clones these into each company on first use.
-- ============================================================

-- Helper: Notice to Pay or Quit
INSERT INTO doc_templates (id, company_id, name, category, description, is_system, body, fields) VALUES
(gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'Notice to Pay or Quit', 'notices',
'Demand notice for overdue rent payment. Requires tenant and property information.', true,
'<h1 style="text-align:center;font-size:20px;margin-bottom:24px;">NOTICE TO PAY RENT OR QUIT</h1>
<p><strong>Date:</strong> {{notice_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{property_address}}<br/>{{unit_number}}</p>
<hr/>
<p>Dear {{tenant_name}},</p>
<p>You are hereby notified that rent in the amount of <strong>{{amount_owed}}</strong> for the period of <strong>{{rent_period}}</strong> is past due and owing.</p>
<p>You are required to pay the full amount within <strong>{{cure_days}}</strong> days of receiving this notice, or vacate and surrender possession of the premises.</p>
<p>If payment is not received by <strong>{{deadline_date}}</strong>, legal proceedings may be initiated to recover possession and any amounts owed, including court costs and attorney fees as allowed by law.</p>
<p>Payment should be made to: <strong>{{payee_name}}</strong></p>
<p>Payment method: {{payment_method}}</p>
<br/>
<p>Sincerely,</p>
<p>{{sender_name}}<br/>{{sender_title}}<br/>{{sender_phone}}<br/>{{sender_email}}</p>',
'[
  {"name":"notice_date","label":"Notice Date","type":"date","required":true,"section":"Notice Details","prefill_from":"today"},
  {"name":"tenant_name","label":"Tenant Name","type":"text","required":true,"section":"Tenant Information","prefill_from":"tenant.name"},
  {"name":"property_address","label":"Property Address","type":"text","required":true,"section":"Property Information","prefill_from":"property.address"},
  {"name":"unit_number","label":"Unit Number","type":"text","required":false,"section":"Property Information","prefill_from":"property.unit"},
  {"name":"amount_owed","label":"Amount Owed","type":"currency","required":true,"section":"Notice Details","prefill_from":"tenant.balance"},
  {"name":"rent_period","label":"Rent Period","type":"text","required":true,"section":"Notice Details"},
  {"name":"cure_days","label":"Days to Cure","type":"number","required":true,"section":"Notice Details","default_value":"5"},
  {"name":"deadline_date","label":"Payment Deadline","type":"date","required":true,"section":"Notice Details"},
  {"name":"payee_name","label":"Payee Name","type":"text","required":true,"section":"Payment Details","prefill_from":"company.name"},
  {"name":"payment_method","label":"Payment Method","type":"text","required":false,"section":"Payment Details","default_value":"Check, ACH, or Online Portal"},
  {"name":"sender_name","label":"Sender Name","type":"text","required":true,"section":"Sender","prefill_from":"user.name"},
  {"name":"sender_title","label":"Sender Title","type":"text","required":false,"section":"Sender","default_value":"Property Manager"},
  {"name":"sender_phone","label":"Sender Phone","type":"text","required":false,"section":"Sender"},
  {"name":"sender_email","label":"Sender Email","type":"text","required":false,"section":"Sender","prefill_from":"user.email"}
]'::jsonb),

(gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'Notice to Vacate', 'notices',
'Notice requiring tenant to vacate the premises.', true,
'<h1 style="text-align:center;font-size:20px;margin-bottom:24px;">NOTICE TO VACATE</h1>
<p><strong>Date:</strong> {{notice_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{property_address}}<br/>{{unit_number}}</p>
<hr/>
<p>Dear {{tenant_name}},</p>
<p>This letter serves as formal notice that you are required to vacate the premises located at <strong>{{property_address}}</strong> by <strong>{{vacate_date}}</strong>.</p>
<p><strong>Reason:</strong> {{vacate_reason}}</p>
<p>Please ensure the following before move-out:</p>
<ul>
<li>Remove all personal belongings</li>
<li>Clean the unit to move-in condition</li>
<li>Return all keys and access devices</li>
<li>Provide a forwarding address for security deposit return</li>
</ul>
<p>Your security deposit of <strong>{{security_deposit}}</strong> will be handled according to state law. Any deductions will be itemized and the balance returned within the legally required timeframe.</p>
<p>If you have questions, contact us at {{sender_phone}} or {{sender_email}}.</p>
<br/>
<p>Sincerely,</p>
<p>{{sender_name}}<br/>{{sender_title}}</p>',
'[
  {"name":"notice_date","label":"Notice Date","type":"date","required":true,"section":"Notice Details","prefill_from":"today"},
  {"name":"tenant_name","label":"Tenant Name","type":"text","required":true,"section":"Tenant Information","prefill_from":"tenant.name"},
  {"name":"property_address","label":"Property Address","type":"text","required":true,"section":"Property Information","prefill_from":"property.address"},
  {"name":"unit_number","label":"Unit Number","type":"text","required":false,"section":"Property Information"},
  {"name":"vacate_date","label":"Vacate By Date","type":"date","required":true,"section":"Notice Details"},
  {"name":"vacate_reason","label":"Reason for Vacate","type":"select","required":true,"section":"Notice Details","options":["Lease expiration","Non-payment of rent","Lease violation","Owner move-in","Property renovation","Other"]},
  {"name":"security_deposit","label":"Security Deposit Amount","type":"currency","required":false,"section":"Financial","prefill_from":"tenant.security_deposit"},
  {"name":"sender_name","label":"Sender Name","type":"text","required":true,"section":"Sender","prefill_from":"user.name"},
  {"name":"sender_title","label":"Title","type":"text","required":false,"section":"Sender","default_value":"Property Manager"},
  {"name":"sender_phone","label":"Phone","type":"text","required":false,"section":"Sender"},
  {"name":"sender_email","label":"Email","type":"text","required":false,"section":"Sender","prefill_from":"user.email"}
]'::jsonb),

(gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'Lease Renewal Offer', 'leases',
'Offer to renew an expiring lease with updated terms.', true,
'<h1 style="text-align:center;font-size:20px;margin-bottom:24px;">LEASE RENEWAL OFFER</h1>
<p><strong>Date:</strong> {{offer_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{property_address}}</p>
<hr/>
<p>Dear {{tenant_name}},</p>
<p>Your current lease for <strong>{{property_address}}</strong> is set to expire on <strong>{{current_lease_end}}</strong>. We are pleased to offer you a lease renewal under the following terms:</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr style="border-bottom:1px solid #ddd;"><td style="padding:8px;font-weight:bold;">New Lease Term</td><td style="padding:8px;">{{new_start_date}} to {{new_end_date}}</td></tr>
<tr style="border-bottom:1px solid #ddd;"><td style="padding:8px;font-weight:bold;">Monthly Rent</td><td style="padding:8px;">{{new_rent}}</td></tr>
<tr style="border-bottom:1px solid #ddd;"><td style="padding:8px;font-weight:bold;">Security Deposit</td><td style="padding:8px;">{{security_deposit}}</td></tr>
</table>
<p>{{additional_terms}}</p>
<p>Please respond by <strong>{{response_deadline}}</strong> to accept or discuss these terms. If we do not hear from you by this date, the lease will expire as scheduled and move-out procedures will apply.</p>
<br/>
<p>Sincerely,</p>
<p>{{sender_name}}<br/>{{sender_title}}<br/>{{sender_email}}</p>
<br/>
<p style="margin-top:32px;border-top:1px solid #999;padding-top:12px;"><strong>Tenant Acknowledgment</strong></p>
<p>☐ I accept the renewal terms above<br/>☐ I decline and will vacate by {{current_lease_end}}<br/>☐ I would like to discuss modified terms</p>
<p>Signature: ______________________________ &nbsp; Date: ______________</p>',
'[
  {"name":"offer_date","label":"Offer Date","type":"date","required":true,"section":"Offer Details","prefill_from":"today"},
  {"name":"tenant_name","label":"Tenant Name","type":"text","required":true,"section":"Tenant Information","prefill_from":"tenant.name"},
  {"name":"property_address","label":"Property Address","type":"text","required":true,"section":"Property Information","prefill_from":"property.address"},
  {"name":"current_lease_end","label":"Current Lease End","type":"date","required":true,"section":"Current Lease","prefill_from":"lease.end_date"},
  {"name":"new_start_date","label":"New Start Date","type":"date","required":true,"section":"New Terms"},
  {"name":"new_end_date","label":"New End Date","type":"date","required":true,"section":"New Terms"},
  {"name":"new_rent","label":"New Monthly Rent","type":"currency","required":true,"section":"New Terms","prefill_from":"lease.rent_amount"},
  {"name":"security_deposit","label":"Security Deposit","type":"currency","required":false,"section":"New Terms","prefill_from":"tenant.security_deposit"},
  {"name":"additional_terms","label":"Additional Terms","type":"textarea","required":false,"section":"New Terms","default_value":"All other terms and conditions of the original lease remain in effect."},
  {"name":"response_deadline","label":"Response Deadline","type":"date","required":true,"section":"Offer Details"},
  {"name":"sender_name","label":"Sender Name","type":"text","required":true,"section":"Sender","prefill_from":"user.name"},
  {"name":"sender_title","label":"Title","type":"text","required":false,"section":"Sender","default_value":"Property Manager"},
  {"name":"sender_email","label":"Email","type":"text","required":false,"section":"Sender","prefill_from":"user.email"}
]'::jsonb),

(gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'Rent Increase Notice', 'notices',
'Formal notification of upcoming rent increase.', true,
'<h1 style="text-align:center;font-size:20px;margin-bottom:24px;">NOTICE OF RENT INCREASE</h1>
<p><strong>Date:</strong> {{notice_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{property_address}}</p>
<hr/>
<p>Dear {{tenant_name}},</p>
<p>This letter is to notify you that effective <strong>{{effective_date}}</strong>, your monthly rent will increase from <strong>{{current_rent}}</strong> to <strong>{{new_rent}}</strong>.</p>
<p>This represents an increase of <strong>{{increase_amount}}</strong> ({{increase_pct}}%).</p>
<p><strong>Reason:</strong> {{increase_reason}}</p>
<p>This notice is provided in accordance with the required {{notice_days}}-day advance notice period. All other terms of your lease remain unchanged.</p>
<p>If you have any questions or concerns, please contact us.</p>
<br/>
<p>Sincerely,</p>
<p>{{sender_name}}<br/>{{sender_title}}<br/>{{sender_phone}}</p>',
'[
  {"name":"notice_date","label":"Notice Date","type":"date","required":true,"section":"Notice Details","prefill_from":"today"},
  {"name":"tenant_name","label":"Tenant Name","type":"text","required":true,"section":"Tenant","prefill_from":"tenant.name"},
  {"name":"property_address","label":"Property Address","type":"text","required":true,"section":"Property","prefill_from":"property.address"},
  {"name":"effective_date","label":"Effective Date","type":"date","required":true,"section":"Rent Change"},
  {"name":"current_rent","label":"Current Rent","type":"currency","required":true,"section":"Rent Change","prefill_from":"lease.rent_amount"},
  {"name":"new_rent","label":"New Rent","type":"currency","required":true,"section":"Rent Change"},
  {"name":"increase_amount","label":"Increase Amount","type":"currency","required":false,"section":"Rent Change"},
  {"name":"increase_pct","label":"Increase %","type":"number","required":false,"section":"Rent Change"},
  {"name":"increase_reason","label":"Reason","type":"select","required":true,"section":"Rent Change","options":["Annual adjustment","Market rate adjustment","Property improvements","Increased operating costs","Lease renewal terms","Other"]},
  {"name":"notice_days","label":"Notice Period (days)","type":"number","required":true,"section":"Notice Details","default_value":"60"},
  {"name":"sender_name","label":"Sender Name","type":"text","required":true,"section":"Sender","prefill_from":"user.name"},
  {"name":"sender_title","label":"Title","type":"text","required":false,"section":"Sender","default_value":"Property Manager"},
  {"name":"sender_phone","label":"Phone","type":"text","required":false,"section":"Sender"}
]'::jsonb),

(gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'Late Fee Notice', 'notices',
'Notification of late fee applied to tenant account.', true,
'<h1 style="text-align:center;font-size:20px;margin-bottom:24px;">LATE FEE NOTICE</h1>
<p><strong>Date:</strong> {{notice_date}}</p>
<p><strong>To:</strong> {{tenant_name}}<br/>{{property_address}}</p>
<hr/>
<p>Dear {{tenant_name}},</p>
<p>This notice is to inform you that a late fee of <strong>{{late_fee_amount}}</strong> has been applied to your account for the rental period of <strong>{{rent_period}}</strong>.</p>
<p><strong>Original Rent Due:</strong> {{rent_due_date}}<br/>
<strong>Payment Received:</strong> {{payment_received_date}}<br/>
<strong>Days Late:</strong> {{days_late}}<br/>
<strong>Late Fee:</strong> {{late_fee_amount}}</p>
<p><strong>Total Amount Now Due:</strong> {{total_due}}</p>
<p>Per your lease agreement, rent is due on the {{due_day}} of each month with a {{grace_days}}-day grace period. Late fees are assessed at {{fee_structure}}.</p>
<p>Please remit payment promptly to avoid further charges.</p>
<br/>
<p>Sincerely,</p>
<p>{{sender_name}}<br/>{{sender_title}}</p>',
'[
  {"name":"notice_date","label":"Notice Date","type":"date","required":true,"section":"Notice","prefill_from":"today"},
  {"name":"tenant_name","label":"Tenant Name","type":"text","required":true,"section":"Tenant","prefill_from":"tenant.name"},
  {"name":"property_address","label":"Property Address","type":"text","required":true,"section":"Property","prefill_from":"property.address"},
  {"name":"rent_period","label":"Rent Period","type":"text","required":true,"section":"Late Fee Details"},
  {"name":"rent_due_date","label":"Rent Due Date","type":"date","required":true,"section":"Late Fee Details"},
  {"name":"payment_received_date","label":"Payment Received","type":"date","required":false,"section":"Late Fee Details"},
  {"name":"days_late","label":"Days Late","type":"number","required":true,"section":"Late Fee Details"},
  {"name":"late_fee_amount","label":"Late Fee Amount","type":"currency","required":true,"section":"Late Fee Details"},
  {"name":"total_due","label":"Total Amount Due","type":"currency","required":true,"section":"Late Fee Details","prefill_from":"tenant.balance"},
  {"name":"due_day","label":"Rent Due Day","type":"number","required":false,"section":"Lease Terms","default_value":"1"},
  {"name":"grace_days","label":"Grace Period Days","type":"number","required":false,"section":"Lease Terms","default_value":"5"},
  {"name":"fee_structure","label":"Fee Structure","type":"text","required":false,"section":"Lease Terms","default_value":"$50 flat fee"},
  {"name":"sender_name","label":"Sender Name","type":"text","required":true,"section":"Sender","prefill_from":"user.name"},
  {"name":"sender_title","label":"Title","type":"text","required":false,"section":"Sender","default_value":"Property Manager"}
]'::jsonb),

(gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'Lease Addendum', 'leases',
'Amendment or addendum to an existing lease agreement.', true,
'<h1 style="text-align:center;font-size:20px;margin-bottom:24px;">LEASE ADDENDUM</h1>
<p><strong>Date:</strong> {{addendum_date}}</p>
<p>This addendum is made to the lease agreement dated <strong>{{original_lease_date}}</strong> between:</p>
<p><strong>Landlord/Manager:</strong> {{landlord_name}}<br/>
<strong>Tenant:</strong> {{tenant_name}}<br/>
<strong>Property:</strong> {{property_address}}</p>
<hr/>
<h2 style="font-size:16px;">Amendment</h2>
<p>The following changes are hereby made to the original lease agreement:</p>
<div style="background:#f9f9f9;padding:16px;border-radius:8px;margin:12px 0;">{{addendum_text}}</div>
<p><strong>Effective Date:</strong> {{effective_date}}</p>
<p>All other terms and conditions of the original lease agreement remain in full force and effect except as specifically modified by this addendum.</p>
<br/>
<p style="margin-top:32px;border-top:1px solid #999;padding-top:12px;">
<strong>Landlord/Manager:</strong><br/>
Signature: ______________________________ &nbsp; Date: ______________<br/>
Name: {{landlord_name}}</p>
<p><strong>Tenant:</strong><br/>
Signature: ______________________________ &nbsp; Date: ______________<br/>
Name: {{tenant_name}}</p>',
'[
  {"name":"addendum_date","label":"Addendum Date","type":"date","required":true,"section":"Details","prefill_from":"today"},
  {"name":"original_lease_date","label":"Original Lease Date","type":"date","required":true,"section":"Original Lease","prefill_from":"lease.start_date"},
  {"name":"landlord_name","label":"Landlord/Manager Name","type":"text","required":true,"section":"Parties","prefill_from":"company.name"},
  {"name":"tenant_name","label":"Tenant Name","type":"text","required":true,"section":"Parties","prefill_from":"tenant.name"},
  {"name":"property_address","label":"Property Address","type":"text","required":true,"section":"Property","prefill_from":"property.address"},
  {"name":"addendum_text","label":"Amendment Text","type":"textarea","required":true,"section":"Amendment"},
  {"name":"effective_date","label":"Effective Date","type":"date","required":true,"section":"Details"}
]'::jsonb),

(gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'Maintenance Authorization', 'maintenance',
'Authorization for maintenance or repair work.', true,
'<h1 style="text-align:center;font-size:20px;margin-bottom:24px;">MAINTENANCE AUTHORIZATION</h1>
<p><strong>Date:</strong> {{auth_date}}</p>
<p><strong>Property:</strong> {{property_address}}<br/>
<strong>Tenant:</strong> {{tenant_name}}<br/>
<strong>Unit:</strong> {{unit_number}}</p>
<hr/>
<h2 style="font-size:16px;">Work Description</h2>
<p>{{work_description}}</p>
<h2 style="font-size:16px;">Details</h2>
<table style="width:100%;border-collapse:collapse;">
<tr style="border-bottom:1px solid #ddd;"><td style="padding:8px;font-weight:bold;">Vendor/Contractor</td><td style="padding:8px;">{{vendor_name}}</td></tr>
<tr style="border-bottom:1px solid #ddd;"><td style="padding:8px;font-weight:bold;">Estimated Cost</td><td style="padding:8px;">{{estimated_cost}}</td></tr>
<tr style="border-bottom:1px solid #ddd;"><td style="padding:8px;font-weight:bold;">Scheduled Date</td><td style="padding:8px;">{{scheduled_date}}</td></tr>
<tr style="border-bottom:1px solid #ddd;"><td style="padding:8px;font-weight:bold;">Priority</td><td style="padding:8px;">{{priority}}</td></tr>
</table>
<p style="margin-top:16px;">{{special_instructions}}</p>
<p><strong>Tenant Entry Permission:</strong> {{entry_permission}}</p>
<br/>
<p>Authorized by: {{sender_name}} ({{sender_title}})</p>',
'[
  {"name":"auth_date","label":"Date","type":"date","required":true,"section":"Details","prefill_from":"today"},
  {"name":"property_address","label":"Property Address","type":"text","required":true,"section":"Property","prefill_from":"property.address"},
  {"name":"tenant_name","label":"Tenant Name","type":"text","required":false,"section":"Property","prefill_from":"tenant.name"},
  {"name":"unit_number","label":"Unit","type":"text","required":false,"section":"Property"},
  {"name":"work_description","label":"Work Description","type":"textarea","required":true,"section":"Work Details"},
  {"name":"vendor_name","label":"Vendor/Contractor","type":"text","required":true,"section":"Work Details"},
  {"name":"estimated_cost","label":"Estimated Cost","type":"currency","required":true,"section":"Work Details"},
  {"name":"scheduled_date","label":"Scheduled Date","type":"date","required":true,"section":"Work Details"},
  {"name":"priority","label":"Priority","type":"select","required":true,"section":"Work Details","options":["Low","Normal","High","Emergency"],"default_value":"Normal"},
  {"name":"special_instructions","label":"Special Instructions","type":"textarea","required":false,"section":"Additional"},
  {"name":"entry_permission","label":"Tenant Entry Permission","type":"select","required":true,"section":"Additional","options":["Tenant will be present","Permission to enter when tenant is away","Contact tenant to schedule","Emergency entry authorized"]},
  {"name":"sender_name","label":"Authorized By","type":"text","required":true,"section":"Sender","prefill_from":"user.name"},
  {"name":"sender_title","label":"Title","type":"text","required":false,"section":"Sender","default_value":"Property Manager"}
]'::jsonb),

(gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'General Letter', 'general',
'Blank letter template for custom correspondence.', true,
'<div style="text-align:right;margin-bottom:24px;">
<p>{{sender_name}}<br/>{{company_name}}<br/>{{sender_address}}<br/>{{sender_phone}}<br/>{{sender_email}}</p>
</div>
<p>{{letter_date}}</p>
<p>{{recipient_name}}<br/>{{recipient_address}}</p>
<p>Re: {{subject_line}}</p>
<hr/>
<p>Dear {{recipient_name}},</p>
<div>{{letter_body}}</div>
<br/>
<p>Sincerely,</p>
<p>{{sender_name}}<br/>{{sender_title}}</p>',
'[
  {"name":"letter_date","label":"Date","type":"date","required":true,"section":"Letter Details","prefill_from":"today"},
  {"name":"subject_line","label":"Subject/Re Line","type":"text","required":true,"section":"Letter Details"},
  {"name":"recipient_name","label":"Recipient Name","type":"text","required":true,"section":"Recipient"},
  {"name":"recipient_address","label":"Recipient Address","type":"textarea","required":false,"section":"Recipient"},
  {"name":"letter_body","label":"Letter Body","type":"textarea","required":true,"section":"Content"},
  {"name":"company_name","label":"Company Name","type":"text","required":false,"section":"Sender","prefill_from":"company.name"},
  {"name":"sender_name","label":"Your Name","type":"text","required":true,"section":"Sender","prefill_from":"user.name"},
  {"name":"sender_title","label":"Title","type":"text","required":false,"section":"Sender","default_value":"Property Manager"},
  {"name":"sender_address","label":"Company Address","type":"textarea","required":false,"section":"Sender"},
  {"name":"sender_phone","label":"Phone","type":"text","required":false,"section":"Sender"},
  {"name":"sender_email","label":"Email","type":"text","required":false,"section":"Sender","prefill_from":"user.email"}
]'::jsonb);
