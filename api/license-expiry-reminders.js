// Vercel API Route: License Expiry Reminders
// Daily cron — scans property_licenses and queues email reminders at
// 90/60/30/7/0 day buckets before expiry (and 1d post-expiry as a safety net).
// Uses last_reminder_day_bucket to avoid sending the same bucket twice.
const { createClient } = require("@supabase/supabase-js");

const CRON_SECRET = process.env.CRON_SECRET || "";

// Descending so the SMALLEST matching bucket wins (30 < 60 < 90).
// Negative = already expired.
const REMINDER_BUCKETS = [-1, 0, 7, 30, 60, 90];

const TYPE_LABELS = {
  rental_license: "Rental License",
  rental_registration: "Rental Registration",
  lead_paint: "Lead Paint Certificate",
  lead_risk_assessment: "Lead Risk Assessment",
  fire_inspection: "Fire Inspection Certificate",
  bbl: "Business License (DC BBL)",
  other: "License",
};

function daysBetween(todayIso, expiryIso) {
  const today = new Date(todayIso + "T00:00:00Z");
  const expiry = new Date(expiryIso + "T00:00:00Z");
  return Math.round((expiry - today) / 86_400_000);
}

function chooseBucket(daysUntil) {
  // Pick the tightest applicable bucket.
  // Expired: use -1 bucket.
  if (daysUntil < 0) return -1;
  if (daysUntil <= 0) return 0;
  if (daysUntil <= 7) return 7;
  if (daysUntil <= 30) return 30;
  if (daysUntil <= 60) return 60;
  if (daysUntil <= 90) return 90;
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://rental-manager-one.vercel.app");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const authHeader = req.headers.authorization || "";
  const bodySecret = (req.body && typeof req.body === "object" && req.body.cron_secret) || "";
  const isCronAuth = CRON_SECRET && CRON_SECRET.length >= 8 && (
    authHeader === `Bearer ${CRON_SECRET}` || bodySecret === CRON_SECRET
  );
  if (!isCronAuth) return res.status(401).json({ error: "Unauthorized" });

  try {
    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const todayIso = new Date().toISOString().slice(0, 10);

    // Scan candidates: any non-archived, non-revoked license expiring in the next 90 days
    // or already expired within the last 7 days (so we don't keep re-emailing stale records).
    const upperBound = new Date(Date.now() + 91 * 86_400_000).toISOString().slice(0, 10);
    const lowerBound = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

    const { data: licenses, error: licErr } = await supabase
      .from("property_licenses")
      .select("id, company_id, property_id, license_type, license_type_custom, license_number, jurisdiction, expiry_date, status, last_reminder_day_bucket")
      .is("archived_at", null)
      .neq("status", "revoked")
      .gte("expiry_date", lowerBound)
      .lte("expiry_date", upperBound);
    if (licErr) {
      console.error("license-reminder: license fetch failed", licErr.message);
      return res.status(500).json({ error: "License scan failed" });
    }

    let scanned = licenses.length;
    let queued = 0;
    let skippedNoBucket = 0;
    let skippedAlreadySent = 0;
    let skippedNoRecipients = 0;
    let errors = 0;

    // Cache property + member lookups per company to avoid N×M queries.
    const propCache = new Map();   // property_id -> address
    const memberCache = new Map(); // company_id -> [emails]

    for (const lic of licenses) {
      const daysUntil = daysBetween(todayIso, lic.expiry_date);
      const bucket = chooseBucket(daysUntil);
      if (bucket === null) { skippedNoBucket++; continue; }
      // Only send if we haven't sent a reminder at this (tighter-or-equal) bucket before.
      // last_reminder_day_bucket is the last bucket we alerted on. If the incoming bucket is
      // <= last (tighter or same), skip. If it's smaller (urgency increased), send again.
      // Special case: we also resend when moving into "expired" (-1) even if prior was 0.
      if (lic.last_reminder_day_bucket !== null && lic.last_reminder_day_bucket !== undefined) {
        if (bucket >= lic.last_reminder_day_bucket && bucket !== -1) { skippedAlreadySent++; continue; }
        if (bucket === -1 && lic.last_reminder_day_bucket === -1) { skippedAlreadySent++; continue; }
      }

      // Resolve property address (cached)
      let propertyAddress = propCache.get(lic.property_id);
      if (propertyAddress === undefined) {
        const { data: p } = await supabase.from("properties").select("address").eq("id", lic.property_id).maybeSingle();
        propertyAddress = p?.address || "(property)";
        propCache.set(lic.property_id, propertyAddress);
      }

      // Resolve recipients (cached) — admins, owners, PMs, office assistants
      let recipients = memberCache.get(lic.company_id);
      if (!recipients) {
        const { data: mems } = await supabase.from("company_members")
          .select("user_email, role")
          .eq("company_id", lic.company_id)
          .eq("status", "active")
          .in("role", ["admin", "owner", "pm", "office_assistant"]);
        recipients = (mems || []).map(m => m.user_email).filter(Boolean);
        memberCache.set(lic.company_id, recipients);
      }
      if (recipients.length === 0) { skippedNoRecipients++; continue; }

      const typeLabel = TYPE_LABELS[lic.license_type] || lic.license_type_custom || "License";
      const subjectLine = bucket === -1
        ? `EXPIRED: ${typeLabel} at ${propertyAddress}`
        : bucket === 0
          ? `Expires today: ${typeLabel} at ${propertyAddress}`
          : `${typeLabel} expires in ${daysUntil} days — ${propertyAddress}`;

      const notifData = {
        license_id: lic.id,
        property_id: lic.property_id,
        property_address: propertyAddress,
        license_type: typeLabel,
        license_number: lic.license_number || "",
        jurisdiction: lic.jurisdiction || "",
        expiry_date: lic.expiry_date,
        days_until_expiry: daysUntil,
        bucket,
        subject: subjectLine,
      };

      // Queue one row per recipient
      const rows = recipients.map(email => ({
        company_id: lic.company_id,
        type: "license_expiring",
        recipient_email: email.toLowerCase(),
        data: notifData,
        status: "pending",
      }));

      const { error: insErr } = await supabase.from("notification_queue").insert(rows);
      if (insErr) {
        errors++;
        console.error("license-reminder: queue insert failed", insErr.message);
        continue;
      }

      // Mark license so we don't re-notify for the same bucket
      const { error: updErr } = await supabase.from("property_licenses")
        .update({ last_reminder_sent_at: new Date().toISOString(), last_reminder_day_bucket: bucket })
        .eq("id", lic.id);
      if (updErr) {
        errors++;
        console.error("license-reminder: bucket update failed", updErr.message);
      }

      queued += rows.length;
    }

    return res.status(200).json({
      scanned,
      queued_emails: queued,
      skipped_out_of_window: skippedNoBucket,
      skipped_already_sent: skippedAlreadySent,
      skipped_no_recipients: skippedNoRecipients,
      errors,
    });
  } catch (e) {
    console.error("license-reminder error:", e.message);
    return res.status(500).json({ error: "Reminder scan failed" });
  }
};
