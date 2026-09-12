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

// ============ PRINT TABLE ============
// The print/PDF mirror of DataTable.
//
// Six tables in this app are NOT React -- they are HTML strings written
// into an iframe or a new window for printing. DataTable cannot help
// there: a React component cannot go into a string. But the reason the
// app's tables looked inconsistent applies just as much to the printed
// ones, and they each hand-wrote `padding:8px 10px` and their own border
// colours inline.
//
// So: one column spec, one set of paddings, one set of borders, driven by
// the same printTheme the rest of the print output already uses. Changing
// the density of every printed table is now one edit here.
//
// Columns are { label, align, render } where render(row, i) returns an
// ALREADY-ESCAPED string -- escaping stays with the caller because only
// the caller knows which values are user-supplied.
const P_CELL = "padding:8px 10px";

export function printTable({ columns = [], rows = [], footer = null, fontSize = "13px" }) {
  const align = (c) => `text-align:${c.align === "right" ? "right" : c.align === "center" ? "center" : "left"}`;

  const head = columns.map(c =>
    `<th style="${P_CELL};${align(c)};border-bottom:2px solid ${printTheme.borderMed}">${c.label || ""}</th>`
  ).join("");

  const body = rows.length
    ? rows.map((r, i) => "<tr>" + columns.map(c =>
        `<td style="${P_CELL};${align(c)};border-bottom:1px solid ${printTheme.borderLight}">${
          c.render ? c.render(r, i) : (r[c.key] == null ? "" : r[c.key])
        }</td>`
      ).join("") + "</tr>").join("")
    // An empty printed table needs a row saying so, or the reader cannot
    // tell it apart from a rendering failure.
    : `<tr><td colspan="${columns.length || 1}" style="${P_CELL};text-align:center;color:${printTheme.inkSubtle}">Nothing to show</td></tr>`;

  // A footer supplies cells for the LAST n columns; the label spans the
  // rest. Computed, so no caller hand-writes a colspan -- the mistake
  // that misaligned totals on screen.
  const foot = footer
    ? `<tfoot>${footer.map(f => {
        const given = (f.cells || []).length;
        const span = Math.max(columns.length - given, 1);
        return `<tr style="background:${printTheme.surfaceMuted};font-weight:bold">` +
          `<td colspan="${span}" style="${P_CELL};text-align:right">${f.label || ""}</td>` +
          (f.cells || []).map((cv, ci) => {
            const col = columns[columns.length - given + ci] || {};
            return `<td style="${P_CELL};${align(col)}">${cv}</td>`;
          }).join("") + "</tr>";
      }).join("")}</tfoot>`
    : "";

  return `<table style="width:100%;border-collapse:collapse;font-size:${fontSize}">` +
    `<thead><tr style="background:${printTheme.surfaceMuted}">${head}</tr></thead>` +
    `<tbody>${body}</tbody>${foot}</table>`;
}
