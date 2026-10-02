// Everything the document editor, the read-only preview and the PDF
// renderer must agree on: the schema, the page geometry and the pagination
// add-on. They are three views of one layout -- if any of them built its
// own extension list or its own margins, "what you see" and "what you
// get" would drift apart a line at a time.
import { Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
// TipTap v3 consolidates the Table extensions into one package — use named imports.
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle, FontFamily, FontSize } from "@tiptap/extension-text-style";
import { PaginationPlus } from "tiptap-pagination-plus";

// The font a document is set in when nothing says otherwise. Liberation
// Serif is bundled (index.css) and embedded in the PDF, so the default
// looks the same on screen, on every device, and on paper.
export const DOC_FONT_FAMILY = "'Liberation Serif', 'Times New Roman', Times, serif";
export const DOC_FONT_SIZE = "12pt";
export const DOC_LINE_HEIGHT = 1.4;

// Paragraph-level formatting a word processor has and TipTap's schema
// doesn't: line spacing, first-line indent, left/right indent, space
// before/after. Stored as inline style on the <p>/<h*>, so the saved body
// is still plain HTML and the merge + sanitize pipeline needs no changes.
const PARAGRAPH_STYLES = [
  ["lineHeight", "line-height"],
  ["textIndent", "text-indent"],
  ["marginLeft", "margin-left"],
  ["marginRight", "margin-right"],
  ["marginTop", "margin-top"],
  ["marginBottom", "margin-bottom"],
];
export const ParagraphFormat = Extension.create({
  name: "paragraphFormat",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: Object.fromEntries(PARAGRAPH_STYLES.map(([name, css]) => [name, {
        default: null,
        parseHTML: el => el.style.getPropertyValue(css) || null,
        renderHTML: attrs => (attrs[name] ? { style: `${css}: ${attrs[name]}` } : {}),
      }])),
    }];
  },
  addCommands() {
    return {
      setLineHeight: value => ({ commands }) =>
        ["paragraph", "heading"].map(type => commands.updateAttributes(type, { lineHeight: value })).some(Boolean),
    };
  },
});

// US Letter at 96px/in with 1in margins -- the page Word starts with. An
// imported document brings its own (docxImport reads them from the file).
export const DEFAULT_PAGE_SETUP = {
  headerLeft: "", headerRight: "", footerLeft: "", footerRight: "Page {page}",
  pageWidth: 816, pageHeight: 1056,
  marginTop: 96, marginBottom: 96, marginLeft: 96, marginRight: 96,
  headerDistance: 48, footerDistance: 48,
};
// Word's margins measure to the BODY text; the header and footer sit
// inside them, a set distance from the paper's edge. The add-on instead
// stacks edge-margin + header + gap. So: its margin = Word's distance,
// and the gap is whatever is left of Word's margin once the header or
// footer has taken its height. Get this wrong by a few px and every page
// holds a different number of lines than the Word original.
export function pageGeometry(setup, headerHeight, footerHeight) {
  const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback);
  const d = DEFAULT_PAGE_SETUP;
  const top = num(setup.marginTop, d.marginTop), bottom = num(setup.marginBottom, d.marginBottom);
  const headerDistance = Math.min(num(setup.headerDistance, d.headerDistance), top);
  const footerDistance = Math.min(num(setup.footerDistance, d.footerDistance), bottom);
  return {
    // +2: the sheet has a 1px border each side and is border-box, so
    // without it the text column is 2px narrower than Word's and lines
    // wrap a word early.
    pageWidth: num(setup.pageWidth, d.pageWidth) + 2,
    pageHeight: num(setup.pageHeight, d.pageHeight),
    marginLeft: num(setup.marginLeft, d.marginLeft), marginRight: num(setup.marginRight, d.marginRight),
    marginTop: headerDistance, contentMarginTop: Math.max(0, top - headerDistance - headerHeight),
    // lineSlack: see docxImport -- Word lets the last line's spacing hang
    // into the bottom margin, so the body is that much deeper than it says.
    marginBottom: footerDistance, contentMarginBottom: Math.max(0, bottom - footerDistance - footerHeight - num(setup.lineSlack, 0)),
  };
}
// Header/footer text is set at a fixed 20px a line (index.css), so its
// height is known from the text alone. Measuring it off the DOM instead
// raced the add-on's own re-layout and came back wrong.
export const FURNITURE_LINE_PX = 20;
export const furnitureHeight = (...texts) => FURNITURE_LINE_PX * Math.max(0, ...texts.map(t => (t ? String(t).split("\n").length : 0)));
export const PAGE_GUTTER = "#f1f2f4";
// The add-on re-counts pages from a requestAnimationFrame callback and
// reads editor.view.dom while doing it. If the editor has been unmounted
// in between (closing the template, React remounting it), TipTap's view
// stand-in throws "editor view is not available" out of that callback --
// uncaught, so it lands in error tracking every time. Nothing to
// paginate without a view: keep the decorations as they were.
export const Pagination = PaginationPlus.extend({
  addProseMirrorPlugins() {
    const plugins = this.parent?.() || [];
    const { editor } = this;
    const mounted = () => { try { return !!editor.view.dom; } catch { return false; } };
    plugins.forEach((plugin) => {
      const state = plugin.spec.state;
      if (!state || !state.apply) return;
      const apply = state.apply;
      state.apply = (tr, value, oldState, newState) => (mounted() ? apply(tr, value, oldState, newState) : value);
    });
    return plugins;
  },
});

// Header/footer text is typed by the user and ends up as innerHTML in the
// page furniture, so escape it. Line breaks are kept ("____\nLandlord").
export const pageSlot = (text) => {
  if (!text) return "";
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return '<span style="white-space:pre-line">' + esc + "</span>";
};

/**
 * The extension list for a document view.
 * @param {object} o
 * @param {boolean} o.paged      lay the document out on pages
 * @param {object}  o.setup      page setup (merged over DEFAULT_PAGE_SETUP)
 * @param {number}  [o.pageGap]  px between sheets; 0 for the PDF renderer
 * @param {Array}   [o.extra]    view-specific extensions (placeholder, merge-tag pills)
 */
export function docExtensions({ paged = false, setup = {}, pageGap = 24, extra = [] } = {}) {
  const s = { ...DEFAULT_PAGE_SETUP, ...(setup || {}) };
  return [
    StarterKit,
    Underline,
    Link.configure({ openOnClick: false }),
    ...extra,
    Table.configure({ resizable: false }),
    TableRow,
    TableCell,
    TableHeader,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TextStyle,
    FontFamily,
    FontSize,
    ParagraphFormat,
    // Real pages. The add-on never touches the document: it floats page
    // furniture into the view and the text wraps around it, so the saved
    // body is the same HTML with or without it.
    ...(paged ? [Pagination.configure({
      ...pageGeometry(s, furnitureHeight(s.headerLeft, s.headerRight), furnitureHeight(s.footerLeft, s.footerRight)),
      pageGap,
      pageBreakBackground: PAGE_GUTTER,
      pageGapBorderColor: "#d4d4d8",
      headerLeft: pageSlot(s.headerLeft), headerRight: pageSlot(s.headerRight),
      footerLeft: pageSlot(s.footerLeft), footerRight: pageSlot(s.footerRight),
    })] : []),
  ];
}

/**
 * Drive the add-on until its page count holds still.
 *
 * It only re-counts when the editor state changes, and it adds or drops
 * pages a step at a time. Its first count runs before the sheet has its
 * width, so a 16-page lease sat at 5 pages until something unrelated
 * nudged the editor seconds later. Returns { cancel, done } -- done
 * resolves with the settled page count.
 */
export function settlePagination(editor) {
  let raf = 0, last = -1, stable = 0, tries = 0, finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const step = () => {
    let dom;
    try { if (editor.isDestroyed) { finish(last); return; } dom = editor.view.dom; } catch { finish(last); return; }
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
    const count = dom.querySelectorAll(".rm-page-break").length;
    stable = count === last ? stable + 1 : 0;
    last = count;
    if (stable < 4 && ++tries < 60) raf = requestAnimationFrame(step);
    else finish(count);
  };
  raf = requestAnimationFrame(step);
  return { cancel: () => { cancelAnimationFrame(raf); finish(last); }, done };
}

// A generated document carries its page setup with it, as an invisible
// marker at the top of the body. The signing page is public and only
// ever receives the body (not the template), and a template's setup can
// change after a document was generated -- the pages a tenant signed
// must not re-flow. The marker survives the sanitizers (class + title
// are allowed attributes) and is dropped by the editor's schema.
const SETUP_MARKER = /^\s*<div class="hx-page-setup" title="([^"]*)"><\/div>/;
export function attachPageSetup(html, setup) {
  const body = String(html || "").replace(SETUP_MARKER, "");
  if (!setup || typeof setup !== "object") return body;
  return `<div class="hx-page-setup" title="${encodeURIComponent(JSON.stringify(setup))}"></div>` + body;
}
export function splitPageSetup(html) {
  const m = String(html || "").match(SETUP_MARKER);
  if (!m) return { html: String(html || ""), setup: null };
  let setup = null;
  try { setup = JSON.parse(decodeURIComponent(m[1])); } catch { setup = null; }
  return { html: String(html || "").replace(SETUP_MARKER, ""), setup: setup && typeof setup === "object" ? setup : null };
}
