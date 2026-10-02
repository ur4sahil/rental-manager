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
const P_CELL_DEFAULT = "padding:8px 10px";

// A column may carry `style`, appended after the shared cell style, for
// the cases a label and an alignment cannot express -- a monospace hash
// that must wrap mid-string, a secondary column set a point smaller.
// Same escape hatch as DataTable's per-column className, and for the same
// reason: without it those tables stay hand-written.
//
// `hideHeader` mirrors DataTable's: a key/value detail table (a lease's
// Property / Tenant / Rent block) has no header row, and adding one would
// invent a row that was never there.
//
// WRAPPING. A browser lays a table out by squeezing every column toward
// its narrowest breakable width whenever one cell is long, and a date or
// a journal number breaks at its hyphen: one long description turned
// "2026-01-01" into two lines on every row of the ledger PDF. So:
//   - headers never wrap;
//   - right-aligned columns (amounts) never wrap;
//   - a column marked `nowrap: true` never wraps -- dates, ids,
//     references, short names;
//   - anything else (descriptions) may, and takes the room that is left.
// `dense: true` tightens the cell padding for long listings.
export function printTable({ columns = [], rows = [], footer = null, fontSize = "13px", hideHeader = false, dense = false }) {
  const P_CELL = dense ? "padding:4px 7px" : P_CELL_DEFAULT;
  const align = (c) => `text-align:${c.align === "right" ? "right" : c.align === "center" ? "center" : "left"}`;
  const wrap = (c) => ((c.nowrap ?? c.align === "right") ? ";white-space:nowrap" : "");
  const extra = (c) => wrap(c) + (c.style ? ";" + c.style : "");

  // Header typography matches DataTable's on screen -- uppercase, a point
  // smaller, muted, letter-spaced -- so a printed table and its on-screen
  // counterpart read as the same table.
  const head = hideHeader ? "" : `<thead><tr style="background:${printTheme.surfaceMuted}">` + columns.map(c =>
    `<th style="${P_CELL};${align(c)};white-space:nowrap;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;color:${printTheme.inkMuted};border-bottom:2px solid ${printTheme.borderMed}">${c.label || ""}</th>`
  ).join("") + "</tr></thead>";

  const body = rows.length
    ? rows.map((r, i) => "<tr>" + columns.map(c =>
        `<td style="${P_CELL};${align(c)};border-bottom:1px solid ${printTheme.borderLight}${extra(c)}">${
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
            return `<td style="${P_CELL};${align(col)};white-space:nowrap">${cv}</td>`;
          }).join("") + "</tr>";
      }).join("")}</tfoot>`
    : "";

  return `<table style="width:100%;border-collapse:collapse;font-size:${fontSize}">` +
    head + `<tbody>${body}</tbody>${foot}</table>`;
}

// ============ PRINT DOCUMENT ============
// The name a printed document is saved under.
//
// "Save as PDF" offers the document's title as the file name, and every
// report printed through a hidden frame with an empty title -- so the
// browser fell back to the tab's, and every PDF this app ever produced
// was offered as "Housify — Property Management.pdf". The name should say
// what the file is and the period it covers.
//
// printFileName("Balance Sheet", "As of 2026-10-02", "Sigma Housing LLC")
//   -> "Balance Sheet - As of 2026-10-02 - Sigma Housing LLC"
export function printFileName(...parts) {
  return parts
    .map(p => String(p == null ? "" : p)
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")   // not allowed in a file name
      .replace(/\s+/g, " ").replace(/^[\s.-]+|[\s.-]+$/g, ""))
    .filter(Boolean)
    .join(" - ")
    .slice(0, 150);
}

const PAGE_IN = { portrait: 8.5, landscape: 11 };
const PAGE_MARGIN_IN = 0.4;     // left and right, matches @page below
const BODY_MARGIN_PX = 20;      // left and right, matches body below
const MIN_ZOOM = 0.6;

// In the cloned or generated markup: a cell holding something short -- a
// date, an id, an amount, a name -- must not break. Long text still wraps.
// Applied to the live frame, so it works for markup this file did not write.
const SHORT_CELL_CHARS = 34;
function keepShortCellsOnOneLine(doc) {
  doc.querySelectorAll("th, td").forEach(cell => {
    if (cell.style.whiteSpace) return;                       // the author decided
    const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const numeric = cell.style.textAlign === "right" || /(^|\s)(text-right|tnum|tabular-nums)(\s|$)/.test(cell.className || "");
    if (cell.tagName === "TH" || numeric || text.length <= SHORT_CELL_CHARS) cell.style.whiteSpace = "nowrap";
  });
}

/**
 * Print an HTML document through a hidden frame.
 *
 *   title      what the browser offers as the file name (see printFileName)
 *   css        the document's own styles
 *   body       its markup -- ALREADY sanitised by the caller
 *   landscape  true to force landscape; otherwise portrait unless the
 *              content is too wide for it
 *
 * The document is laid out at paper width before printing. If it does not
 * fit in portrait it is turned to landscape, and if it still does not fit
 * it is scaled down (never below 60%), so a wide report is not cut off at
 * the right edge and a narrow one is not printed needlessly small.
 *
 * Returns { iframe, cancel } -- call cancel() if the caller unmounts first.
 */
export function printHtmlDocument({ title = "", css = "", body = "", landscape = false, delay = 450 }) {
  const iframe = document.createElement("iframe");
  const pageWidth = (o) => Math.round((PAGE_IN[o] - 2 * PAGE_MARGIN_IN) * 96);
  // Off screen but LAID OUT: a zero-width frame cannot be measured.
  iframe.style.cssText = `position:fixed;top:0;left:-20000px;width:${pageWidth(landscape ? "landscape" : "portrait")}px;height:800px;border:0;visibility:hidden;`;
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  const esc = (v) => String(v).replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title) || " "}</title><style>${css}
body{margin:10px ${BODY_MARGIN_PX}px}
</style><style id="hx-page"></style></head><body>${body}</body></html>`);
  doc.close();

  let orientation = landscape ? "landscape" : "portrait";
  let zoom = 1;
  try {
    keepShortCellsOnOneLine(doc);
    const overflow = () => doc.documentElement.scrollWidth - doc.documentElement.clientWidth;
    if (overflow() > 1 && orientation === "portrait") {
      orientation = "landscape";
      iframe.style.width = pageWidth("landscape") + "px";
    }
    if (overflow() > 1) {
      zoom = Math.max(MIN_ZOOM, Math.floor((doc.documentElement.clientWidth / doc.documentElement.scrollWidth) * 100) / 100);
      doc.body.style.zoom = String(zoom);
    }
  } catch { /* measuring is best-effort; print what there is */ }
  // "auto" leaves the choice in the print dialog when the page fits either way.
  const forced = landscape || orientation === "landscape";
  const pageStyle = doc.getElementById("hx-page");
  if (pageStyle) pageStyle.textContent = `@page{size:${forced ? "landscape" : "auto"};margin:0.25in ${PAGE_MARGIN_IN}in}`;

  const timers = [];
  const tabTitle = document.title;
  let restored = false;
  const restoreTitle = () => { if (!restored) { restored = true; document.title = tabTitle; } };
  const remove = () => { if (iframe.parentElement) iframe.parentElement.removeChild(iframe); };
  timers.push(setTimeout(() => {
    const w = iframe.contentWindow;
    // Some browsers name the file after the TAB, not the frame being
    // printed. Lend the tab the name for as long as the dialog is open.
    if (title) document.title = title;
    try {
      if (w) { w.addEventListener("afterprint", restoreTitle); w.print(); }
    } catch { /* print blocked or headless: still clean up */ }
    // Chrome blocks inside print() until the dialog closes, so this runs
    // after it; elsewhere `afterprint` does the restoring and this is the backstop.
    timers.push(setTimeout(() => { restoreTitle(); remove(); }, 1000));
  }, delay));
  return { iframe, orientation, zoom, cancel() { timers.forEach(clearTimeout); restoreTitle(); remove(); } };
}
