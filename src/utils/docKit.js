// Everything the document editor, the read-only preview and the PDF
// renderer must agree on: the schema, the page geometry and the pagination
// add-on. They are three views of one layout -- if any of them built its
// own extension list or its own margins, "what you see" and "what you
// get" would drift apart a line at a time.
import { Extension, Node } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { StarterKit } from "@tiptap/starter-kit";
import { Underline } from "@tiptap/extension-underline";
import { Superscript } from "@tiptap/extension-superscript";
import { Subscript } from "@tiptap/extension-subscript";
import { Link } from "@tiptap/extension-link";
// TipTap v3 consolidates the Table extensions into one package — use named imports.
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle, FontFamily, FontSize, Color, BackgroundColor } from "@tiptap/extension-text-style";
import { PaginationPlus } from "tiptap-pagination-plus";
import { INDENT_STEP_IN, lengthToInches, stepIndent, tabKeyAction, isOrderedStyle, isBulletStyle, nextListStyle, CHECKBOX_OFF, isCheckboxChar, toggleCheckbox, pageBreakHeight, keepWithNextPush } from "./docRules";

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
const BLOCK_TYPES = ["paragraph", "heading"];
export const ParagraphFormat = Extension.create({
  name: "paragraphFormat",
  addGlobalAttributes() {
    return [{
      types: BLOCK_TYPES,
      attributes: {
        ...Object.fromEntries(PARAGRAPH_STYLES.map(([name, css]) => [name, {
          default: null,
          parseHTML: el => el.style.getPropertyValue(css) || null,
          renderHTML: attrs => (attrs[name] ? { style: `${css}: ${attrs[name]}` } : {}),
        }])),
        // Word's "keep with next": a heading never sits alone at the foot
        // of a page. Honoured by the layout pass below.
        keepNext: {
          default: false,
          parseHTML: el => el.getAttribute("data-keep-next") === "1",
          renderHTML: attrs => (attrs.keepNext ? { "data-keep-next": "1" } : {}),
        },
      },
    }];
  },
  addCommands() {
    const setAll = (attrs) => ({ commands }) => BLOCK_TYPES.map(type => commands.updateAttributes(type, attrs)).some(Boolean);
    return {
      setLineHeight: value => setAll({ lineHeight: value }),
      setParagraphFormat: attrs => setAll(attrs),
      // Word's Increase / Decrease Indent: the whole paragraph, half an inch.
      indent: () => ({ editor, commands }) => {
        if (editor.isActive("listItem")) return commands.sinkListItem("listItem");
        const cur = editor.getAttributes("paragraph").marginLeft || editor.getAttributes("heading").marginLeft;
        return setAll({ marginLeft: stepIndent(cur, INDENT_STEP_IN) })({ commands });
      },
      outdent: () => ({ editor, commands }) => {
        if (editor.isActive("listItem")) return commands.liftListItem("listItem");
        const cur = editor.getAttributes("paragraph").marginLeft || editor.getAttributes("heading").marginLeft;
        if (lengthToInches(cur) <= 0) return false;
        return setAll({ marginLeft: stepIndent(cur, -INDENT_STEP_IN) })({ commands });
      },
      firstLineIndent: (delta) => ({ editor, commands }) => {
        const cur = editor.getAttributes("paragraph").textIndent || editor.getAttributes("heading").textIndent;
        if (delta < 0 && lengthToInches(cur) <= 0) return false;
        return setAll({ textIndent: stepIndent(cur, delta) })({ commands });
      },
    };
  },
});

// The Tab key, the way Word uses it (rules in docRules.tabKeyAction).
// Without this the browser moves focus out of the page to the next button.
export const TabKeys = Extension.create({
  name: "tabKeys",
  priority: 1000,
  addKeyboardShortcuts() {
    const act = (shift) => () => {
      const { editor } = this;
      const { $from, empty } = editor.state.selection;
      const before = $from.parent.isTextblock ? $from.parent.textBetween(0, $from.parentOffset, "\n", "\n") : "x";
      const attrs = editor.getAttributes("paragraph").textIndent !== undefined ? editor.getAttributes("paragraph") : editor.getAttributes("heading");
      const action = tabKeyAction({
        shift, inTable: editor.isActive("table"), inList: editor.isActive("listItem"),
        atParagraphStart: empty && /^\s*$/.test(before),
        firstLineIn: lengthToInches(attrs.textIndent), leftIn: lengthToInches(attrs.marginLeft),
      });
      switch (action) {
        case "sink": {
          // A nested list gets the next style down (1. -> (a) -> (i)).
          const parentStyle = editor.getAttributes("orderedList").listStyle;
          const wasOrdered = editor.isActive("orderedList");
          const ok = editor.commands.sinkListItem("listItem");
          if (ok && wasOrdered) editor.commands.updateAttributes("orderedList", { listStyle: nextListStyle(parentStyle) });
          return true;
        }
        case "lift": editor.commands.liftListItem("listItem"); return true;
        case "indent-first": editor.commands.firstLineIndent(INDENT_STEP_IN); return true;
        case "outdent-first": editor.commands.firstLineIndent(-INDENT_STEP_IN); return true;
        case "outdent": editor.commands.outdent(); return true;
        // Typed, not parsed as HTML (which would fold it into a space).
        case "insert-tab": editor.view.dispatch(editor.state.tr.insertText("\t").scrollIntoView()); return true;
        // Nothing to do, but the key is still ours: the browser's Tab would
        // move the focus out of the page.
        default: return !editor.isActive("table");
      }
    };
    return { Tab: act(false), "Shift-Tab": act(true) };
  },
});

// Numbering and bullet styles, stored on the list element so the CSS, the
// PDF and the Word import all read the same attribute.
export const ListStyles = Extension.create({
  name: "listStyles",
  addGlobalAttributes() {
    return [
      { types: ["orderedList"], attributes: { listStyle: {
        default: null,
        parseHTML: el => { const v = el.getAttribute("data-list-style"); return isOrderedStyle(v) ? v : null; },
        renderHTML: attrs => (attrs.listStyle ? { "data-list-style": attrs.listStyle } : {}),
      } } },
      { types: ["bulletList"], attributes: { bullet: {
        default: null,
        parseHTML: el => { const v = el.getAttribute("data-bullet"); return isBulletStyle(v) ? v : null; },
        renderHTML: attrs => (attrs.bullet ? { "data-bullet": attrs.bullet } : {}),
      } } },
    ];
  },
  addCommands() {
    return {
      setListStyle: (style) => ({ editor, commands }) => {
        if (!editor.isActive("orderedList")) { if (!commands.toggleOrderedList()) return false; }
        return commands.updateAttributes("orderedList", { listStyle: isOrderedStyle(style) ? style : null });
      },
      setBullet: (bullet) => ({ editor, commands }) => {
        if (!editor.isActive("bulletList")) { if (!commands.toggleBulletList()) return false; }
        return commands.updateAttributes("bulletList", { bullet: isBulletStyle(bullet) ? bullet : null });
      },
      restartListAt: (n) => ({ commands }) => commands.updateAttributes("orderedList", { start: Math.max(1, Math.floor(Number(n) || 1)) }),
      // Carry the numbering on from the previous numbered list at the same
      // level, so a paragraph between two lists does not restart them.
      continueList: () => ({ editor, commands }) => {
        const { $from } = editor.state.selection;
        let depth = $from.depth;
        while (depth > 0 && $from.node(depth).type.name !== "orderedList") depth--;
        if (depth === 0) return false;
        const parent = $from.node(depth - 1), index = $from.index(depth - 1);
        for (let i = index - 1; i >= 0; i--) {
          const sib = parent.child(i);
          if (sib.type.name === "orderedList") return commands.updateAttributes("orderedList", { start: (sib.attrs.start || 1) + sib.childCount });
        }
        return false;
      },
    };
  },
});

// Table borders: all (the default), outside only, or none.
export const TableStyles = Extension.create({
  name: "tableStyles",
  addGlobalAttributes() {
    return [{ types: ["table"], attributes: { borders: {
      default: null,
      parseHTML: el => { const v = el.getAttribute("data-borders"); return ["none", "outer"].includes(v) ? v : null; },
      renderHTML: attrs => (attrs.borders ? { "data-borders": attrs.borders } : {}),
    } } }];
  },
  addCommands() {
    return { setTableBorders: (v) => ({ commands }) => commands.updateAttributes("table", { borders: ["none", "outer"].includes(v) ? v : null }) };
  },
  // With resizable columns the table is drawn by a node view that writes
  // no attributes of its own, so the saved HTML has data-borders but the
  // editor's DOM did not. Mirror it after each change.
  addProseMirrorPlugins() {
    return [new Plugin({
      view: () => ({
        update: (view) => {
          view.state.doc.descendants((node, pos) => {
            if (node.type.name !== "table") return;
            const dom = view.nodeDOM(pos);
            const table = dom && (dom.tagName === "TABLE" ? dom : dom.querySelector && dom.querySelector("table"));
            if (!table) return;
            if (node.attrs.borders) table.setAttribute("data-borders", node.attrs.borders); else table.removeAttribute("data-borders");
            return false;
          });
        },
      }),
    })];
  },
});

// A forced page break. Stored as an empty block; on the paper canvas the
// layout pass stretches it to the foot of the page.
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML() { return [{ tag: "div[data-page-break]" }]; },
  renderHTML() { return ["div", { "data-page-break": "", class: "hx-page-break" }]; },
  addCommands() {
    // Both in one insert: an atom inserted on its own is left selected,
    // and a second insert would replace it.
    return { insertPageBreak: () => ({ commands }) => commands.insertContent([{ type: "pageBreak" }, { type: "paragraph" }]) };
  },
});

// A checkbox is a character (docRules), so it needs no node: this makes a
// click on one tick or untick it, and offers the insert command.
export const Checkboxes = Extension.create({
  name: "checkboxes",
  addCommands() {
    return { insertCheckbox: () => ({ tr, dispatch }) => { if (dispatch) tr.insertText(CHECKBOX_OFF + " "); return true; } };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleClick(view, pos) {
          if (!view.editable) return false;
          const $pos = view.state.doc.resolve(pos);
          const node = $pos.nodeAfter && $pos.nodeAfter.isText ? $pos.nodeAfter : null;
          const ch = node ? node.text.charAt(0) : "";
          if (!isCheckboxChar(ch)) return false;
          view.dispatch(view.state.tr.insertText(toggleCheckbox(ch), pos, pos + 1));
          return true;
        },
      },
    })];
  },
});

// Find & replace. The matches are decorations (never part of the
// document), so searching changes nothing until Replace is pressed.
const findKey = new PluginKey("hxFind");
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function findMatches(doc, query, caseSensitive) {
  const out = [];
  if (!query) return out;
  const re = new RegExp(escapeRe(query), caseSensitive ? "g" : "gi");
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(node.text)) !== null) { out.push({ from: pos + m.index, to: pos + m.index + m[0].length }); if (!m[0].length) re.lastIndex++; }
  });
  return out;
}
export const FindReplace = Extension.create({
  name: "findReplace",
  addStorage() { return { query: "", caseSensitive: false, matches: [], index: -1 }; },
  addCommands() {
    // Everything goes through the command's own transaction: a second
    // transaction dispatched from inside a command is "mismatched".
    const refresh = (editor, tr, index) => {
      const st = editor.storage.findReplace;
      st.matches = findMatches(tr.doc, st.query, st.caseSensitive);
      st.index = st.matches.length ? Math.max(0, Math.min(index, st.matches.length - 1)) : -1;
      tr.setMeta(findKey, { matches: st.matches, index: st.index }).setMeta("addToHistory", false);
      if (st.index >= 0) {
        const m = st.matches[st.index];
        tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
      }
      return true;
    };
    return {
      setSearch: (query, opts = {}) => ({ editor, tr }) => {
        const st = editor.storage.findReplace;
        st.query = String(query || ""); if (opts.caseSensitive !== undefined) st.caseSensitive = !!opts.caseSensitive;
        return refresh(editor, tr, 0);
      },
      findNext: () => ({ editor, tr }) => { const st = editor.storage.findReplace; return refresh(editor, tr, st.matches.length ? (st.index + 1) % st.matches.length : 0); },
      findPrevious: () => ({ editor, tr }) => { const st = editor.storage.findReplace; return refresh(editor, tr, st.matches.length ? (st.index - 1 + st.matches.length) % st.matches.length : 0); },
      replaceCurrent: (text) => ({ editor, tr }) => {
        const st = editor.storage.findReplace;
        if (st.index < 0 || !st.matches[st.index]) return false;
        const m = st.matches[st.index];
        tr.insertText(String(text ?? ""), m.from, m.to);
        return refresh(editor, tr, st.index);
      },
      replaceAll: (text) => ({ editor, tr }) => {
        const st = editor.storage.findReplace;
        const matches = findMatches(tr.doc, st.query, st.caseSensitive);
        if (!matches.length) return false;
        for (let i = matches.length - 1; i >= 0; i--) tr.insertText(String(text ?? ""), matches[i].from, matches[i].to);
        return refresh(editor, tr, 0);
      },
      clearSearch: () => ({ editor, tr }) => { editor.storage.findReplace.query = ""; return refresh(editor, tr, 0); },
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: findKey,
      state: {
        init: () => ({ matches: [], index: -1 }),
        apply: (tr, value) => {
          const meta = tr.getMeta(findKey);
          if (meta) return meta;
          if (!tr.docChanged || !value.matches.length) return value;
          return { index: value.index, matches: value.matches.map(m => ({ from: tr.mapping.map(m.from), to: tr.mapping.map(m.to) })).filter(m => m.to > m.from) };
        },
      },
      props: {
        decorations(state) {
          const { matches, index } = findKey.getState(state) || {};
          if (!matches || !matches.length) return null;
          return DecorationSet.create(state.doc, matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === index ? "hx-find hx-find-current" : "hx-find" })));
        },
      },
    })];
  },
});

// The layout pass: forced page breaks and keep-with-next, decided from
// where the browser actually put things. Runs only with real pages. It
// measures after each update and, when something must move, records it as
// node decorations (an inline height or margin), which is a state change
// the pagination add-on sees and re-counts pages from. Decorations are
// replayed from the natural positions each time (current minus what was
// added), so the result settles instead of oscillating.
const fixupsKey = new PluginKey("hxLayoutFixups");
export const LayoutFixups = Extension.create({
  name: "layoutFixups",
  addProseMirrorPlugins() {
    let raf = 0;
    const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
    const measure = (view) => {
      const dom = view.dom;
      // The gaps between pages: the add-on's "breaker" floats (footer,
      // gap, next header). Their containers are collapsed around floats.
      const breaks = Array.from(dom.querySelectorAll(".rm-page-break .breaker")).map(el => { const r = el.getBoundingClientRect(); return [r.top, r.bottom]; }).filter(([t, b]) => b > t);
      if (!breaks.length) return new Map();
      const prev = fixupsKey.getState(view.state) || new Map();
      const next = new Map();
      const { doc } = view.state;
      doc.forEach((node, pos) => {
        if (node.type.name === "pageBreak") {
          const el = view.nodeDOM(pos);
          if (!el || !el.getBoundingClientRect) return;
          const h = pageBreakHeight(el.getBoundingClientRect().top, breaks);
          if (h > 0) next.set("h:" + pos, Math.round(h));
          return;
        }
        if (!node.attrs || !node.attrs.keepNext) return;
        const el = view.nodeDOM(pos);
        const after = pos + node.nodeSize;
        const nextNode = after < doc.content.size ? doc.nodeAt(after) : null;
        const nextEl = nextNode ? view.nodeDOM(after) : null;
        if (!el || !nextEl || !el.getBoundingClientRect) return;
        const push = prev.get("m:" + pos) || 0;
        const r = el.getBoundingClientRect();
        const first = nextEl.getClientRects ? nextEl.getClientRects()[0] : null;
        const nextTop = (first ? first.top : nextEl.getBoundingClientRect().top) - push;
        const p = keepWithNextPush(r.top - push, r.bottom - push, nextTop, breaks);
        if (p > 0) next.set("m:" + pos, Math.round(p));
      });
      return next;
    };
    return [new Plugin({
      key: fixupsKey,
      state: {
        init: () => new Map(),
        apply: (tr, value) => {
          if (tr.getMeta(fixupsKey) !== undefined) return tr.getMeta(fixupsKey);
          if (!tr.docChanged || !value.size) return value;
          // Keep each fixup on its node while the text above it is edited.
          const moved = new Map();
          for (const [key, px] of value) moved.set(key[0] + ":" + tr.mapping.map(Number(key.slice(2))), px);
          return moved;
        },
      },
      props: {
        decorations(state) {
          const fx = fixupsKey.getState(state);
          if (!fx || !fx.size) return null;
          const decos = [];
          for (const [key, px] of fx) {
            const pos = Number(key.slice(2));
            const node = state.doc.nodeAt(pos);
            if (!node) continue;
            const style = key[0] === "h" ? `height:${px}px` : `margin-top:${px}px`;
            decos.push(Decoration.node(pos, pos + node.nodeSize, { style }));
          }
          return DecorationSet.create(state.doc, decos);
        },
      },
      view(view) {
        const tick = () => {
          raf = 0;
          if (!view.dom || !view.dom.isConnected) return;
          const next = measure(view);
          const cur = fixupsKey.getState(view.state) || new Map();
          if (!same(cur, next)) view.dispatch(view.state.tr.setMeta(fixupsKey, next).setMeta("addToHistory", false));
        };
        return {
          update: () => { if (!raf) raf = requestAnimationFrame(tick); },
          destroy: () => { if (raf) cancelAnimationFrame(raf); },
        };
      },
    })];
  },
});

// How HTML is read into the editor. ProseMirror's default folds every run
// of spaces and every tab into one space; Word pushes a "(SEAL)" line or a
// "Print Name:" to the right with exactly those, so the signature page of
// an imported lease slid left. Spaces and tabs are kept; a newline in the
// HTML source still reads as a space.
export const PARSE_OPTIONS = { preserveWhitespace: true };

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
    Superscript,
    Subscript,
    Link.configure({ openOnClick: false }),
    ...extra,
    Table.configure({ resizable: true, lastColumnResizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TextStyle,
    FontFamily,
    FontSize,
    Color,
    BackgroundColor,
    ParagraphFormat,
    TabKeys,
    ListStyles,
    TableStyles,
    PageBreak,
    Checkboxes,
    FindReplace,
    ...(paged ? [LayoutFixups] : []),
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
