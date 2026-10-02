import React, { useEffect, useRef, useState } from "react";
import { useEditor, useEditorState, EditorContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
// TipTap v3 consolidates the Table extensions into one package — use named imports.
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { Extension } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle, FontFamily, FontSize } from "@tiptap/extension-text-style";
import { PaginationPlus } from "tiptap-pagination-plus";
import { WORD_SINGLE_LINE } from "../utils/docxImport";

// Merge tags used to sit in the page as raw text -- a letter reading
// "Dear {{recipient_name}}, {{letter_body}}" looks like source code, not
// a document. This paints each {{tag}} as an inline pill without
// changing the stored text, so the body is still a plain string with
// {{tags}} in it and nothing downstream has to know.
const MergeTagHighlight = Extension.create({
  name: "mergeTagHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decos = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              const re = /\{\{\s*([\w.]+)\s*\}\}/g;
              let m;
              while ((m = re.exec(node.text)) !== null) {
                // The pretty name rides along as an attribute; CSS shows
                // it and hides the raw braces. Keeping the underlying
                // text as "{{tag}}" matters -- the body is stored and
                // merged as a plain string, so nothing downstream changes.
                const pretty = m[1].replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
                decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, {
                  class: "merge-tag",
                  "data-label": pretty,
                  title: `${pretty} — fills in automatically`,
                }));
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

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
const ParagraphFormat = Extension.create({
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
const DEFAULT_PAGE_SETUP = {
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
function pageGeometry(setup, headerHeight, footerHeight) {
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
const FURNITURE_LINE_PX = 20;
const furnitureHeight = (...texts) => FURNITURE_LINE_PX * Math.max(0, ...texts.map(t => (t ? String(t).split("\n").length : 0)));
const PAGE_GUTTER = "#f1f2f4";
// The add-on re-counts pages from a requestAnimationFrame callback and
// reads editor.view.dom while doing it. If the editor has been unmounted
// in between (closing the template, React remounting it), TipTap's view
// stand-in throws "editor view is not available" out of that callback --
// uncaught, so it lands in error tracking every time. Nothing to
// paginate without a view: keep the decorations as they were.
const Pagination = PaginationPlus.extend({
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
const pageSlot = (text) => {
  if (!text) return "";
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return '<span style="white-space:pre-line">' + esc + "</span>";
};

const FONT_OPTIONS = [
  ["'Times New Roman', Times, serif", "Times New Roman"],
  ["Georgia, serif", "Georgia"],
  ["Arial, Helvetica, sans-serif", "Arial"],
  ["Calibri, Arial, sans-serif", "Calibri"],
  ["'Courier New', monospace", "Courier New"],
];
const SIZE_OPTIONS = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "24", "28", "36"];
// Word's spacing names -> the CSS multiple that reproduces them.
const SPACING_OPTIONS = [["Single", 1], ["1.15", 1.15], ["1.5", 1.5], ["Double", 2]]
  .map(([label, mult]) => [String(+(mult * WORD_SINGLE_LINE).toFixed(3)), label]);
const fontKey = (v) => String(v || "").replace(/['"]/g, "").replace(/\s*,\s*/g, ",").toLowerCase();

// Conservative paste-cleaner for HTML that came out of Word, Outlook,
// Google Docs, or Apple Pages. None of those produce HTML the rest of
// the app wants in storage — Word ships mso-* style/class noise and
// fixed pixel widths, Google Docs ships `id="docs-internal-guid-…"`
// wrappers and inline color styles, etc. We don't try to convert
// MsoListParagraph runs to <ul>/<ol> (too brittle); we just strip the
// noise and let paragraphs survive as paragraphs.
function cleanPastedHtml(html) {
  if (!html || typeof html !== "string") return html;
  let h = html;
  // Word's clipboard wraps the actual fragment in StartFragment/EndFragment.
  const startIdx = h.indexOf("<!--StartFragment-->");
  const endIdx = h.indexOf("<!--EndFragment-->");
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    h = h.slice(startIdx + "<!--StartFragment-->".length, endIdx);
  }
  // Conditional comments (Word, Outlook).
  h = h.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "");
  // <style>, <meta>, <link>, <xml>, <script> blocks have no place in pasted body.
  h = h.replace(/<style[\s\S]*?<\/style>/gi, "");
  h = h.replace(/<script[\s\S]*?<\/script>/gi, "");
  h = h.replace(/<(meta|link|xml|o:p)[^>]*\/?>/gi, "");
  // Office namespace tags (e.g. <o:p>, <w:WordDocument>).
  h = h.replace(/<\/?[a-z]+:[a-z0-9]+[^>]*>/gi, "");
  // Mso-* class names.
  h = h.replace(/\sclass="[^"]*\bMso[A-Za-z0-9]*[^"]*"/gi, "");
  // Inline styles + width/height/lang attributes.
  h = h.replace(/\sstyle="[^"]*"/gi, "");
  h = h.replace(/\s(?:width|height|cellpadding|cellspacing|border)="[^"]*"/gi, "");
  h = h.replace(/\s(?:xml:lang|lang)="[^"]*"/gi, "");
  // Empty class / id attributes left over.
  h = h.replace(/\sclass=""/gi, "");
  h = h.replace(/\sid="docs-internal-guid-[^"]*"/gi, "");
  // <font> tags (Outlook still ships them).
  h = h.replace(/<\/?font[^>]*>/gi, "");
  // Strip <span> tags that no longer carry attributes after the cleanup
  // above — they're pure noise once styles are gone.
  h = h.replace(/<span\s*>/gi, "");
  h = h.replace(/<\/span>/gi, "");
  // &nbsp; runs collapse to a single regular space; keeps wrapping working.
  h = h.replace(/(&nbsp;)+/g, " ");
  return h;
}

// WYSIWYG editor for document/template bodies.
// Output: HTML string compatible with the existing renderMergedBody +
// sanitizeTemplateHtml pipeline. Merge tokens are inserted as literal
// text "{{field_name}}" so the downstream replacer keeps working.
//
// Props
//  value           — initial HTML string. Treated as uncontrolled after mount.
//                    Pass a `key` prop that changes to force a reset.
//  onChange(html)  — fired on every edit with the current HTML.
//  mergeFields     — [{ name, label }] array; renders chip buttons in the toolbar.
//  placeholder     — empty-state hint text.
//  minHeight       — min editor height, default "400px".

function ToolbarBtn({ onClick, active, title, children }) {
  return (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      title={title}
      className={"px-2 py-1 rounded text-xs border transition-colors " + (active
        ? "bg-brand-600 border-brand-600 text-white"
        : "bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-100 hover:border-neutral-300")}
    >
      {children}
    </button>
  );
}

function ToolbarSelect({ value, onChange, title, width, children }) {
  return (
    <select
      value={value}
      onChange={onChange}
      title={title}
      aria-label={title}
      className={"h-[26px] rounded border border-neutral-200 bg-white text-xs text-neutral-700 px-1 hover:border-neutral-300 focus:outline-none focus:border-brand-400 " + width}
    >
      {children}
    </select>
  );
}

// Standalone toolbar that can be rendered anywhere (e.g. top ribbon) given
// a TipTap editor instance. Mirrors the internal toolbar one-to-one.
export function RichTextToolbar({ editor, compact = false }) {
  if (!editor) return null;
  return <ToolbarInner editor={editor} compact={compact} />;
}

function ToolbarInner({ editor, compact }) {
  // The ribbon lives outside the editor, so nothing re-renders it when the
  // cursor moves. Subscribe to the bits it shows, or the font/size boxes
  // and the active buttons go stale the moment you click elsewhere.
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"),
      h1: e.isActive("heading", { level: 1 }), h2: e.isActive("heading", { level: 2 }), h3: e.isActive("heading", { level: 3 }),
      paragraph: e.isActive("paragraph"), bullet: e.isActive("bulletList"), ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"), link: e.isActive("link"),
      fontFamily: e.getAttributes("textStyle").fontFamily || "",
      fontSize: e.getAttributes("textStyle").fontSize || "",
      align: ["center", "right", "justify"].find(a => e.isActive({ textAlign: a })) || "left",
      lineHeight: e.getAttributes("paragraph").lineHeight || e.getAttributes("heading").lineHeight || "",
    }),
  });
  const setLink = () => {
    const prev = editor.getAttributes("link").href || "";
    // eslint-disable-next-line no-alert
    const url = window.prompt("Link URL", prev);
    if (url === null) return;
    if (url === "") { editor.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };
  const insertTable = () => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };
  const gap = compact ? "gap-0.5" : "gap-1";
  const sep = <span className="w-px h-5 bg-neutral-200 mx-1" />;

  // An imported document can use a font that isn't in the list. Show it
  // by name rather than letting the box fall back to a blank.
  const knownFont = FONT_OPTIONS.find(([v]) => fontKey(v) === fontKey(st.fontFamily));
  const fontValue = knownFont ? knownFont[0] : st.fontFamily;
  const sizeValue = String(st.fontSize).replace(/pt$/, "");
  const spacing = SPACING_OPTIONS.find(([v]) => Math.abs(Number(v) - Number(st.lineHeight)) < 0.02);
  const alignBtn = (value, icon, title) => (
    <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign(value).run()} active={st.align === value} title={title}>
      <span className="material-icons-outlined align-middle" style={{ fontSize: 15 }}>{icon}</span>
    </ToolbarBtn>
  );

  return (
    <div className={"flex items-center flex-wrap " + gap}>
      <ToolbarSelect title="Font" width="w-[132px]" value={fontValue}
        onChange={e => (e.target.value ? editor.chain().focus().setFontFamily(e.target.value).run() : editor.chain().focus().unsetFontFamily().run())}>
        <option value="">Default font</option>
        {!knownFont && st.fontFamily && <option value={st.fontFamily}>{st.fontFamily.split(",")[0].replace(/['"]/g, "")}</option>}
        {FONT_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </ToolbarSelect>
      <ToolbarSelect title="Font size" width="w-[58px]" value={sizeValue}
        onChange={e => (e.target.value ? editor.chain().focus().setFontSize(e.target.value + "pt").run() : editor.chain().focus().unsetFontSize().run())}>
        <option value="">Size</option>
        {sizeValue && !SIZE_OPTIONS.includes(sizeValue) && <option value={sizeValue}>{sizeValue}</option>}
        {SIZE_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
      </ToolbarSelect>
      {sep}
      <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={st.bold} title="Bold"><b>B</b></ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={st.italic} title="Italic"><i>I</i></ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={st.underline} title="Underline"><span className="underline">U</span></ToolbarBtn>
      {sep}
      {alignBtn("left", "format_align_left", "Align left")}
      {alignBtn("center", "format_align_center", "Center")}
      {alignBtn("right", "format_align_right", "Align right")}
      {alignBtn("justify", "format_align_justify", "Justify")}
      <ToolbarSelect title="Line spacing" width="w-[78px]" value={spacing ? spacing[0] : ""}
        onChange={e => editor.chain().focus().setLineHeight(e.target.value || null).run()}>
        <option value="">Spacing</option>
        {SPACING_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </ToolbarSelect>
      {sep}
      <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={st.h1} title="Heading 1">H1</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={st.h2} title="Heading 2">H2</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={st.h3} title="Heading 3">H3</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().setParagraph().run()} active={st.paragraph} title="Paragraph">¶</ToolbarBtn>
      {sep}
      <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={st.bullet} title="Bulleted list">•</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={st.ordered} title="Numbered list">1.</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={st.quote} title="Blockquote">&ldquo;</ToolbarBtn>
      {sep}
      <ToolbarBtn onClick={setLink} active={st.link} title="Link">🔗</ToolbarBtn>
      <ToolbarBtn onClick={insertTable} title="Insert table">⊞</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">―</ToolbarBtn>
      {sep}
      <ToolbarBtn onClick={() => editor.chain().focus().undo().run()} title="Undo">↶</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().redo().run()} title="Redo">↷</ToolbarBtn>
    </div>
  );
}

export default function RichTextEditor({ value = "", onChange, mergeFields = [], placeholder = "", minHeight = "400px", hideToolbar = false, onEditorReady = null, paperCanvas = false, pageSetup = null }) {
  const [dragOver, setDragOver] = useState(false);
  const setup = { ...DEFAULT_PAGE_SETUP, ...(pageSetup || {}) };
  const setupKey = JSON.stringify(setup);
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder }),
      MergeTagHighlight,
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TextStyle,
      FontFamily,
      FontSize,
      ParagraphFormat,
      // Real pages only on the paper canvas (the template editor). The
      // add-on never touches the document: it floats page furniture into
      // the view and the text wraps around it, so the saved body is the
      // same HTML with or without it.
      ...(paperCanvas ? [Pagination.configure({
        ...pageGeometry(setup, furnitureHeight(setup.headerLeft, setup.headerRight), furnitureHeight(setup.footerLeft, setup.footerRight)),
        pageGap: 24,
        pageBreakBackground: PAGE_GUTTER,
        pageGapBorderColor: "#d4d4d8",
        headerLeft: pageSlot(setup.headerLeft), headerRight: pageSlot(setup.headerRight),
        footerLeft: pageSlot(setup.footerLeft), footerRight: pageSlot(setup.footerRight),
      })] : []),
    ],
    content: value,
    onUpdate: ({ editor: ed }) => { if (onChange) onChange(ed.getHTML()); },
    editorProps: {
      // Pasting from Word/Google Docs/Outlook drops a giant HTML payload
      // with mso-* styles, <o:p> namespace tags, <style> blocks, MsoNormal
      // classes, fixed widths, and runs of &nbsp; that overflow the canvas
      // and break paragraph structure. Strip all of it before TipTap parses
      // the fragment so what lands in the editor is clean semantic HTML.
      transformPastedHTML: cleanPastedHtml,
    },
  });

  useEffect(() => () => { if (editor) editor.destroy(); }, [editor]);

  // Hand the editor instance up to the parent so it can mount the
  // standalone RichTextToolbar elsewhere (e.g. in the ribbon).
  useEffect(() => { if (editor && onEditorReady) onEditorReady(editor); }, [editor, onEditorReady]);

  // Header/footer text and page setup are edited in the side panel (or
  // replaced by a Word import) while the editor is open; push each change
  // into the page furniture.
  const { headerLeft, headerRight, footerLeft, footerRight } = setup;
  const geometryKey = JSON.stringify(pageGeometry(setup, 0, 0));
  useEffect(() => {
    if (!editor || !paperCanvas || editor.isDestroyed) return;
    try { if (!editor.view.dom) return; } catch { return; }
    const s = JSON.parse(setupKey);
    const g = pageGeometry(s, furnitureHeight(s.headerLeft, s.headerRight), furnitureHeight(s.footerLeft, s.footerRight));
    editor.chain()
      .updateHeaderContent(pageSlot(headerLeft), pageSlot(headerRight))
      .updateFooterContent(pageSlot(footerLeft), pageSlot(footerRight))
      .updatePageWidth(g.pageWidth).updatePageHeight(g.pageHeight)
      .updateMargins({ top: g.marginTop, bottom: g.marginBottom, left: g.marginLeft, right: g.marginRight })
      .updateContentMargins({ top: g.contentMarginTop, bottom: g.contentMarginBottom })
      .run();
  // setupKey carries every field of the setup; geometryKey is the part of it that moves the layout.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, paperCanvas, headerLeft, headerRight, footerLeft, footerRight, geometryKey]);

  // The add-on only re-counts pages when the editor state changes. Its
  // first count runs before the sheet has its width, so a 16-page lease
  // sat at 5 pages until something unrelated nudged the editor seconds
  // later. Nudge it ourselves once layout (and the fonts) have settled,
  // and again whenever the sheet is re-scaled.
  const [zoom, setZoom] = useState(1);
  const paneRef = useRef(null);
  useEffect(() => {
    if (!editor || !paperCanvas) return undefined;
    // One nudge is one step of the add-on's count (it adds or drops pages
    // a step at a time), so keep going until the count holds still.
    let raf = 0, last = -1, stable = 0, tries = 0;
    const step = () => {
      let dom;
      try { if (editor.isDestroyed) return; dom = editor.view.dom; } catch { return; }
      editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
      const count = dom.querySelectorAll(".rm-page-break").length;
      stable = count === last ? stable + 1 : 0;
      last = count;
      if (stable < 4 && ++tries < 40) raf = requestAnimationFrame(step);
    };
    const settle = () => { cancelAnimationFrame(raf); last = -1; stable = 0; tries = 0; raf = requestAnimationFrame(step); };
    settle();
    if (document.fonts?.ready) document.fonts.ready.then(settle).catch(() => {});
    return () => cancelAnimationFrame(raf);
  }, [editor, paperCanvas, zoom]);

  // Fit the sheet to the pane. A US Letter page is 816px wide and the pane
  // between the two side rails is narrower than that on a laptop; scale
  // the page down rather than make the user scroll sideways to read a line.
  const sheetWidth = pageGeometry(setup, 0, 0).pageWidth;
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || !paperCanvas || typeof ResizeObserver === "undefined") return undefined;
    const fit = () => {
      const room = pane.clientWidth - 48; // p-6 either side
      const next = room > 0 && room < sheetWidth ? Math.max(0.5, Math.floor((room / sheetWidth) * 100) / 100) : 1;
      setZoom(z => (Math.abs(z - next) > 0.005 ? next : z));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [paperCanvas, sheetWidth, editor]);

  if (!editor) return null;

  const insertMerge = (name) => {
    editor.chain().focus().insertContent("{{" + name + "}}").run();
  };

  const setLink = () => {
    const prev = editor.getAttributes("link").href || "";
    // eslint-disable-next-line no-alert
    const url = window.prompt("Link URL", prev);
    if (url === null) return;
    if (url === "") { editor.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const insertTable = () => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  // Drag-and-drop merge fields onto the canvas.
  // The left-rail chip sets `application/x-merge-field` to the field name.
  // On drop we map the mouse coords → doc position via posAtCoords and
  // insert the {{name}} token there (focus stays on the editor afterward).
  const handleDragOver = (e) => {
    if (e.dataTransfer.types.includes("application/x-merge-field")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dragOver) setDragOver(true);
    }
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e) => {
    const name = e.dataTransfer.getData("application/x-merge-field");
    if (!name) return;
    e.preventDefault();
    setDragOver(false);
    const coords = { left: e.clientX, top: e.clientY };
    let pos;
    try { pos = editor.view.posAtCoords(coords)?.pos; } catch { pos = null; }
    if (pos != null) {
      editor.chain().focus().insertContentAt(pos, "{{" + name + "}}").run();
    } else {
      editor.chain().focus().insertContent("{{" + name + "}}").run();
    }
  };

  // Paper canvas mode: center an 8.5in letter-size page with shadow, on a
  // subtle grey gutter. Used by the template editor where the canvas IS
  // the preview.
  if (paperCanvas) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        {!hideToolbar && (
          <div className="px-2 py-1.5 border-b border-neutral-100 bg-white">
            <RichTextToolbar editor={editor} compact />
          </div>
        )}
        {mergeFields.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap px-3 py-1.5 border-b border-neutral-100 bg-white">
            <span className="text-2xs font-semibold uppercase tracking-wider text-neutral-400 mr-1">Drag or click a field</span>
            {mergeFields.filter(f => f.name).map(f => (
              <button
                key={f.name}
                type="button"
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData("application/x-merge-field", f.name);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onMouseDown={e => e.preventDefault()}
                onClick={() => insertMerge(f.name)}
                title={"Drag onto the page or click to insert {{" + f.name + "}}"}
                className="text-2xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full hover:bg-brand-100 border border-brand-200 cursor-grab active:cursor-grabbing"
              >
                {"{{" + (f.label || f.name) + "}}"}
              </button>
            ))}
          </div>
        )}
        {/* The .ProseMirror element IS the sheet of paper: the pagination
            add-on sizes it to the page, pads it with the margins and draws
            the gaps between pages. So no padded wrapper here, and no
            max-width clamp on its children -- that would squash the page
            furniture, which is deliberately wider than the text column. */}
        <div
          ref={paneRef}
          className="flex-1 overflow-auto p-6 transition-colors"
          style={{ background: dragOver ? "#eef2ff" : PAGE_GUTTER }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => editor.chain().focus().run()}
        >
          <div className="mx-auto w-max" style={{ fontFamily: "Georgia, serif", zoom }} onClick={e => e.stopPropagation()}>
            <EditorContent editor={editor} className="paged-editor prose prose-sm max-w-none outline-none focus:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:bg-white [&_.ProseMirror]:text-neutral-900 [&_.ProseMirror]:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)] [&_.ProseMirror]:[overflow-wrap:anywhere] [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:h-auto" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      {!hideToolbar && (
        <div className="p-2 border border-neutral-100 rounded-t-xl bg-neutral-50">
          <RichTextToolbar editor={editor} />
        </div>
      )}

      {/* Merge fields row — click OR drag onto the canvas to insert */}
      {mergeFields.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap px-2 py-1.5 border-x border-neutral-100 bg-white">
          <span className="text-2xs font-semibold uppercase tracking-wider text-neutral-400 mr-1">Drag or click a field</span>
          {mergeFields.filter(f => f.name).map(f => (
            <button
              key={f.name}
              type="button"
              draggable
              onDragStart={e => {
                e.dataTransfer.setData("application/x-merge-field", f.name);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onMouseDown={e => e.preventDefault()}
              onClick={() => insertMerge(f.name)}
              title={"Drag onto the page or click to insert {{" + f.name + "}}"}
              className="text-2xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full hover:bg-brand-100 border border-brand-200 cursor-grab active:cursor-grabbing"
            >
              {"{{" + (f.label || f.name) + "}}"}
            </button>
          ))}
        </div>
      )}

      {/* Editor canvas — accepts drag-drop of merge fields */}
      <div
        className={"border border-t-0 rounded-b-xl bg-white overflow-y-auto flex-1 transition-colors " + (dragOver ? "border-brand-400 bg-brand-50/30" : "border-neutral-100")}
        style={{ minHeight }}
        onClick={() => editor.chain().focus().run()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <EditorContent editor={editor} className="prose prose-sm max-w-none p-4 outline-none focus:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[200px] [&_.ProseMirror]:[overflow-wrap:anywhere] [&_.ProseMirror_table]:max-w-full [&_.ProseMirror_table]:!w-auto [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:h-auto [&_.ProseMirror_*]:!max-w-full" />
      </div>
    </div>
  );
}
