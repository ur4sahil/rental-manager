import { supabase } from "../supabase";
import { escapeFilterValue } from "./helpers";

// Recipient resolver for the admin-driven notification config.
//
// notification_settings.custom_recipients is a JSON array. Each entry:
//   { kind: 'role'|'user'|'tenant'|'owner'|'manager'|'property_manager'|'email',
//     value: 'admin' | 'jdoe@x.com' | null }
//
// `tenant`/`owner`/`manager`/`property_manager` resolve from the event's
// data payload (and fall back to DB lookups if the email isn't already
// stamped on the payload). `role` expands to every active company_members
// row with that role. `user`/`email` are literal addresses.
//
// Returns { primary, cc, bcc } — each a deduped, lowercased array of
// email addresses. The caller (queueNotification) inserts one
// notification_queue row per primary recipient, copying cc/bcc onto
// each row.
//
// Back-compat: if custom_recipients is empty, the caller falls through
// to the legacy single-recipient path. This util doesn't try to
// emulate the legacy 'all'/'tenant'/'admin' string mapping — that's
// the caller's job.

const VALID_KINDS = new Set(["role", "user", "tenant", "owner", "manager", "property_manager", "email"]);

function dedupeLower(emails) {
  const out = new Set();
  for (const e of emails) {
    const v = (e || "").toString().trim().toLowerCase();
    if (v && v.includes("@")) out.add(v);
  }
  return Array.from(out);
}

async function expandEntry(entry, ctx) {
  if (!entry || !VALID_KINDS.has(entry.kind)) return [];
  const { kind, value } = entry;
  const { companyId, data } = ctx;

  if (kind === "email" || kind === "user") {
    return value ? [value] : [];
  }

  if (kind === "role") {
    if (!value) return [];
    const { data: rows } = await supabase.from("company_members")
      .select("user_email")
      .eq("company_id", companyId).eq("status", "active").eq("role", value);
    return (rows || []).map(r => r.user_email).filter(Boolean);
  }

  if (kind === "tenant") {
    // Prefer email already on the payload, else look up by name +
    // property. Same disambiguation pattern the rest of the app uses
    // — tenant_id is reliable but data carriers don't always include it.
    if (data?.tenant_email) return [data.tenant_email];
    if (data?.tenant && data?.property) {
      const { data: t } = await supabase.from("tenants").select("email")
        .eq("company_id", companyId)
        .ilike("name", escapeFilterValue(data.tenant))
        .eq("property", data.property)
        .is("archived_at", null).maybeSingle();
      if (t?.email) return [t.email];
    }
    return [];
  }

  if (kind === "owner") {
    if (data?.owner_email) return [data.owner_email];
    if (data?.property) {
      const { data: o } = await supabase.from("owners").select("email")
        .eq("company_id", companyId).eq("property", data.property)
        .maybeSingle();
      if (o?.email) return [o.email];
    }
    return [];
  }

  if (kind === "manager" || kind === "property_manager") {
    // Manager-of-record for the property. Property's manager_email
    // takes precedence; fall back to data.manager_email if the caller
    // already resolved it.
    if (data?.manager_email) return [data.manager_email];
    if (data?.property) {
      const { data: p } = await supabase.from("properties").select("manager_email")
        .eq("company_id", companyId).eq("address", data.property)
        .maybeSingle();
      if (p?.manager_email) return [p.manager_email];
    }
    return [];
  }

  return [];
}

export async function resolveRecipients(companyId, type, data, settingsRow) {
  const ctx = { companyId, data: data || {} };

  async function expandList(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const all = await Promise.all(arr.map(e => expandEntry(e, ctx)));
    return dedupeLower(all.flat());
  }

  const primary = await expandList(settingsRow?.custom_recipients);
  const cc = await expandList(settingsRow?.cc);
  const bcc = await expandList(settingsRow?.bcc);
  return { primary, cc, bcc };
}

// Helper used by the Admin UI's preview / "Send test" flow so the
// editor can show "this rule resolves to N recipients right now"
// without going through the queue.
export async function previewRecipients(companyId, settingsRow) {
  return resolveRecipients(companyId, settingsRow?.event_type, {}, settingsRow);
}
