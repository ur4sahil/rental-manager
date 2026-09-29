import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Btn, Input, Select } from "../ui";
import { pmError } from "../utils/errors";
import { parseFeeInput } from "../utils/ownerRules";
import { createOwner } from "../utils/owners";

// Choose the owner record a property belongs to -- or create one on the spot.
// Controlled: `value` is an owner id (or ""/null for none) and onChange(id,
// owner) receives the choice. It does not write the property itself; callers
// persist with utils/owners.js#assignPropertyOwner, which writes owner_id and
// derives owner_name from the record.
export default function OwnerPicker({ companyId, value, onChange, disabled, fallbackName, compact }) {
  const [owners, setOwners] = useState([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", fee: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data, error } = await supabase.from("owners").select("id, name, management_fee_pct")
        .eq("company_id", companyId).is("archived_at", null).order("name");
      if (error) pmError("PM-8006", { raw: error, context: "owner picker: load owners", silent: true });
      if (live) setOwners(data || []);
    })();
    return () => { live = false; };
  }, [companyId]);

  async function create() {
    setErr("");
    const fee = parseFeeInput(draft.fee);
    if (!draft.name.trim()) { setErr("Enter the owner's name."); return; }
    if (fee.error) { setErr(fee.error); return; }
    setBusy(true);
    const { owner, error } = await createOwner(companyId, { name: draft.name, management_fee_pct: fee.value });
    setBusy(false);
    if (error) { setErr("Could not create the owner: " + error); return; }
    setOwners(prev => [...prev, owner].sort((a, b) => String(a.name).localeCompare(String(b.name))));
    setCreating(false); setDraft({ name: "", fee: "" });
    onChange && onChange(owner.id, owner);
  }

  const current = value ? owners.find(o => String(o.id) === String(value)) : null;
  return (
    <div className={compact ? "" : "space-y-1.5"}>
      <Select aria-label="Property owner" value={value || ""} disabled={disabled || busy}
        onChange={e => {
          const v = e.target.value;
          if (v === "__new__") { setCreating(true); return; }
          onChange && onChange(v || null, owners.find(o => String(o.id) === String(v)) || null);
        }}
        className="w-full border border-neutral-200 rounded-xl px-3 py-2 text-sm">
        <option value="">— No owner (company-owned) —</option>
        {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        {value && !current && <option value={value}>(owner not found)</option>}
        {!disabled && <option value="__new__">+ New owner…</option>}
      </Select>
      {!value && fallbackName && <div className="text-2xs text-warn-600">Recorded as text only: "{fallbackName}" — pick or create the owner record to link it.</div>}
      {creating && (
        <div className="border border-brand-100 rounded-xl p-2.5 space-y-2 bg-brand-50/30">
          <Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Owner name (person or LLC)" />
          <Input type="number" min="0" max="100" step="0.01" value={draft.fee} onChange={e => setDraft({ ...draft, fee: e.target.value })} placeholder="Management fee % (blank = not set)" />
          {err && <div className="text-2xs text-danger-600">{err}</div>}
          <div className="flex gap-2">
            <Btn size="xs" onClick={create} disabled={busy}>Create owner</Btn>
            <Btn size="xs" variant="ghost" onClick={() => { setCreating(false); setErr(""); }}>Cancel</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
