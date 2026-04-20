// Property Tax Bills — pending-task tracker for the jurisdictions the
// portfolio operates in. No JE posting; pure tracking. The /tax-bills
// page lives under Properties in the sidebar nav.
import React, { useEffect, useState } from "react";
import { supabase } from "../supabase";
import { Input, Btn, PageHeader, FilterPill, EmptyState, Select } from "../ui";
import { formatLocalDate, formatCurrency, parseLocalDate } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { markBillPaid, unmarkBillPaid, skipBill, generateBillsForProperty } from "../utils/taxes";
import { Spinner } from "./shared";

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = parseLocalDate(dateStr); d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

function statusChip(status, dueDate) {
  if (status === "paid") return { cls: "bg-success-50 text-success-700 border-success-200", label: "Paid" };
  if (status === "skipped") return { cls: "bg-neutral-100 text-neutral-500 border-neutral-200", label: "Skipped" };
  if (status === "voided") return { cls: "bg-neutral-100 text-neutral-500 border-neutral-200", label: "Voided" };
  const d = daysUntil(dueDate);
  if (d === null) return { cls: "bg-neutral-100 text-neutral-500 border-neutral-200", label: "Pending" };
  if (d < 0) return { cls: "bg-danger-100 text-danger-700 border-danger-200", label: `Overdue ${-d}d` };
  if (d === 0) return { cls: "bg-danger-50 text-danger-600 border-danger-200", label: "Due today" };
  if (d <= 7) return { cls: "bg-warn-50 text-warn-700 border-warn-200", label: `${d}d left` };
  if (d <= 30) return { cls: "bg-warn-50 text-warn-700 border-warn-200", label: `${d}d left` };
  return { cls: "bg-neutral-50 text-neutral-500 border-neutral-200", label: `${d}d left` };
}

export function TaxBills({ companyId, userProfile, userRole, showToast, showConfirm }) {
  const [bills, setBills] = useState([]);
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");    // open | overdue | thisMonth | paid | all
  const [search, setSearch] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("all");
  const [markPaidBill, setMarkPaidBill] = useState(null); // { bill, paidDate, paidAmount, paidNotes }
  const [editBill, setEditBill] = useState(null);          // { bill, due_date, expected_amount, installment_label }
  const [generating, setGenerating] = useState(false);

  useEffect(() => { fetchAll(); /* eslint-disable-next-line */ }, [companyId]);

  async function fetchAll() {
    setLoading(true);
    try {
      const [billsRes, propsRes] = await Promise.all([
        supabase.from("property_tax_bills").select("*").eq("company_id", companyId).is("archived_at", null).order("due_date", { ascending: true }),
        supabase.from("properties").select("id, address, county, state").eq("company_id", companyId).is("archived_at", null),
      ]);
      if (billsRes.error) pmError("PM-8006", { raw: billsRes.error, context: "load tax bills" });
      if (propsRes.error) pmError("PM-8006", { raw: propsRes.error, context: "load properties for tax bills", silent: true });
      setBills(billsRes.data || []);
      setProperties(propsRes.data || []);
    } finally {
      setLoading(false);
    }
  }

  // Backfill / forward-roll for all properties — useful if someone just added
  // new counties to the schedule constant or a new year rolled over.
  async function regenerateAll() {
    if (!guardSubmit("regenerateTaxBills")) return;
    try {
      setGenerating(true);
      let totals = { created: 0, updated: 0, skipped: 0, noSchedule: 0, noCounty: 0 };
      const year = new Date().getFullYear();
      for (const p of properties) {
        if (!p.county) { totals.noCounty++; continue; }
        const r = await generateBillsForProperty({
          companyId, propertyAddress: p.address, propertyId: p.id,
          county: p.county, state: p.state, taxYear: year,
        });
        if (r.reason === "no_schedule_for_jurisdiction") { totals.noSchedule++; continue; }
        totals.created += r.created || 0;
        totals.updated += r.updated || 0;
        totals.skipped += r.skipped || 0;
      }
      showToast(`Generated ${totals.created}, backfilled ${totals.updated}. Skipped: ${totals.skipped} existing, ${totals.noSchedule} out-of-area, ${totals.noCounty} missing county.`, "success");
      logAudit("update", "property_tax_bills", `Bulk regeneration for ${year}: +${totals.created}`, "", userProfile?.email, userRole, companyId);
      fetchAll();
    } finally { setGenerating(false); guardRelease("regenerateTaxBills"); }
  }

  async function handleMarkPaid() {
    if (!markPaidBill?.bill) return;
    if (!markPaidBill.paidDate) { showToast("Paid date is required", "error"); return; }
    if (!guardSubmit("markPaidBill", markPaidBill.bill.id)) return;
    try {
      const res = await markBillPaid({
        billId: markPaidBill.bill.id,
        companyId,
        paidDate: markPaidBill.paidDate,
        paidAmount: markPaidBill.paidAmount,
        paidNotes: markPaidBill.paidNotes,
      });
      if (!res.ok) { showToast("Could not mark paid: " + (res.reason || "unknown"), "error"); return; }
      logAudit("update", "property_tax_bills", `Marked paid: ${markPaidBill.bill.installment_label} for ${markPaidBill.bill.property} ($${markPaidBill.paidAmount || "—"})`, markPaidBill.bill.id, userProfile?.email, userRole, companyId);
      showToast("Bill marked paid", "success");
      setMarkPaidBill(null);
      fetchAll();
    } finally { guardRelease("markPaidBill", markPaidBill.bill.id); }
  }

  async function handleUnpay(bill) {
    if (!await showConfirm({ message: `Undo the paid status on "${bill.installment_label}" for ${bill.property.split(",")[0]}?` })) return;
    if (!guardSubmit("unpayBill", bill.id)) return;
    try {
      const res = await unmarkBillPaid({ billId: bill.id, companyId });
      if (!res.ok) { showToast("Could not undo: " + (res.reason || "unknown"), "error"); return; }
      logAudit("update", "property_tax_bills", "Reverted paid status", bill.id, userProfile?.email, userRole, companyId);
      showToast("Reverted to pending", "success");
      fetchAll();
    } finally { guardRelease("unpayBill", bill.id); }
  }

  async function handleSkip(bill) {
    const reason = prompt("Reason for skipping this bill? (e.g. \"lender escrow\")");
    if (reason === null) return;
    if (!guardSubmit("skipBill", bill.id)) return;
    try {
      const res = await skipBill({ billId: bill.id, companyId, reason });
      if (!res.ok) { showToast("Could not skip: " + (res.reason || "unknown"), "error"); return; }
      logAudit("update", "property_tax_bills", `Skipped (${reason})`, bill.id, userProfile?.email, userRole, companyId);
      showToast("Bill skipped", "success");
      fetchAll();
    } finally { guardRelease("skipBill", bill.id); }
  }

  async function handleDelete(bill) {
    if (!await showConfirm({ message: `Delete this bill? It can be recovered within 180 days.`, variant: "danger", confirmText: "Delete" })) return;
    if (!guardSubmit("deleteBill", bill.id)) return;
    try {
      const { error } = await supabase.from("property_tax_bills").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", bill.id).eq("company_id", companyId);
      if (error) { showToast("Delete failed: " + error.message, "error"); return; }
      logAudit("delete", "property_tax_bills", `Archived bill ${bill.installment_label} for ${bill.property}`, bill.id, userProfile?.email, userRole, companyId);
      fetchAll();
    } finally { guardRelease("deleteBill", bill.id); }
  }

  async function handleEditSave() {
    if (!editBill?.bill) return;
    if (!guardSubmit("editBill", editBill.bill.id)) return;
    try {
      const patch = {};
      if (editBill.due_date && editBill.due_date !== editBill.bill.due_date) patch.due_date = editBill.due_date;
      if (editBill.installment_label && editBill.installment_label !== editBill.bill.installment_label) patch.installment_label = editBill.installment_label;
      if (editBill.expected_amount !== "" && Number(editBill.expected_amount) !== Number(editBill.bill.expected_amount)) patch.expected_amount = Number(editBill.expected_amount) || null;
      if (Object.keys(patch).length === 0) { setEditBill(null); return; }
      // Editing an auto-generated row flags it so future generateBills runs don't
      // stomp on the user's edits (they stop being treated as "pristine auto").
      if (editBill.bill.auto_generated) patch.auto_generated = false;
      const { error } = await supabase.from("property_tax_bills").update(patch).eq("id", editBill.bill.id).eq("company_id", companyId);
      if (error) { showToast("Save failed: " + error.message, "error"); return; }
      logAudit("update", "property_tax_bills", `Edited bill ${Object.keys(patch).join(",")}`, editBill.bill.id, userProfile?.email, userRole, companyId);
      showToast("Bill updated", "success");
      setEditBill(null);
      fetchAll();
    } finally { guardRelease("editBill", editBill.bill.id); }
  }

  if (loading) return <Spinner />;

  // Apply filters
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const thirtyDaysOut = new Date(today.getTime() + 30 * 86400000);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const filtered = bills.filter(b => {
    if (propertyFilter !== "all" && b.property !== propertyFilter) return false;
    if (search && !(b.property || "").toLowerCase().includes(search.toLowerCase()) && !(b.installment_label || "").toLowerCase().includes(search.toLowerCase())) return false;
    const due = b.due_date ? parseLocalDate(b.due_date) : null;
    if (filter === "open") return b.status === "pending";
    if (filter === "overdue") return b.status === "pending" && due && due < today;
    if (filter === "thisMonth") return b.status === "pending" && due && due >= today && due <= monthEnd;
    if (filter === "next30") return b.status === "pending" && due && due >= today && due <= thirtyDaysOut;
    if (filter === "paid") return b.status === "paid";
    if (filter === "all") return true;
    return true;
  });

  // Group by property for the main list
  const grouped = {};
  for (const b of filtered) {
    (grouped[b.property] = grouped[b.property] || []).push(b);
  }

  // Counters for the filter pills
  const counts = {
    open: bills.filter(b => b.status === "pending").length,
    overdue: bills.filter(b => b.status === "pending" && b.due_date && parseLocalDate(b.due_date) < today).length,
    thisMonth: bills.filter(b => b.status === "pending" && b.due_date && parseLocalDate(b.due_date) >= today && parseLocalDate(b.due_date) <= monthEnd).length,
    next30: bills.filter(b => b.status === "pending" && b.due_date && parseLocalDate(b.due_date) >= today && parseLocalDate(b.due_date) <= thirtyDaysOut).length,
    paid: bills.filter(b => b.status === "paid").length,
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <PageHeader title="Property Tax Bills" subtitle={`${counts.open} open, ${counts.overdue} overdue`} />
        <div className="flex items-center gap-2">
          <Btn variant="secondary" size="sm" onClick={regenerateAll} disabled={generating}>
            <span className="material-icons-outlined text-sm">refresh</span>{generating ? "Generating…" : "Regenerate for current year"}
          </Btn>
        </div>
      </div>

      {/* Filter + search bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <FilterPill active={filter === "open"}      onClick={() => setFilter("open")}>Open · {counts.open}</FilterPill>
        <FilterPill active={filter === "overdue"}   onClick={() => setFilter("overdue")}>Overdue · {counts.overdue}</FilterPill>
        <FilterPill active={filter === "thisMonth"} onClick={() => setFilter("thisMonth")}>This month · {counts.thisMonth}</FilterPill>
        <FilterPill active={filter === "next30"}    onClick={() => setFilter("next30")}>Next 30d · {counts.next30}</FilterPill>
        <FilterPill active={filter === "paid"}      onClick={() => setFilter("paid")}>Paid · {counts.paid}</FilterPill>
        <FilterPill active={filter === "all"}       onClick={() => setFilter("all")}>All</FilterPill>
        <div className="w-px h-6 bg-neutral-200 mx-1" />
        <Input size="sm" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search property / installment" className="w-56" />
        <Select value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)} className="border border-neutral-200 rounded-xl px-2.5 py-1 text-xs">
          <option value="all">All properties</option>
          {properties.map(p => <option key={p.id} value={p.address}>{p.address}</option>)}
        </Select>
      </div>

      {filtered.length === 0 && <EmptyState icon="receipt_long" title="No bills here" subtitle={filter === "open" ? "Tax bills auto-generate when you save a property with a county set." : "Try a different filter."} />}

      <div className="space-y-4">
        {Object.entries(grouped).map(([addr, rows]) => {
          const prop = properties.find(p => p.address === addr);
          const jurisdiction = prop?.county && prop?.state ? `${prop.county}, ${prop.state}` : "—";
          return (
            <div key={addr} className="bg-white rounded-xl border border-neutral-100 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-100 bg-neutral-50/60">
                <div>
                  <div className="text-sm font-semibold text-neutral-800">{addr.split(",")[0]}</div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-wide">{jurisdiction} · {rows.length} {rows.length === 1 ? "bill" : "bills"}</div>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-neutral-50/40 text-xs text-neutral-400 uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Installment</th>
                    <th className="px-4 py-2 text-left font-medium">Due</th>
                    <th className="px-4 py-2 text-right font-medium">Expected</th>
                    <th className="px-4 py-2 text-right font-medium">Paid</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(b => {
                    const chip = statusChip(b.status, b.due_date);
                    return (
                      <tr key={b.id} className="border-t border-neutral-100/60">
                        <td className="px-4 py-2.5">
                          <div className="text-sm font-medium text-neutral-700">{b.installment_label}</div>
                          <div className="text-[10px] text-neutral-400">{b.tax_year}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-neutral-600">{b.due_date}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-neutral-600">{b.expected_amount ? formatCurrency(b.expected_amount) : "—"}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-neutral-600">{b.paid_amount ? formatCurrency(b.paid_amount) : (b.status === "paid" ? "✓" : "—")}</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${chip.cls}`}>{chip.label}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center gap-2 justify-end">
                            {b.status === "pending" && (
                              <button onClick={() => setMarkPaidBill({ bill: b, paidDate: formatLocalDate(new Date()), paidAmount: b.expected_amount || "", paidNotes: "" })} className="text-xs text-success-700 hover:underline font-semibold">Mark paid</button>
                            )}
                            {b.status === "paid" && (
                              <button onClick={() => handleUnpay(b)} className="text-xs text-neutral-500 hover:underline">Undo</button>
                            )}
                            {b.status === "pending" && (
                              <button onClick={() => handleSkip(b)} className="text-xs text-neutral-500 hover:underline">Skip</button>
                            )}
                            <button onClick={() => setEditBill({ bill: b, due_date: b.due_date, expected_amount: b.expected_amount || "", installment_label: b.installment_label })} className="text-xs text-brand-600 hover:underline">Edit</button>
                            <button onClick={() => handleDelete(b)} className="text-xs text-danger-400 hover:text-danger-600" title="Delete">✕</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      {/* Mark Paid modal */}
      {markPaidBill && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={() => setMarkPaidBill(null)}>
          <div className="bg-white rounded-xl border border-neutral-100 shadow-xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-neutral-800 mb-1">Mark bill paid</h3>
            <p className="text-xs text-neutral-500 mb-4">{markPaidBill.bill.installment_label} · {markPaidBill.bill.property.split(",")[0]}</p>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider block mb-1">Paid date *</label>
                <Input size="sm" type="date" value={markPaidBill.paidDate} onChange={e => setMarkPaidBill({ ...markPaidBill, paidDate: e.target.value })} />
              </div>
              <div>
                <label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider block mb-1">Amount paid</label>
                <Input size="sm" type="number" step="0.01" value={markPaidBill.paidAmount} onChange={e => setMarkPaidBill({ ...markPaidBill, paidAmount: e.target.value })} placeholder="0.00" />
                <p className="text-[10px] text-neutral-400 mt-0.5">Expected {markPaidBill.bill.expected_amount ? formatCurrency(markPaidBill.bill.expected_amount) : "not set"}</p>
              </div>
              <div>
                <label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider block mb-1">Notes</label>
                <Input size="sm" value={markPaidBill.paidNotes} onChange={e => setMarkPaidBill({ ...markPaidBill, paidNotes: e.target.value })} placeholder="check #, confirmation no., etc." />
              </div>
              <p className="text-[10px] text-neutral-400 border-t border-neutral-100 pt-2">Tracking only — no journal entry is posted. Bank reconciliation will handle posting in a later release.</p>
            </div>
            <div className="flex items-center gap-2 justify-end mt-4">
              <Btn size="sm" variant="secondary" onClick={() => setMarkPaidBill(null)}>Cancel</Btn>
              <Btn size="sm" onClick={handleMarkPaid}>Mark paid</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editBill && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={() => setEditBill(null)}>
          <div className="bg-white rounded-xl border border-neutral-100 shadow-xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-neutral-800 mb-1">Edit bill</h3>
            <p className="text-xs text-neutral-500 mb-4">{editBill.bill.property.split(",")[0]} · {editBill.bill.tax_year}</p>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider block mb-1">Installment label</label>
                <Input size="sm" value={editBill.installment_label} onChange={e => setEditBill({ ...editBill, installment_label: e.target.value })} />
              </div>
              <div>
                <label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider block mb-1">Due date</label>
                <Input size="sm" type="date" value={editBill.due_date} onChange={e => setEditBill({ ...editBill, due_date: e.target.value })} />
              </div>
              <div>
                <label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider block mb-1">Expected amount</label>
                <Input size="sm" type="number" step="0.01" value={editBill.expected_amount} onChange={e => setEditBill({ ...editBill, expected_amount: e.target.value })} />
              </div>
              {editBill.bill.auto_generated && <p className="text-[10px] text-warn-600 border-t border-neutral-100 pt-2">Editing this row detaches it from the auto-generation schedule — future regenerations won't overwrite your changes.</p>}
            </div>
            <div className="flex items-center gap-2 justify-end mt-4">
              <Btn size="sm" variant="secondary" onClick={() => setEditBill(null)}>Cancel</Btn>
              <Btn size="sm" onClick={handleEditSave}>Save</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
