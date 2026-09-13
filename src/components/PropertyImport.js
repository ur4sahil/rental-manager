// ============ BULK PROPERTY IMPORT ============
//
// Download a workbook pre-filled with what you already have, fill the
// gaps, upload it back. Nothing is written until the preview has shown
// exactly what will change -- in particular every address change, because
// the accounting class is named after the address and renaming it moves
// years of ledger history.
//
// No journal entries are ever posted here. The books are left exactly as
// the QuickBooks import left them.

import React, { useState, useMemo } from "react";
import ExcelJS from "exceljs";
import { supabase } from "../supabase";
import { Btn, FileInput, TextLink } from "../ui";
import { Spinner } from "./shared";
import { pmError } from "../utils/errors";
import { logAudit } from "../utils/audit";
import { guardSubmit, guardRelease } from "../utils/guards";
import { encryptCredential } from "../utils/encryption";
import {
  PROPERTY_COLUMNS, TENANT_COLUMNS, SHEET_PROPERTIES, SHEET_TENANTS,
  buildTemplate, parseWorkbook, buildImportPlan, inferTenantStatus, computeAddress,
  cellString,
} from "../utils/propertyImport";
import { ACTIVE_LEASE } from "../utils/helpers";

const STEPS = [
  { id: "download", label: "Download" },
  { id: "upload",   label: "Upload" },
  { id: "preview",  label: "Review" },
  { id: "done",     label: "Done" },
];

// mode "add" creates only: the template carries no ID column, so a row
// cannot be aimed at an existing record. mode "edit" is the round trip.
export default function PropertyImport({ companyId, companyName, properties = [], showToast, onImported, mode = "edit" }) {
  const isAdd = mode === "add";
  const [step, setStep] = useState("download");
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [plan, setPlan] = useState(null);
  const [existing, setExisting] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);

  // Everything the template needs, and the same snapshot the plan is
  // validated against -- so what you download and what you upload against
  // cannot drift apart mid-session.
  async function loadExisting() {
    const [{ data: props }, { data: tens }, { data: owners }, { data: accts }] = await Promise.all([
      supabase.from("properties").select("id,address,address_line_1,address_line_2,city,state,zip,county,short_name,type,status,bedrooms,bathrooms,sqft,owner_name,rent,security_deposit,notes")
        .eq("company_id", companyId).is("archived_at", null).order("address"),
      supabase.from("tenants").select("id,name,property,email,phone,move_in,move_out,lease_start,lease_end_date,rent,balance,is_voucher,voucher_number,tenant_portion,voucher_portion,lease_status")
        .eq("company_id", companyId).is("archived_at", null).order("name"),
      supabase.from("owners").select("name").eq("company_id", companyId).is("archived_at", null),
      supabase.from("acct_accounts").select("id,tenant_id").eq("company_id", companyId).not("tenant_id", "is", null),
    ]);

    // Ledger recency per tenant. This is what decides Current vs Past --
    // balance looks like a clean signal on this data but is a coincidence
    // of it: someone paid up in full looks identical to someone who left.
    const arByTenant = new Map((accts || []).map(a => [String(a.tenant_id), a.id]));
    const accountIds = (accts || []).map(a => a.id);
    const activity = new Map();
    // PostgREST returns at most 1000 rows unless you page. This asked for
    // every AR journal line at once and silently got the first 1000 of
    // 4128, so three quarters of the ledger was invisible: tenants with
    // months of activity looked dormant, and the Status column the sheet
    // pre-fills put 36 of 73 into "Review" for a human to sort out. One
    // of them had 103 lines and activity eight days earlier.
    //
    // Ordered, because range() without an ORDER BY is not stable -- rows
    // can repeat across pages and others never appear at all.
    for (let i = 0; i < accountIds.length; i += 100) {
      const chunk = accountIds.slice(i, i + 100);
      for (let from = 0; ; from += 1000) {
        const { data: lines, error } = await supabase
          .from("acct_journal_lines")
          .select("account_id, acct_journal_entries!inner(date)")
          .eq("company_id", companyId).in("account_id", chunk)
          .order("account_id", { ascending: true })
          .range(from, from + 999);
        if (error) {
          pmError("PM-2013", { raw: error, context: "reading tenant ledger activity for import", silent: true });
          break;
        }
        for (const l of lines || []) {
          const d = l.acct_journal_entries?.date;
          const cur = activity.get(l.account_id) || { last: null, n: 0 };
          cur.n += 1;
          if (!cur.last || (d && d > cur.last)) cur.last = d;
          activity.set(l.account_id, cur);
        }
        if (!lines || lines.length < 1000) break;
      }
    }

    const tenantRows = (tens || []).map(t => {
      const arId = arByTenant.get(String(t.id)) || null;
      const act = arId ? activity.get(arId) : null;
      const enriched = {
        ...t, arAccountId: arId,
        lastActivity: act?.last || null, ledgerLines: act?.n || 0,
      };
      return {
        ...t,
        tenant_status: inferTenantStatus(enriched),
        is_voucher: t.is_voucher ? "Yes" : "No",
        _balance: t.balance, _lastActivity: act?.last || null, _ledgerLines: act?.n || 0,
      };
    });

    return {
      properties: (props || []).map(p => ({ ...p, short_name: p.short_name || p.address })),
      tenants: tenantRows,
      owners: [...new Set((owners || []).map(o => o.name).filter(Boolean))],
    };
  }

  async function handleDownload() {
    if (!guardSubmit("propImportDownload")) return;
    setBusy(true);
    try {
      const data = await loadExisting();
      setExisting(data);
      const wb = await buildTemplate(ExcelJS, {
        companyName, properties: data.properties, tenants: data.tenants, owners: data.owners,
        mode,
      });
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(companyName || "properties").replace(/[^\w-]+/g, "_")}-${isAdd ? "new-properties" : "edit-properties"}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setStep("upload");
    } catch (e) {
      pmError("PM-2010", { raw: e, context: "build property import template" });
    } finally { setBusy(false); guardRelease("propImportDownload"); }
  }

  async function handleFile(file) {
    if (!file) return;
    setBusy(true);
    try {
      // Re-read current state rather than trusting the snapshot taken at
      // download time: the sheet may have been filled in over days.
      const data = existing || await loadExisting();
      setExisting(data);
      const buf = await file.arrayBuffer();
      const p = await parseWorkbook(ExcelJS, buf);
      if (p.fatal.length) { showToast(p.fatal[0], "error"); return; }
      setParsed(p);
      setPlan(buildImportPlan({
        properties: p.properties, tenants: p.tenants,
        existingProperties: data.properties, existingTenants: data.tenants,
        utilities: p.utilities, hoas: p.hoas, loan: p.loan,
        insurance: p.insurance, taxes: p.taxes, recurring: p.recurring,
        archivedTenantIds: data.archivedTenantIds,
      }));
      setStep("preview");
    } catch (e) {
      pmError("PM-2011", { raw: e, context: "parse property import workbook" });
      showToast("Could not read that file. Is it the downloaded template?", "error");
    } finally { setBusy(false); }
  }

  // The spreadsheet carries logins in plaintext; the database has no
  // plaintext column for them. Encrypt on the way in, exactly as the
  // wizard does -- same helper, same shape -- so a row typed into Excel
  // is stored no differently from one typed into the app.
  const NO_CREDS = { username_encrypted: null, password_encrypted: null,
                     encryption_iv: null, encryption_salt: null, encryption_iv_username: null };

  // Credentials are encrypted by /api/encrypt. When that call fails --
  // the endpoint down, a network blip, or a dev server that does not
  // serve /api at all -- encryptCredential throws, and it used to take
  // the whole import with it. One real run wrote 18 address changes and
  // then died on a utility login, showing "Import failed. Nothing
  // further was written", which was true only of what came after.
  //
  // A login is the least important thing in the file. Import the record
  // without it and collect the names, rather than losing 41 properties
  // over a password.
  const credFailures = [];
  async function encryptCreds(row, whatFor) {
    const username = cellString(row.username), password = cellString(row.password);
    if (!username && !password) return NO_CREDS;
    try {
      const u = await encryptCredential(username, companyId);
      const pw = await encryptCredential(password, companyId, u.salt);
      return {
        username_encrypted: u.encrypted, password_encrypted: pw.encrypted,
        encryption_iv: pw.iv || null, encryption_salt: u.salt || null,
        encryption_iv_username: u.iv || null,
      };
    } catch (e) {
      credFailures.push(whatFor || "a login");
      pmError("PM-8006", { raw: e, context: "encrypting an imported credential — record saved without it", silent: true });
      return NO_CREDS;
    }
  }

  // The spreadsheet shows friendly labels; the database stores lowercase
  // tokens. property_taxes.billing_frequency is a CHECK constraint --
  // 'annual', 'semi_annual', 'quarterly', 'monthly' -- so "Annually"
  // was rejected outright and every one of a 40-row tax sheet was lost.
  // The rest have no constraint but do have a house style, and writing
  // "Monthly" beside "monthly" quietly splits the data in two.
  const ENUMS = {
    responsibility:    { owner: "owner", tenant: "tenant" },
    hoaFrequency:      { monthly: "monthly", quarterly: "quarterly", annually: "annual", annual: "annual" },
    premiumFrequency:  { monthly: "monthly", quarterly: "quarterly", annually: "annual", annual: "annual" },
    loanType:          { mortgage: "mortgage", heloc: "heloc", private: "private", commercial: "commercial" },
    taxFrequency:      { annually: "annual", annual: "annual", "semi-annually": "semi_annual",
                         semi_annual: "semi_annual", quarterly: "quarterly", monthly: "monthly" },
  };
  const enumVal = (kind, v) => {
    const raw = cellString(v).trim();
    if (!raw) return null;
    const hit = ENUMS[kind][raw.toLowerCase()];
    // Unrecognised values are passed through lowercased rather than
    // dropped: better a value someone can see and correct than a silent
    // null. The tax one is the exception -- a bad value there is a hard
    // constraint failure, so fall back to null and let it be blank.
    if (hit) return hit;
    return kind === "taxFrequency" ? null : raw.toLowerCase();
  };

  // Rows for one property, in the shape commit_property_wizard expects.
  async function subRecordsFor(address) {
    const ex = plan.extras || {};
    const mine = (list) => (list || []).filter(r => r._address === address);
    const yes = (v) => /^(y|yes|true|1)$/i.test(cellString(v));

    const utilities = [];
    for (const u of mine(ex.utilities)) {
      utilities.push({
        provider: cellString(u.provider), responsibility: enumVal("responsibility", u.responsibility),
        amount: u.amount ?? null, due_date: u.due_date || null,
        website: cellString(u.website) || null, ...(await encryptCreds(u, `${cellString(u.provider)} (utility)`)),
      });
    }
    const hoas = [];
    for (const h of mine(ex.hoas)) {
      hoas.push({
        hoa_name: cellString(h.hoa_name), amount: h.amount ?? null,
        frequency: enumVal("hoaFrequency", h.frequency), due_date: cellString(h.due_date) || null,
        notes: cellString(h.notes) || null,
        website: cellString(h.website) || null, ...(await encryptCreds(h, `${cellString(h.hoa_name)} (HOA)`)),
      });
    }
    // A property can carry more than one loan -- property_loans has no
    // unique key on it. The RPC's payload takes a single loan, so the
    // create path still sends the first; the update path writes them all.
    const loanRows = mine(ex.loan).map(l => ({
      lender_name: cellString(l.lender_name), loan_type: enumVal("loanType", l.loan_type),
      status: "active",
      account_number: cellString(l.account_number) || null,
      original_amount: l.original_amount ?? null, current_balance: l.current_balance ?? null,
      interest_rate: l.interest_rate ?? null, monthly_payment: l.monthly_payment ?? null,
      escrow_included: yes(l.escrow_included), escrow_amount: l.escrow_amount ?? null,
      loan_start_date: l.loan_start_date || null, maturity_date: l.maturity_date || null,
      website: cellString(l.website) || null, _row: l._row,
    }));
    for (const lr of loanRows) {
      const src = mine(ex.loan).find(x => x._row === lr._row);
      Object.assign(lr, await encryptCreds(src, `${cellString(src.lender_name)} (lender)`));
      delete lr._row;
    }
    const loan = loanRows[0] || null;
    const i = mine(ex.insurance)[0];
    const insurance = !i ? null : {
      provider: cellString(i.provider), policy_number: cellString(i.policy_number) || null,
      coverage_amount: i.coverage_amount ?? null, premium_amount: i.premium_amount ?? null,
      premium_frequency: enumVal("premiumFrequency", i.premium_frequency),
      expiration_date: i.expiration_date || null, notes: cellString(i.notes) || null,
      website: cellString(i.website) || null, ...(await encryptCreds(i, `${cellString(i.provider)} (insurer)`)),
    };
    const tx = mine(ex.taxes)[0];
    const taxes = !tx ? null : {
      county: cellString(tx.county) || null, jurisdiction: cellString(tx.jurisdiction) || null,
      parcel_id: cellString(tx.parcel_id) || null, tax_year: tx.tax_year ?? null,
      annual_tax_amount: tx.annual_tax_amount ?? null, assessed_value: tx.assessed_value ?? null,
      billing_frequency: enumVal("taxFrequency", tx.billing_frequency),
      next_due_date: tx.next_due_date || null,
      escrow_paid_by_lender: yes(tx.escrow_paid_by_lender),
      records_url: cellString(tx.records_url) || null,
    };
    const rc = mine(ex.recurring)[0];
    const recurring = !rc ? null : {
      tenant_name: cellString(rc.tenant_name), amount: rc.amount ?? null,
      frequency: cellString(rc.frequency) || "Monthly",
      day_of_month: rc.day_of_month ?? null, start_date: rc.start_date || null,
    };
    return { utilities, hoas, loan, loans: loanRows, insurance, taxes, recurring };
  }

  // Sub-records for a property that ALREADY exists.
  //
  // commit_property_wizard only runs on the create path, so until now
  // every utility, HOA, loan, insurance and tax row in an edit import was
  // parsed, validated, counted in the preview -- and then dropped. The
  // preview even said "this row will be added to it", which was untrue.
  //
  // Not reusing the RPC in edit mode, tempting as it is: there it
  // ARCHIVES every utility and HOA row for the property before inserting
  // whatever the payload carries. A sheet that lists a loan but no
  // utilities would silently wipe the utilities. Writing directly means
  // a row absent from the sheet is left alone.
  //
  // "Replace what's there" is matched on the natural key -- provider for
  // a utility, name for an HOA, the property itself for the one-per-
  // property tables -- so re-uploading a corrected sheet updates rather
  // than duplicating.
  async function writeSubRecordsForExisting(address, propertyId, recs) {
    const idNum = Number(propertyId);
    const failures = [];

    async function put(table, match, row) {
      const { data: found } = await supabase.from(table).select("id")
        .eq("company_id", companyId).eq("property", address)
        .match(match).is("archived_at", null).limit(1);
      const hit = (found || [])[0];
      const { error } = hit
        ? await supabase.from(table).update(row).eq("id", hit.id).eq("company_id", companyId)
        : await supabase.from(table).insert([{ ...row, company_id: companyId, property: address, ...match }]);
      if (error) failures.push(`${table}: ${error.message}`);
    }

    for (const u of recs.utilities) {
      await put("utilities", { provider: u.provider }, {
        property_id: Number.isFinite(idNum) ? idNum : null,
        amount: u.amount, due: u.due_date || null,   // the app sorts on `due`, not due_date
        responsibility: u.responsibility, status: "pending", website: u.website,
        username_encrypted: u.username_encrypted, password_encrypted: u.password_encrypted,
        encryption_iv: u.encryption_iv, encryption_iv_username: u.encryption_iv_username,
        encryption_salt: u.encryption_salt,
      });
    }
    for (const h of recs.hoas) {
      await put("hoa_payments", { hoa_name: h.hoa_name }, {
        property_id: Number.isFinite(idNum) ? idNum : null,
        amount: h.amount, frequency: h.frequency, due_date: h.due_date, notes: h.notes,
        website: h.website, username_encrypted: h.username_encrypted,
        password_encrypted: h.password_encrypted, encryption_iv: h.encryption_iv,
        encryption_iv_username: h.encryption_iv_username, encryption_salt: h.encryption_salt,
      });
    }
    // property_loans.property_id and property_insurance.property_id are
    // TEXT; property_taxes.property_id is INTEGER. Getting that wrong is
    // a silent 400 from PostgREST.
    for (const ln of (recs.loans || [])) {
      const { property: _p, ...rest } = ln;
      await put("property_loans", { lender_name: ln.lender_name },
        { ...rest, property_id: propertyId == null ? null : String(propertyId) });
    }
    if (recs.insurance) {
      const { property: _p, ...rest } = recs.insurance;
      await put("property_insurance", { provider: recs.insurance.provider },
        { ...rest, property_id: propertyId == null ? null : String(propertyId) });
    }
    if (recs.taxes) {
      // annual_tax_amount is NOT NULL. Without one, the row can only
      // update a tax record that already exists -- so look first, and
      // skip rather than fail if there is nothing to update.
      const noAmount = recs.taxes.annual_tax_amount === null ||
                       recs.taxes.annual_tax_amount === undefined ||
                       recs.taxes.annual_tax_amount === "";
      let proceed = true;
      if (noAmount) {
        const { data: existingTax } = await supabase.from("property_taxes").select("id")
          .eq("company_id", companyId).eq("property", address).is("archived_at", null).limit(1);
        proceed = (existingTax || []).length > 0;
      }
      if (proceed) {
        const row = { ...recs.taxes, property_id: Number.isFinite(idNum) ? idNum : null };
        if (noAmount) delete row.annual_tax_amount;   // leave what is on file
        await put("property_taxes", {}, row);
      }
    }
    return failures;
  }

  async function handleCommit() {
    if (!guardSubmit("propImportCommit")) return;
    setBusy(true);
    const done = { created: 0, updated: 0, renamed: 0, tenantsCreated: 0, tenantsUpdated: 0,
                   archived: 0, subRecords: 0, recurringSkipped: 0, markedOccupied: 0, failed: [] };
    const total = plan.creates.length + plan.updates.length + plan.tenantCreates.length + plan.tenantUpdates.length;
    let n = 0;
    const tick = (label) => { n += 1; setProgress({ done: n, total, label }); };

    try {
      // --- new properties, through the wizard's own transactional RPC ---
      for (const c of plan.creates) {
        tick(c.newAddress);
        const r = c.record;
        const { error } = await supabase.rpc("commit_property_wizard", {
          p_payload: {
            company_id: companyId, wizard_id: null, mode: "fresh", property_id_for_edit: null,
            property: {
              address: c.newAddress,
              address_line_1: r.address_line_1, address_line_2: r.address_line_2 || "",
              city: r.city || "", state: r.state || "", zip: r.zip || "", county: r.county || "",
              type: r.type || "Single Family", status: r.status || "vacant", notes: r.notes || "",
            },
            // Tenants come from their own sheet, so the wizard never
            // creates one here -- that would duplicate a row the Tenants
            // sheet is already responsible for.
            // utilities and hoas are iterated with jsonb_array_elements inside
            // the RPC, so they must be arrays -- null makes them scalars and
            // the call fails with "cannot extract elements from a scalar".
            // The object-shaped fields take null quite happily.
            // Tenants still come from their own sheet. Everything else
            // comes from the six optional sheets, already encrypted.
            tenant: null, ...(await subRecordsFor(c.newAddress)),
          },
        });
        if (error) { done.failed.push({ what: c.newAddress, why: error.message }); continue; }
        done.created += 1;
      }

      // --- existing properties -----------------------------------------
      for (const u of plan.updates) {
        tick(u.newAddress);
        const r = u.record;
        let propertyPatchFailed = false;
        // The address is DERIVED by trigger, so it is changed by writing
        // the component columns and letting the cascade follow -- never by
        // setting `address` directly, which the trigger would overwrite.
        if (u.addressChanged) {
          const { error } = await supabase.rpc("rename_property_from_components", {
            p_company_id: companyId, p_property_id: Number(u.id),
            p_line1: r.address_line_1, p_line2: r.address_line_2 || "",
            p_city: r.city || "", p_state: r.state || "", p_zip: r.zip || "",
          });
          if (error) { done.failed.push({ what: u.newAddress, why: error.message }); continue; }
          done.renamed += 1;
        }
        const patch = {
          county: r.county || null, short_name: r.short_name || null,
          type: r.type || null, status: r.status || null,
          bedrooms: r.bedrooms, bathrooms: r.bathrooms, sqft: r.sqft,
          owner_name: r.owner_name || "", rent: r.rent, security_deposit: r.security_deposit,
          notes: r.notes || "",
        };
        Object.keys(patch).forEach(k => { if (patch[k] === null || patch[k] === undefined) delete patch[k]; });
        if (Object.keys(patch).length) {
          const { error } = await supabase.from("properties").update(patch)
            .eq("id", u.id).eq("company_id", companyId);
          if (error) {
            done.failed.push({ what: u.newAddress, why: error.message });
            // Do NOT skip this property's utilities, loan, insurance and
            // tax rows. One bad value on the property row -- a half-bath
            // in an integer column, say -- used to take all of them with
            // it: 10 failed properties cost 39 of 63 utility rows, none
            // of which had anything wrong.
            propertyPatchFailed = true;
          } else {
            done.updated += 1;
          }
        } else {
          done.updated += 1;
        }
        void propertyPatchFailed;

        // Utilities, HOA, loan, insurance and tax rows for a property
        // that already exists. These used to be silently discarded.
        const recs = await subRecordsFor(u.newAddress);
        const n = recs.utilities.length + recs.hoas.length +
                  (recs.loans || []).length + (recs.insurance ? 1 : 0) + (recs.taxes ? 1 : 0);
        if (n) {
          const subFails = await writeSubRecordsForExisting(u.newAddress, u.id, recs);
          subFails.forEach(why => done.failed.push({ what: u.newAddress, why }));
          done.subRecords += n - subFails.length;
        }
        // Recurring rent is deliberately not written here. It posts money
        // and needs its debit and credit accounts resolved, which the
        // wizard's RPC does and this path cannot do safely. Counted so
        // the summary can say so rather than dropping it in silence.
        if (recs.recurring) done.recurringSkipped += 1;
      }

      // --- tenants -----------------------------------------------------
      for (const t of plan.tenantUpdates) {
        tick(t.record.name);
        const r = t.record;
        const patch = {
          email: r.email || null, phone: r.phone || null,
          move_in: r.move_in, move_out: r.move_out,
          lease_start: r.lease_start, lease_end_date: r.lease_end_date,
          rent: r.rent,
          is_voucher: /^y/i.test(r.is_voucher || "") ? true : (/^n/i.test(r.is_voucher || "") ? false : null),
          voucher_number: r.voucher_number || null,
          tenant_portion: r.tenant_portion, voucher_portion: r.voucher_portion,
        };
        if (t.status === "Current") patch.lease_status = "current";
        else if (t.status === "Past") patch.lease_status = "past";
        // "Review" used to write nothing at all, so a row the sheet
        // explicitly flagged for a decision vanished into the import
        // with no trace and no way to find it again. It now lands in the
        // Tenants page's Review tab, which asks the question and takes
        // the answer.
        else if (t.status === "Review") patch.lease_status = "review";
        // "Not a tenant" is archived rather than deleted: the rows survive
        // and stay reversible, and their ledger history is untouched.
        if (t.status === "Not a tenant") {
          patch.archived_at = new Date().toISOString();
          patch.archived_by = "property-import";
        }
        Object.keys(patch).forEach(k => { if (patch[k] === null || patch[k] === undefined) delete patch[k]; });
        if (!Object.keys(patch).length) { done.tenantsUpdated += 1; continue; }
        const { error } = await supabase.from("tenants").update(patch)
          .eq("id", t.id).eq("company_id", companyId);
        if (error) { done.failed.push({ what: r.name, why: error.message }); continue; }
        if (t.status === "Not a tenant") done.archived += 1; else done.tenantsUpdated += 1;
      }

      for (const t of plan.tenantCreates) {
        tick(t.record.name);
        const r = t.record;
        const { error } = await supabase.from("tenants").insert([{
          company_id: companyId, name: r.name, property: r.property || "",
          email: r.email || "", phone: r.phone || "",
          move_in: r.move_in, move_out: r.move_out,
          lease_start: r.lease_start, lease_end_date: r.lease_end_date,
          rent: r.rent, balance: 0,
          lease_status: t.status === "Past" ? "past" : "current",
          is_voucher: /^y/i.test(r.is_voucher || ""),
          voucher_number: r.voucher_number || "",
          tenant_portion: r.tenant_portion, voucher_portion: r.voucher_portion,
        }]);
        if (error) { done.failed.push({ what: r.name, why: error.message }); continue; }
        done.tenantsCreated += 1;
      }

      // --- occupancy ------------------------------------------------------
      // (credFailures is reported on the Done step below)
      // The Status column comes back from the sheet pre-filled with what
      // the property is today, so an import that adds tenants left every
      // property reading "Vacant" -- 12 properties with a current tenant,
      // 41 marked vacant, on one real import. Reconcile from the tenants
      // that actually exist, which is what the wizard does.
      try {
        const { data: liveTenants } = await supabase.from("tenants")
          .select("property, lease_status").eq("company_id", companyId)
          .is("archived_at", null).in("lease_status", ACTIVE_LEASE);
        const occupied = new Set((liveTenants || []).map(t => t.property).filter(Boolean));
        const touched = [...plan.updates, ...plan.creates].map(x => x.newAddress);
        const toOccupy = touched.filter(a => occupied.has(a));
        for (let i = 0; i < toOccupy.length; i += 50) {
          const slice = toOccupy.slice(i, i + 50);
          const { error } = await supabase.from("properties").update({ status: "occupied" })
            .eq("company_id", companyId).in("address", slice).neq("status", "occupied");
          if (error) { done.failed.push({ what: "occupancy", why: error.message }); break; }
        }
        done.markedOccupied = toOccupy.length;
      } catch (e) {
        pmError("PM-2012", { raw: e, context: "reconciling property occupancy after import", silent: true });
      }

      // --- pendencies ---------------------------------------------------
      // Gaps become setup rows the wizard already knows how to surface in
      // Tasks & Approvals, rather than a new parallel mechanism.
      const pend = plan.warnings.filter(w => w.kind === "pendency" && w.sheet === SHEET_PROPERTIES);
      if (pend.length) {
        const wanted = plan.updates
          .filter(u => pend.some(p => p.row === u.row))
          .map(u => ({
            // current_step is an INTEGER column and property_id is TEXT.
            // This sent the string "property_details" into the integer and
            // a number into the text, so every pendency insert failed with
            // 22P02 and the batch was lost. One real import produced 26
            // gaps and created zero tasks -- the screen said "imported"
            // and Tasks & Approvals stayed empty.
            company_id: companyId, property_id: String(u.id), property_address: u.newAddress,
            current_step: 1, completed_steps: ["property_details"],
            status: "in_progress", wizard_data: { source: "bulk_import" },
          }));
        // property_setup_wizard has no unique index on
        // (company_id, property_address) -- only the primary key -- so an
        // upsert naming that conflict target fails with 42P10. Read what
        // exists, insert only the gap.
        const addresses = wanted.map(w => w.property_address);
        const have = new Set();
        for (let i = 0; i < addresses.length; i += 100) {
          const { data } = await supabase.from("property_setup_wizard")
            .select("property_address").eq("company_id", companyId)
            .in("property_address", addresses.slice(i, i + 100));
          (data || []).forEach(r => have.add(r.property_address));
        }
        const rows = wanted.filter(w => !have.has(w.property_address));
        for (let i = 0; i < rows.length; i += 50) {
          const { error } = await supabase.from("property_setup_wizard").insert(rows.slice(i, i + 50));
          if (error) pmError("PM-2013", { raw: error, context: "create import pendencies", silent: true });
        }
      }

      await logAudit("import", "properties",
        `Bulk property import: ${done.created} created, ${done.updated} updated, ${done.renamed} renamed, ` +
        `${done.tenantsCreated} tenants created, ${done.tenantsUpdated} updated, ${done.archived} archived`,
        null, undefined, undefined, companyId);

      done.credFailures = [...new Set(credFailures)];
      setResult(done);
      setStep("done");
      if (typeof onImported === "function") onImported();
    } catch (e) {
      pmError("PM-2012", { raw: e, context: "commit property import" });
      showToast("Import failed. Nothing further was written — see the error log.", "error");
    } finally { setBusy(false); setProgress(null); guardRelease("propImportCommit"); }
  }

  const stepIdx = STEPS.findIndex(s => s.id === step);

  return (
  <div className="space-y-5">
    <div>
      <h3 className="text-lg font-semibold text-neutral-900">
        {isAdd ? "Add properties in bulk" : "Edit properties in bulk"}
      </h3>
      <p className="text-sm text-neutral-400">
        {isAdd
          ? "Set up many new properties at once instead of one at a time in the wizard."
          : "Download what you already have, change it in Excel, and upload the changes back."}
      </p>
    </div>

    <div className="flex items-center gap-2">
      {STEPS.map((s, i) => (
        <React.Fragment key={s.id}>
          <div className={`flex items-center gap-1.5 text-xs font-medium ${i <= stepIdx ? "text-brand-700" : "text-neutral-300"}`}>
            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-2xs ${i < stepIdx ? "bg-brand-600 text-white" : i === stepIdx ? "bg-brand-100 text-brand-700 ring-2 ring-brand-400" : "bg-neutral-100"}`}>
              {i < stepIdx ? "✓" : i + 1}
            </span>
            {s.label}
          </div>
          {i < STEPS.length - 1 && <div className={`h-px flex-1 ${i < stepIdx ? "bg-brand-400" : "bg-neutral-200"}`} />}
        </React.Fragment>
      ))}
    </div>

    {step === "download" && (
      <div className="rounded-xl border border-neutral-200 bg-brand-50/30 p-4 space-y-3">
        <p className="text-sm text-neutral-700">
          {isAdd
            ? <>An empty workbook for properties you don't have yet. Type them in, fill in whichever
               of the other sheets you have details for, then upload it back.</>
            : <>The file comes pre-filled with your <strong>{properties.length} existing properties</strong> and
               their tenants. Fill in the highlighted gaps, add new rows at the bottom, then upload it back.</>}
        </p>
        <ul className="text-xs text-neutral-500 space-y-1 list-disc pl-5">
          {isAdd
            ? <li>No ID column, so nothing here can overwrite a property you already have.</li>
            : <li>Grey columns hold the record IDs — leave them alone.</li>}
          <li>
            Eight sheets: Properties, Tenants, Utilities, HOA, Loans, Insurance, Property Tax and
            Recurring Rent. Only Properties is required — leave any other sheet empty and it is skipped.
          </li>
          <li>
            The Username and Password columns hold real logins in plain text. They are encrypted when
            you upload, but the file itself is not — delete it once you're done.
          </li>
          <li>Documents can't travel in a spreadsheet; attach those on the property afterwards.</li>
          {!isAdd && <li>Tenant status is pre-filled from ledger activity, with balances shown so you can check it.</li>}
          <li>Nothing is posted to your books.</li>
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Btn variant="primary" icon="download" onClick={handleDownload} disabled={busy}>
            {busy ? "Preparing…" : "Download template"}
          </Btn>
          {/* Downloading was the only route to the upload step, so anyone
              who already had a filled-in file -- the second time they use
              this, or a file a colleague sent -- had to fetch a blank one
              first and discard it. */}
          <TextLink tone="neutral" size="sm" onClick={() => setStep("upload")}>
            I already have a filled-in file →
          </TextLink>
        </div>
      </div>
    )}

    {step === "upload" && (
      <div className="rounded-xl border border-neutral-200 p-4 space-y-3">
        <p className="text-sm text-neutral-700">Upload the filled-in workbook. You'll see what will change before anything is saved.</p>
        <FileInput accept=".xlsx" onChange={e => handleFile(e.target.files?.[0])} disabled={busy} />
        {busy && <div className="flex items-center gap-2 text-sm text-neutral-500"><Spinner /> Reading…</div>}
        <TextLink tone="neutral" size="xs" onClick={() => setStep("download")}>← Back to download</TextLink>
      </div>
    )}

    {step === "preview" && plan && (
      <PreviewStep plan={plan} busy={busy} progress={progress}
        onBack={() => setStep("upload")} onCommit={handleCommit} />
    )}

    {step === "done" && result && (
      <DoneStep result={result} onAgain={() => { setStep("download"); setParsed(null); setPlan(null); setResult(null); }} />
    )}
  </div>
  );
}

function Stat({ label, value, tone = "neutral" }) {
  const tones = {
    neutral: "text-neutral-800", good: "text-success-700",
    warn: "text-warning-700", bad: "text-danger-600",
  };
  return (
    <div className="rounded-xl border border-neutral-200 px-3 py-2">
      <div className={`text-xl font-semibold ${tones[tone]}`}>{value}</div>
      <div className="text-2xs text-neutral-500 uppercase tracking-wide">{label}</div>
    </div>
  );
}

function PreviewStep({ plan, busy, progress, onBack, onCommit }) {
  const s = plan.summary;
  const blocked = s.errors > 0 && (s.propertiesToCreate + s.propertiesToUpdate + s.tenantsToCreate + s.tenantsToUpdate) === 0;
  return (
  <div className="space-y-4">
    <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
      <Stat label="New properties" value={s.propertiesToCreate} tone="good" />
      <Stat label="Updated" value={s.propertiesToUpdate} />
      <Stat label="Address changes" value={s.addressChanges} tone={s.addressChanges ? "warn" : "neutral"} />
      <Stat label="New tenants" value={s.tenantsToCreate} tone="good" />
      <Stat label="Tenants updated" value={s.tenantsToUpdate} />
      <Stat label="Problems" value={s.errors} tone={s.errors ? "bad" : "good"} />
    </div>

    {/* The six optional sheets. Hidden entirely when none were filled in,
        so a plain property import looks exactly as it always did. */}
    {s.extraRecords > 0 && (
      <div>
        <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2">
          Also being set up
        </div>
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          <Stat label="Utilities"      value={s.utilities} tone={s.utilities ? "good" : "neutral"} />
          <Stat label="HOA"            value={s.hoas}      tone={s.hoas ? "good" : "neutral"} />
          <Stat label="Loans"          value={s.loans}     tone={s.loans ? "good" : "neutral"} />
          <Stat label="Insurance"      value={s.insurance} tone={s.insurance ? "good" : "neutral"} />
          <Stat label="Property tax"   value={s.taxes}     tone={s.taxes ? "good" : "neutral"} />
          <Stat label="Recurring rent" value={s.recurring} tone={s.recurring ? "good" : "neutral"} />
        </div>
      </div>
    )}

    {plan.renames.length > 0 && (
      <div className="rounded-xl border-2 border-warning-300 bg-warning-50/50 p-4">
        <div className="text-sm font-semibold text-warning-800 mb-1">
          {plan.renames.length} address{plan.renames.length === 1 ? "" : "es"} will change
        </div>
        <p className="text-xs text-warning-700 mb-2">
          Each also renames the matching accounting class. Ledger history stays attached — it is linked by
          id, not by name — but the name shown in reports changes. Your Short Name column is what reports display.
        </p>
        <div className="max-h-48 overflow-y-auto rounded-xl bg-white border border-warning-200 divide-y divide-warning-100">
          {plan.renames.map(r => (
            <div key={r.id} className="px-3 py-1.5 text-xs">
              <span className="text-neutral-400">row {r.row}</span>{" "}
              <span className="text-neutral-500 line-through">{r.from}</span>{" "}
              <span className="text-neutral-400">→</span>{" "}
              <span className="text-neutral-800 font-medium">{r.to}</span>
            </div>
          ))}
        </div>
      </div>
    )}

    {plan.errors.length > 0 && (
      <div className="rounded-xl border-2 border-danger-300 bg-danger-50/50 p-4">
        <div className="text-sm font-semibold text-danger-700 mb-1">
          {plan.errors.length} row{plan.errors.length === 1 ? "" : "s"} will be skipped
        </div>
        <p className="text-xs text-danger-600 mb-2">Everything else still imports. Fix these and upload again — rows already imported are recognised and left alone.</p>
        <div className="max-h-52 overflow-y-auto rounded-xl bg-white border border-danger-200 divide-y divide-danger-100">
          {plan.errors.map((e, i) => (
            <div key={i} className="px-3 py-1.5 text-xs">
              <span className="font-medium text-neutral-700">{e.sheet} row {e.row}</span>
              <span className="text-neutral-400"> · {e.field} · </span>
              <span className="text-danger-700">{e.message}</span>
            </div>
          ))}
        </div>
      </div>
    )}

    {plan.warnings.length > 0 && (
      <details className="rounded-xl border border-neutral-200 p-4">
        <summary className="text-sm font-medium text-neutral-700 cursor-pointer">
          {plan.warnings.length} item{plan.warnings.length === 1 ? "" : "s"} will need approval
        </summary>
        <p className="text-xs text-neutral-500 mt-1 mb-2">
          These import fine, but the gaps become pending items for a manager or admin in Tasks &amp; Approvals.
        </p>
        <div className="max-h-48 overflow-y-auto text-xs text-neutral-600 divide-y divide-neutral-100">
          {plan.warnings.map((w, i) => <div key={i} className="py-1">{w.message}</div>)}
        </div>
      </details>
    )}

    {progress && (
      <div className="rounded-xl bg-brand-50 border border-brand-100 px-4 py-3">
        <div className="flex justify-between text-xs text-brand-700 mb-1">
          <span>{progress.label}</span><span>{progress.done} of {progress.total}</span>
        </div>
        <div className="h-1.5 bg-brand-100 rounded-full overflow-hidden">
          <div className="h-full bg-brand-600 transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
        </div>
      </div>
    )}

    <div className="flex justify-between pt-1">
      <Btn variant="slate" onClick={onBack} disabled={busy}>← Upload a different file</Btn>
      <Btn variant="success-fill" onClick={onCommit} disabled={busy || blocked}>
        {busy ? "Importing…" : blocked ? "Nothing to import" : "Import"}
      </Btn>
    </div>
  </div>
  );
}

function DoneStep({ result, onAgain }) {
  return (
  <div className="space-y-4">
    <div className="rounded-xl border-2 border-success-300 bg-success-50/50 p-5">
      <div className="text-base font-semibold text-success-800 mb-2">Import complete</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <Stat label="Properties created" value={result.created} tone="good" />
        <Stat label="Properties updated" value={result.updated} />
        <Stat label="Addresses changed" value={result.renamed} />
        <Stat label="Tenants created" value={result.tenantsCreated} tone="good" />
        <Stat label="Tenants updated" value={result.tenantsUpdated} />
        <Stat label="Archived" value={result.archived} />
      </div>
      <p className="text-xs text-neutral-500 mt-3">No journal entries were posted. Your books are unchanged.</p>
    </div>
    {/* A login that could not be encrypted. The record itself imported;
        only the username and password are missing, and saying so beats
        leaving someone to discover it when a bill is due. */}
    {(result.credFailures || []).length > 0 && (
      <div className="rounded-xl border-2 border-warn-300 bg-warn-50/50 p-4">
        <div className="text-sm font-semibold text-warn-800 mb-1">
          {result.credFailures.length} login{result.credFailures.length === 1 ? "" : "s"} could not be saved
        </div>
        <div className="text-xs text-warn-700 mb-2">
          Everything else about {result.credFailures.length === 1 ? "this account" : "these accounts"} imported.
          Only the username and password are missing — add them on the property.
        </div>
        <ul className="text-xs text-warn-800 list-disc pl-5 space-y-0.5">
          {result.credFailures.slice(0, 12).map((w, i) => <li key={i}>{w}</li>)}
          {result.credFailures.length > 12 && <li>…and {result.credFailures.length - 12} more</li>}
        </ul>
      </div>
    )}

    {result.failed.length > 0 && (
      <div className="rounded-xl border border-danger-200 bg-danger-50/40 p-4">
        <div className="text-sm font-semibold text-danger-700 mb-1">{result.failed.length} row{result.failed.length === 1 ? "" : "s"} failed</div>
        <div className="max-h-40 overflow-y-auto text-xs divide-y divide-danger-100">
          {result.failed.map((f, i) => (
            <div key={i} className="py-1"><span className="font-medium">{f.what}</span> <span className="text-danger-600">— {f.why}</span></div>
          ))}
        </div>
      </div>
    )}
    <Btn variant="ghost" onClick={onAgain}>Import another file</Btn>
  </div>
  );
}
