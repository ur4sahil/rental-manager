#!/usr/bin/env python3
"""Wire companySettings into component files, replacing hardcoded defaults."""
import re

def read(path):
    with open(path) as f:
        return f.read()

def write(path, content):
    with open(path, 'w') as f:
        f.write(content)

changes = 0

# ============ LateFees.js ============
print("=== LateFees.js ===")
c = read("src/components/LateFees.js")
# Check if companySettings is already in the function signature
if "companySettings" not in c.split("\n")[0]:
    # Add companySettings to function signature
    c = c.replace(
        "function LateFees({",
        "function LateFees({ companySettings = {},",
        1
    )
    if "function LateFees({ companySettings" not in c:
        c = c.replace(
            "function LateFees(",
            "function LateFees({ companySettings = {} } = {},",
            1
        )
# Replace default form values
c = c.replace('grace_days: "5"', 'grace_days: String(companySettings.late_fee_grace_days || 5)', 1)
c = c.replace('fee_amount: "50"', 'fee_amount: String(companySettings.late_fee_amount || 50)', 1)
c = c.replace('fee_type: "flat"', 'fee_type: companySettings.late_fee_type || "flat"', 1)
write("src/components/LateFees.js", c)
print("  Updated form defaults")
changes += 3

# ============ Leases.js ============
print("=== Leases.js ===")
c = read("src/components/Leases.js")
if "companySettings" not in c[:500]:
    c = c.replace(
        "function LeaseManagement({",
        "function LeaseManagement({ companySettings = {},",
        1
    )
# Form init defaults (first occurrence of each)
c = c.replace('late_fee_grace_days: "5"', 'late_fee_grace_days: String(companySettings.late_fee_grace_days || 5)', 1)
c = c.replace('late_fee_amount: "50"', 'late_fee_amount: String(companySettings.late_fee_amount || 50)', 1)
c = c.replace('late_fee_type: "flat"', 'late_fee_type: companySettings.late_fee_type || "flat"', 1)
c = c.replace('rent_escalation_pct: "3"', 'rent_escalation_pct: String(companySettings.rent_escalation_pct || 3)', 1)
c = c.replace('payment_due_day: "1"', 'payment_due_day: String(companySettings.payment_due_day || 1)', 1)
c = c.replace('renewal_notice_days: "60"', 'renewal_notice_days: String(companySettings.renewal_notice_days || 60)', 1)
c = c.replace('default_lease_months: "12"', 'default_lease_months: String(companySettings.default_lease_months || 12)', 1)
c = c.replace('default_deposit_months: "1"', 'default_deposit_months: String(companySettings.default_deposit_months || 1)', 1)
c = c.replace('default_escalation_pct: "3"', 'default_escalation_pct: String(companySettings.rent_escalation_pct || 3)', 1)
write("src/components/Leases.js", c)
print("  Updated form defaults")
changes += 9

# ============ Accounting.js ============
print("=== Accounting.js ===")
c = read("src/components/Accounting.js")
if "companySettings" not in c[:1000]:
    c = c.replace(
        "function Accounting({",
        "function Accounting({ companySettings = {},",
        1
    )
# Replace grace_period_days: 5 and late_fee_amount: 50 (all occurrences)
c = c.replace("grace_period_days: 5", "grace_period_days: companySettings.late_fee_grace_days || 5")
c = c.replace("late_fee_amount: 50", "late_fee_amount: companySettings.late_fee_amount || 50")
write("src/components/Accounting.js", c)
print("  Updated recurring entry defaults")
changes += 6

# ============ Dashboard.js ============
print("=== Dashboard.js ===")
c = read("src/components/Dashboard.js")
if "companySettings" not in c[:500]:
    c = c.replace(
        "function Dashboard({",
        "function Dashboard({ companySettings = {},",
        1
    )
# HOA window: 14 days
c = c.replace(
    "new Date(Date.now() + 14 * 86400000)",
    "new Date(Date.now() + (companySettings.hoa_upcoming_window_days || 14) * 86400000)",
    1
)
# Voucher reexam: 120 days
c = c.replace("<= 120 && ", "<= (companySettings.voucher_reexam_window_days || 120) && ", 1)
write("src/components/Dashboard.js", c)
print("  Updated dashboard thresholds")
changes += 2

# ============ Insurance.js ============
print("=== Insurance.js ===")
c = read("src/components/Insurance.js")
if "companySettings" not in c[:500]:
    c = c.replace(
        "function InsuranceTracker({",
        "function InsuranceTracker({ companySettings = {},",
        1
    )
write("src/components/Insurance.js", c)
print("  Added companySettings prop")

# ============ Tenants.js ============
print("=== Tenants.js ===")
c = read("src/components/Tenants.js")
# Replace hardcoded "30 days" in lease template text
c = c.replace(
    'within 30 days of move-out',
    'within " + (companySettings?.deposit_return_days || 30) + " days of move-out',
    1
)
c = c.replace(
    'with 30 days written notice',
    'with " + (companySettings?.termination_notice_days || 30) + " days written notice',
    1
)
# late_fee_type default
c = c.replace('late_fee_type: "flat"', 'late_fee_type: companySettings?.late_fee_type || "flat"', 1)
write("src/components/Tenants.js", c)
print("  Updated lease template text + defaults")
changes += 3

# ============ App.js ============
print("=== App.js ===")
c = read("src/App.js")
# Lease expiry warning: 60 days
c = c.replace(
    "if (daysLeft <= 60 && daysLeft > 0)",
    "if (daysLeft <= (companySettings.lease_expiry_warning_days || 60) && daysLeft > 0)",
    1
)
write("src/App.js", c)
print("  Updated lease expiry warning threshold")
changes += 1

print(f"\n=== TOTAL: {changes} hardcoded values wired to companySettings ===")
