// ============ PRINT / EMAIL THEME ============
// Single source of truth for hex colors used inside template-literal HTML
// that renders outside the app's CSS context — new-window print popups,
// email bodies queued into notification_queue, and inline innerHTML blobs.
// Tailwind classes don't resolve there, so hex is unavoidable — but keeping
// them here means a theme change is one file edit, not a grep campaign.
//
// Values mirror --color-* tokens in src/index.css. Keep the two in sync on
// any palette change.
export const printTheme = {
  // Text
  ink:          "#1a1a1a",  // body text
  inkStrong:    "#1e293b",  // neutral-800 — headings
  inkMuted:     "#64748b",  // neutral-500 — secondary labels
  inkSubtle:    "#94a3b8",  // neutral-400 — footer / generated-on

  // Borders / dividers
  borderLight:  "#e5e7eb",  // neutral-200
  borderMed:    "#cbd5e1",  // neutral-300

  // Surfaces
  surface:      "#ffffff",
  surfaceAlt:   "#f8fafc",  // neutral-50
  surfaceMuted: "#f9fafb",  // neutral-50/100 blend

  // Brand
  brand:        "#4f46e5",  // brand-600
  brandLight:   "#6366f1",  // brand-500
  brandDark:    "#4338ca",  // brand-700
  brandSoft:    "#eef2ff",  // brand-50
  brandEdge:    "#e0e7ff",  // brand-100

  // Semantic
  success:      "#059669",
  successBg:    "#f0fdf4",
  danger:       "#dc2626",
  dangerBg:     "#fef2f2",
  warn:         "#d97706",
  warnBg:       "#fffbeb",
  info:         "#2563eb",

  // Signature ink (Leases, Documents, Tenants, SignaturePad canvas)
  signatureInk: "#1e3a5f",
};

// Report/chart categorical palette — used by Accounting report bars/pies
// so the fixed-order colors ship from one place.
export const chartPalette = [
  "#3b82f6", // blue
  "#10b981", // emerald → positive
  "#f59e0b", // amber → warn
  "#ef4444", // red → danger
  "#8b5cf6", // violet → highlight
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
];
