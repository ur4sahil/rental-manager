#!/usr/bin/env python3
"""Convert HOA from single entry to multi-entry (up to 5) in Property Setup Wizard."""

FILE = "src/App.js"

REPLACEMENTS = [
    # Wizard data persistence — hoa → hoas
    (
        'if (wd.hoa) setHoa(wd.hoa);',
        'if (wd.hoas) setHoas(wd.hoas); else if (wd.hoa?.enabled) setHoas([wd.hoa]);',
    ),
    (
        'wizard_data: { propForm, tenantForm, savedPropertyId, savedAddress, utilities, hoa, loan, insurance, recurring },',
        'wizard_data: { propForm, tenantForm, savedPropertyId, savedAddress, utilities, hoas, loan, insurance, recurring },',
    ),

    # saveHoa — convert to multi-entry
    (
        '''  async function saveHoa() {
    if (!hoa.enabled) return true;
    if (!hoa.hoa_name.trim()) throw new Error("HOA name is required");
    if (!hoa.amount || Number(hoa.amount) <= 0) throw new Error("HOA amount is required");
    const hoaRow = {
      company_id: companyId,
      property: savedAddress,
      hoa_name: hoa.hoa_name.trim(),
      amount: Number(hoa.amount),
      due_date: hoa.due_date || formatLocalDate(new Date()),
      frequency: hoa.frequency,
      notes: hoa.notes.trim(),
      status: "pending",
      website: hoa.website || "",
    };
    if (hoa.username || hoa.password) {
      const { encrypted: encU, iv: ivU } = await encryptCredential(hoa.username || "", companyId);
      const { encrypted: encP, iv: ivP } = await encryptCredential(hoa.password || "", companyId);
      hoaRow.username_encrypted = encU;
      hoaRow.password_encrypted = encP;
      hoaRow.encryption_iv = ivP || ivU;
    }
    const { error } = await supabase.from("hoa_payments").insert([hoaRow]);
    if (error) throw new Error("Failed to save HOA: " + error.message);
    return true;
  }''',
        '''  async function saveHoa() {
    const validHoas = hoas.filter(h => h.hoa_name.trim());
    if (validHoas.length === 0) return true;
    const rows = validHoas.map(async h => {
      if (!h.amount || Number(h.amount) <= 0) throw new Error("HOA amount is required for " + h.hoa_name);
      const now = new Date();
      const day = Math.min(28, Math.max(1, Number(h.due_date) || 1));
      const dueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const row = {
        company_id: companyId, property: savedAddress, hoa_name: h.hoa_name.trim(),
        amount: Number(h.amount), due_date: dueDate, frequency: h.frequency || "Monthly",
        notes: (h.notes || "").trim(), status: "pending", website: h.website || "",
      };
      if (h.username || h.password) {
        const { encrypted: encU, iv: ivU } = await encryptCredential(h.username || "", companyId);
        const { encrypted: encP, iv: ivP } = await encryptCredential(h.password || "", companyId);
        row.username_encrypted = encU; row.password_encrypted = encP; row.encryption_iv = ivP || ivU;
      }
      return row;
    });
    const resolvedRows = await Promise.all(rows);
    const { error } = await supabase.from("hoa_payments").insert(resolvedRows);
    if (error) throw new Error("Failed to save HOA: " + error.message);
    return true;
  }''',
    ),
]

def main():
    with open(FILE, "r") as f:
        content = f.read()

    replaced = 0
    not_found = []

    for old, new in REPLACEMENTS:
        count = content.count(old)
        if count == 0:
            not_found.append(old[:80])
        elif count >= 1:
            content = content.replace(old, new)
            replaced += 1
            if count > 1:
                print(f"  ℹ Replaced all {count} matches for: {old[:60]}...")

    with open(FILE, "w") as f:
        f.write(content)

    print(f"\n✅ Replaced {replaced} / {len(REPLACEMENTS)} patterns")
    if not_found:
        print(f"\n❌ Not found ({len(not_found)}):")
        for nf in not_found:
            print(f"  - {nf}")

if __name__ == "__main__":
    main()
