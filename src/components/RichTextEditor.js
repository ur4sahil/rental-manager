import React, { useEffect, useRef, useState } from "react";
import { useEditor, useEditorState, EditorContent } from "@tiptap/react";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Extension } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { WORD_SINGLE_LINE } from "../utils/docxImport";
import { DEFAULT_PAGE_SETUP, PAGE_GUTTER, DOC_FONT_FAMILY, DOC_FONT_SIZE, DOC_LINE_HEIGHT, PARSE_OPTIONS, pageGeometry, furnitureHeight, pageSlot, docExtensions, settlePagination } from "../utils/docKit";
import { lengthToInches, inchesToCss, ORDERED_STYLES, BULLET_STYLES, DEFAULT_ORDERED_STYLE, DEFAULT_BULLET } from "../utils/docRules";

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

// Typing "{{" in the page offers the fields; arrows and Enter pick one,
// the letters typed so far filter. The chip cloud above the page went
// away for this. The popover is React; this extension only owns the keys
// while it is open, through a ref the component keeps current.
const FieldSuggestKeys = Extension.create({
  name: "fieldSuggestKeys",
  priority: 1100,
  // A function, not a ref object: configure() deep-copies plain objects,
  // which would freeze the ref at the moment of configuration.
  addOptions() { return { handler: () => null }; },
  addKeyboardShortcuts() {
    const when = (fn) => () => { const h = this.options.handler(); return h ? fn(h) : false; };
    return {
      ArrowDown: when(h => h.move(1)), ArrowUp: when(h => h.move(-1)),
      Enter: when(h => h.pick()), Tab: when(h => h.pick()), Escape: when(h => h.close()),
    };
  },
});
const SUGGEST_RE = /\{\{([\w ]{0,40})$/;

// Only faces the app bundles and embeds in the PDF (the Liberation
// family, metric-identical to these three). Offering Georgia or Calibri
// here would look right on screen and then print in a different font.
const FONT_OPTIONS = [
  ["'Liberation Serif', 'Times New Roman', Times, serif", "Times New Roman"],
  ["'Liberation Sans', Arial, Helvetica, sans-serif", "Arial"],
  ["'Liberation Mono', 'Courier New', monospace", "Courier New"],
];
const SIZE_OPTIONS = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "24", "28", "36"];
// Word's spacing names -> the CSS multiple that reproduces them.
const SPACING_OPTIONS = [["Single", 1], ["1.15", 1.15], ["1.5", 1.5], ["Double", 2]]
  .map(([label, mult]) => [String(+(mult * WORD_SINGLE_LINE).toFixed(3)), label]);
// Two stacks are the same choice if they lead with the same family
// ("Liberation Serif" from a Word import vs. the toolbar's Times stack).
const FONT_ALIASES = { "times new roman": "liberation serif", times: "liberation serif", arial: "liberation sans", helvetica: "liberation sans", "courier new": "liberation mono" };
const fontKey = (v) => { const first = String(v || "").split(",")[0].replace(/['"]/g, "").trim().toLowerCase(); return FONT_ALIASES[first] || first; };

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
//  grow            — paperCanvas only: the pane grows to its pages and the
//                    window scrolls, instead of scrolling inside itself.
//  onPageSetupChange(patch) — paperCanvas only: the rulers can then drag the
//                    page margins and the header/footer distances (px).

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

const ICON = (name, size = 16) => <span className="material-icons-outlined align-middle" style={{ fontSize: size }}>{name}</span>;
const TEXT_COLORS = ["#111111", "#b91c1c", "#1d4ed8", "#047857", "#b45309", "#6d28d9", "#6b7280", "#ffffff"];
const HIGHLIGHTS = ["#fef08a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#fed7aa", "#e9d5ff", "#e5e7eb"];
const STYLE_OPTIONS = [["p", "Body text"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"]];

// A small popover anchored under its button; closes on a click elsewhere.
function Popover({ open, onClose, children, width = 220 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className="absolute left-0 top-full mt-1 z-40 bg-white border border-neutral-200 rounded-xl shadow-pop p-2 text-xs" style={{ width }} onMouseDown={e => e.stopPropagation()}>{children}</div>;
}

function Swatches({ colors, current, onPick, onClear, clearLabel }) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {colors.map(c => (
          <button key={c} type="button" aria-label={c} onClick={() => onPick(c)}
            className={"w-6 h-6 rounded-md border " + (current && current.toLowerCase() === c ? "ring-2 ring-brand-500 border-white" : "border-neutral-300")} style={{ background: c }} />
        ))}
      </div>
      <button type="button" className="mt-2 text-brand-600 hover:underline" onClick={onClear}>{clearLabel}</button>
    </div>
  );
}

// Paragraph dialog: Word's Paragraph box, the parts a lease needs.
function ParagraphPopover({ editor, onClose }) {
  const type = editor.isActive("heading") ? "heading" : "paragraph";
  const a = editor.getAttributes(type);
  const toIn = (v) => (v ? String(+lengthToInches(v).toFixed(2)) : "");
  const toPt = (v) => (v ? String(+(lengthToInches(v) * 72).toFixed(1)) : "");
  const [f, setF] = useState({ left: toIn(a.marginLeft), right: toIn(a.marginRight), first: toIn(a.textIndent), before: toPt(a.marginTop), after: toPt(a.marginBottom), keep: !!a.keepNext });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const inch = (v) => (v === "" || !Number.isFinite(Number(v)) ? null : inchesToCss(Number(v)));
  const pt = (v) => (v === "" || !Number.isFinite(Number(v)) || Number(v) === 0 ? null : `${Number(v)}pt`);
  const apply = () => {
    editor.chain().focus().setParagraphFormat({ marginLeft: inch(f.left), marginRight: inch(f.right), textIndent: inch(f.first), marginTop: pt(f.before), marginBottom: pt(f.after), keepNext: !!f.keep }).run();
    onClose();
  };
  const num = (label, k, unit, step) => (
    <label key={k} className="flex flex-col gap-0.5"><span className="text-neutral-500">{label}</span>
      <span className="flex items-center gap-1"><input type="number" step={step} value={f[k]} onChange={set(k)} className="w-16 h-7 border border-neutral-200 rounded px-1.5" /><span className="text-neutral-400">{unit}</span></span></label>
  );
  return (
    <div className="space-y-2">
      <div className="font-semibold text-neutral-700">Paragraph</div>
      <div className="grid grid-cols-3 gap-2">
        {num("Left indent", "left", "in", "0.25")}{num("Right indent", "right", "in", "0.25")}{num("First line", "first", "in", "0.25")}
        {num("Space before", "before", "pt", "1")}{num("Space after", "after", "pt", "1")}
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={f.keep} onChange={set("keep")} className="accent-brand-600" />Keep with next paragraph (never left alone at the foot of a page)</label>
      <div className="flex gap-2 pt-1"><button type="button" onClick={apply} className="px-3 py-1 rounded bg-brand-600 text-white font-semibold">Apply</button><button type="button" onClick={onClose} className="px-3 py-1 rounded border border-neutral-200">Cancel</button></div>
    </div>
  );
}

function FindPopover({ editor, onClose }) {
  const [q, setQ] = useState(editor.storage.findReplace?.query || "");
  const [r, setR] = useState("");
  const [cs, setCs] = useState(false);
  const st = editor.storage.findReplace || { matches: [], index: -1 };
  const search = (value, caseSensitive) => { setQ(value); editor.commands.setSearch(value, { caseSensitive }); };
  const close = () => { editor.commands.clearSearch(); onClose(); };
  return (
    <div className="space-y-2">
      <div className="font-semibold text-neutral-700">Find and replace</div>
      <input autoFocus value={q} onChange={e => search(e.target.value, cs)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) editor.commands.findPrevious(); else editor.commands.findNext(); } }} placeholder="Find" className="w-full h-7 border border-neutral-200 rounded px-2" />
      <input value={r} onChange={e => setR(e.target.value)} placeholder="Replace with" className="w-full h-7 border border-neutral-200 rounded px-2" />
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1"><input type="checkbox" checked={cs} onChange={e => { setCs(e.target.checked); search(q, e.target.checked); }} className="accent-brand-600" />Match case</label>
        <span className="text-neutral-500">{q ? (st.matches.length ? `${st.index + 1} of ${st.matches.length}` : "No matches") : ""}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => editor.commands.findPrevious()} className="px-2 py-1 rounded border border-neutral-200">Previous</button>
        <button type="button" onClick={() => editor.commands.findNext()} className="px-2 py-1 rounded border border-neutral-200">Next</button>
        <button type="button" onClick={() => editor.commands.replaceCurrent(r)} disabled={st.index < 0} className="px-2 py-1 rounded border border-neutral-200 disabled:opacity-40">Replace</button>
        <button type="button" onClick={() => editor.commands.replaceAll(r)} disabled={!st.matches.length} className="px-2 py-1 rounded bg-brand-600 text-white font-semibold disabled:opacity-40">Replace all</button>
        <button type="button" onClick={close} className="ml-auto px-2 py-1 rounded border border-neutral-200">Done</button>
      </div>
    </div>
  );
}

function TablePopover({ editor, onClose }) {
  const run = (fn) => { fn(editor.chain().focus()).run(); };
  const borders = editor.getAttributes("table").borders || "all";
  const B = ({ label, cmd }) => <button type="button" onClick={() => run(cmd)} className="px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50 text-left">{label}</button>;
  return (
    <div className="space-y-2">
      <div className="font-semibold text-neutral-700">Table</div>
      <div className="grid grid-cols-2 gap-1.5">
        <B label="Row above" cmd={c => c.addRowBefore()} /><B label="Row below" cmd={c => c.addRowAfter()} />
        <B label="Column left" cmd={c => c.addColumnBefore()} /><B label="Column right" cmd={c => c.addColumnAfter()} />
        <B label="Delete row" cmd={c => c.deleteRow()} /><B label="Delete column" cmd={c => c.deleteColumn()} />
        <B label="Merge cells" cmd={c => c.mergeCells()} /><B label="Split cell" cmd={c => c.splitCell()} />
        <B label="Header row on/off" cmd={c => c.toggleHeaderRow()} /><B label="Delete table" cmd={c => c.deleteTable()} />
      </div>
      <div className="text-neutral-500">Borders</div>
      <div className="flex gap-1.5">
        {[["all", "All"], ["outer", "Outside only"], ["none", "None"]].map(([v, l]) => (
          <button key={v} type="button" onClick={() => run(c => c.setTableBorders(v === "all" ? null : v))} className={"px-2 py-1 rounded border " + (borders === v ? "bg-brand-600 border-brand-600 text-white" : "border-neutral-200")}>{l}</button>
        ))}
      </div>
      <div className="text-neutral-400">Drag a column's right edge to resize it.</div>
      <button type="button" onClick={onClose} className="px-2 py-1 rounded border border-neutral-200">Done</button>
    </div>
  );
}

function ToolbarInner({ editor, compact }) {
  // The ribbon lives outside the editor, so nothing re-renders it when the
  // cursor moves. Subscribe to the bits it shows, or the font/size boxes
  // and the active buttons go stale the moment you click elsewhere.
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"), strike: e.isActive("strike"),
      sup: e.isActive("superscript"), sub: e.isActive("subscript"),
      style: e.isActive("heading", { level: 1 }) ? "h1" : e.isActive("heading", { level: 2 }) ? "h2" : e.isActive("heading", { level: 3 }) ? "h3" : "p",
      bullet: e.isActive("bulletList"), ordered: e.isActive("orderedList"), inTable: e.isActive("table"), link: e.isActive("link"),
      bulletStyle: e.getAttributes("bulletList").bullet || DEFAULT_BULLET,
      listStyle: e.getAttributes("orderedList").listStyle || DEFAULT_ORDERED_STYLE,
      fontFamily: e.getAttributes("textStyle").fontFamily || "",
      fontSize: e.getAttributes("textStyle").fontSize || "",
      color: e.getAttributes("textStyle").color || "",
      highlight: e.getAttributes("textStyle").backgroundColor || "",
      align: ["center", "right", "justify"].find(a => e.isActive({ textAlign: a })) || "left",
      lineHeight: e.getAttributes("paragraph").lineHeight || e.getAttributes("heading").lineHeight || "",
      canUndo: e.can().undo(), canRedo: e.can().redo(),
    }),
  });
  const [open, setOpen] = useState("");   // which popover: color | highlight | paragraph | table | find | bullets | numbers
  const toggle = (name) => setOpen(o => (o === name ? "" : name));
  const close = () => setOpen("");
  const setLink = () => {
    const prev = editor.getAttributes("link").href || "";
    // eslint-disable-next-line no-alert
    const url = window.prompt("Link URL", prev);
    if (url === null) return;
    if (url === "") { editor.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
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
    <ToolbarBtn onClick={() => editor.chain().focus().setTextAlign(value).run()} active={st.align === value} title={title}>{ICON(icon, 15)}</ToolbarBtn>
  );
  // Not a component: a component defined inside the render would be a new
  // type each time and remount its popover (and lose the Find box's focus)
  // on every keystroke.
  const drop = (name, children) => <div className="relative inline-flex">{children}<Popover open={open === name} onClose={close} width={name === "find" ? 300 : name === "paragraph" ? 320 : name === "table" ? 260 : 200}>
    {open === "color" && <Swatches colors={TEXT_COLORS} current={st.color} onPick={c => { editor.chain().focus().setColor(c).run(); close(); }} onClear={() => { editor.chain().focus().unsetColor().run(); close(); }} clearLabel="Automatic" />}
    {open === "highlight" && <Swatches colors={HIGHLIGHTS} current={st.highlight} onPick={c => { editor.chain().focus().setBackgroundColor(c).run(); close(); }} onClear={() => { editor.chain().focus().unsetBackgroundColor().run(); close(); }} clearLabel="No highlight" />}
    {open === "paragraph" && <ParagraphPopover editor={editor} onClose={close} />}
    {open === "find" && <FindPopover editor={editor} onClose={close} />}
    {open === "table" && <TablePopover editor={editor} onClose={close} />}
    {open === "bullets" && <div className="space-y-1">{BULLET_STYLES.map(b => <button key={b.key} type="button" onClick={() => { editor.chain().focus().setBullet(b.key).run(); close(); }} className={"block w-full text-left px-2 py-1 rounded " + (st.bullet && st.bulletStyle === b.key ? "bg-brand-50 text-brand-700" : "hover:bg-neutral-50")}>{b.label}</button>)}</div>}
    {open === "numbers" && <div className="space-y-1">
      {ORDERED_STYLES.map(o => <button key={o.key} type="button" onClick={() => { editor.chain().focus().setListStyle(o.key).run(); close(); }} className={"block w-full text-left px-2 py-1 rounded " + (st.ordered && st.listStyle === o.key ? "bg-brand-50 text-brand-700" : "hover:bg-neutral-50")}>{o.label}</button>)}
      {st.ordered && <div className="border-t border-neutral-100 pt-1 mt-1 flex gap-1.5">
        <button type="button" onClick={() => { editor.chain().focus().restartListAt(1).run(); close(); }} className="px-2 py-1 rounded border border-neutral-200">Restart at 1</button>
        <button type="button" onClick={() => { editor.chain().focus().continueList().run(); close(); }} className="px-2 py-1 rounded border border-neutral-200">Continue previous</button>
      </div>}
    </div>}
  </Popover></div>;

  return (
    <div className={"flex items-center flex-wrap " + gap}>
      <ToolbarBtn onClick={() => editor.chain().focus().undo().run()} title="Undo (Ctrl+Z)">{ICON("undo", 15)}</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().redo().run()} title="Redo (Ctrl+Y)">{ICON("redo", 15)}</ToolbarBtn>
      {sep}
      <ToolbarSelect title="Paragraph style" width="w-[104px]" value={st.style}
        onChange={e => (e.target.value === "p" ? editor.chain().focus().setParagraph().run() : editor.chain().focus().setHeading({ level: Number(e.target.value.slice(1)) }).run())}>
        {STYLE_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </ToolbarSelect>
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
      <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={st.bold} title="Bold (Ctrl+B)"><b>B</b></ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={st.italic} title="Italic (Ctrl+I)"><i>I</i></ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={st.underline} title="Underline (Ctrl+U)"><span className="underline">U</span></ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleStrike().run()} active={st.strike} title="Strikethrough"><span className="line-through">S</span></ToolbarBtn>
      {drop("color", <><ToolbarBtn onClick={() => toggle("color")} active={!!st.color} title="Text colour"><span className="inline-flex flex-col items-center leading-none">{ICON("format_color_text", 14)}<span className="block h-[3px] w-4 mt-px rounded-sm" style={{ background: st.color || "#111" }} /></span></ToolbarBtn></>)}
      {drop("highlight", <><ToolbarBtn onClick={() => toggle("highlight")} active={!!st.highlight} title="Highlight"><span className="inline-flex flex-col items-center leading-none">{ICON("border_color", 14)}<span className="block h-[3px] w-4 mt-px rounded-sm" style={{ background: st.highlight || "#fef08a" }} /></span></ToolbarBtn></>)}
      <ToolbarBtn onClick={() => editor.chain().focus().toggleSuperscript().run()} active={st.sup} title="Superscript">{ICON("superscript", 15)}</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().toggleSubscript().run()} active={st.sub} title="Subscript">{ICON("subscript", 15)}</ToolbarBtn>
      {sep}
      {alignBtn("left", "format_align_left", "Align left")}
      {alignBtn("center", "format_align_center", "Center")}
      {alignBtn("right", "format_align_right", "Align right")}
      {alignBtn("justify", "format_align_justify", "Justify")}
      <ToolbarBtn onClick={() => editor.chain().focus().outdent().run()} title="Decrease indent (Shift+Tab)">{ICON("format_indent_decrease", 15)}</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().indent().run()} title="Increase indent (Tab)">{ICON("format_indent_increase", 15)}</ToolbarBtn>
      <ToolbarSelect title="Line spacing" width="w-[78px]" value={spacing ? spacing[0] : ""}
        onChange={e => editor.chain().focus().setLineHeight(e.target.value || null).run()}>
        <option value="">Spacing</option>
        {SPACING_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </ToolbarSelect>
      {drop("paragraph", <ToolbarBtn onClick={() => toggle("paragraph")} title="Paragraph: indents, space before and after, keep with next">{ICON("format_line_spacing", 15)}</ToolbarBtn>)}
      {sep}
      {drop("bullets", <><span className="inline-flex">
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={st.bullet} title="Bulleted list">{ICON("format_list_bulleted", 15)}</ToolbarBtn>
        <ToolbarBtn onClick={() => toggle("bullets")} title="Bullet style">{ICON("arrow_drop_down", 14)}</ToolbarBtn>
      </span></>)}
      {drop("numbers", <><span className="inline-flex">
        <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={st.ordered} title="Numbered list">{ICON("format_list_numbered", 15)}</ToolbarBtn>
        <ToolbarBtn onClick={() => toggle("numbers")} title="Numbering style, restart, continue">{ICON("arrow_drop_down", 14)}</ToolbarBtn>
      </span></>)}
      {sep}
      <ToolbarBtn onClick={setLink} active={st.link} title="Link">{ICON("link", 15)}</ToolbarBtn>
      {drop("table", <ToolbarBtn onClick={() => { if (st.inTable) toggle("table"); else editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run(); }} active={st.inTable} title={st.inTable ? "Table: rows, columns, merge, borders" : "Insert table"}>{ICON("table_chart", 15)}</ToolbarBtn>)}
      <ToolbarBtn onClick={() => editor.chain().focus().insertCheckbox().run()} title="Insert a checkbox (click it to tick)">{ICON("check_box_outline_blank", 15)}</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().insertPageBreak().run()} title="Page break">{ICON("insert_page_break", 15)}</ToolbarBtn>
      <ToolbarBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">{ICON("horizontal_rule", 15)}</ToolbarBtn>
      {sep}
      {drop("find", <ToolbarBtn onClick={() => toggle("find")} title="Find and replace (Ctrl+F)">{ICON("search", 15)}</ToolbarBtn>)}
    </div>
  );
}

// Word's ruler: inches across the page, the margins greyed, and the
// current paragraph's indents as markers you can drag. Default tab stops
// every half inch (index.css tab-size), shown as ticks. Sized to the sheet
// at the current zoom so the inch marks line up with the text.
// Page setup edits from the rulers: a value in page px, snapped to a
// sixteenth of an inch and kept inside the page.
export const PAGE_SETUP_LIMITS = {
  marginLeft: (g) => [24, g.pageWidth / 2 - 48], marginRight: (g) => [24, g.pageWidth / 2 - 48],
  marginTop: (g) => [Math.max(24, g.headerDistance + 12), g.pageHeight / 3], marginBottom: (g) => [Math.max(24, g.footerDistance + 12), g.pageHeight / 3],
  headerDistance: (g) => [0, g.marginTop - 12], footerDistance: (g) => [0, g.marginBottom - 12],
};
export function snapPageSetup(key, px, g) {
  const [lo, hi] = PAGE_SETUP_LIMITS[key] ? PAGE_SETUP_LIMITS[key](g) : [0, Infinity];
  return Math.round(Math.max(lo, Math.min(hi, px)) / 6) * 6;
}
const fmtIn = (px) => (px / 96).toFixed(2) + '"';

export function Ruler({ editor, setup, zoom = 1, onSetupChange = null }) {
  const st = useEditorState({ editor, selector: ({ editor: e }) => {
    const a = e.isActive("heading") ? e.getAttributes("heading") : e.getAttributes("paragraph");
    return { left: lengthToInches(a.marginLeft), right: lengthToInches(a.marginRight), first: lengthToInches(a.textIndent), has: e.isActive("paragraph") || e.isActive("heading") };
  } });
  const [drag, setDrag] = useState(null);   // { kind, startX, startVal }
  const ref = useRef(null);
  const g = pageGeometry(setup, 0, 0);
  const pxPerIn = 96 * zoom;
  const width = g.pageWidth * zoom, mL = g.marginLeft * zoom, mR = g.marginRight * zoom;
  const textWidth = width - mL - mR;
  const inches = Math.floor(textWidth / pxPerIn);
  const x = (inch) => mL + inch * pxPerIn;
  const apply = (kind, inchesVal) => {
    const v = Math.max(kind === "first" ? -3 : 0, Math.min(6, Math.round(inchesVal * 16) / 16));
    const attrs = kind === "left" ? { marginLeft: inchesToCss(v) } : kind === "right" ? { marginRight: inchesToCss(v) } : { textIndent: inchesToCss(v) };
    editor.chain().setParagraphFormat(attrs).run();
  };
  const onDown = (kind, startVal) => (e) => { e.preventDefault(); setDrag({ kind, startX: e.clientX, startVal }); };
  // The page's own left/right margins: dragged on the ruler, committed on
  // release (every change re-flows every page).
  const [pageDrag, setPageDrag] = useState(null);   // { key, startX, startVal (px), value (px) }
  const geom = { ...g, headerDistance: setup.headerDistance ?? 48, footerDistance: setup.footerDistance ?? 48 };
  const onPageDown = (key) => (e) => { e.preventDefault(); e.stopPropagation(); setPageDrag({ key, startX: e.clientX, startVal: g[key], value: g[key] }); };
  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => apply(drag.kind, drag.startVal + (e.clientX - drag.startX) / pxPerIn * (drag.kind === "right" ? -1 : 1));
    const up = () => { setDrag(null); editor.commands.focus(); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);
  useEffect(() => {
    if (!pageDrag) return undefined;
    const move = (e) => setPageDrag(d => ({ ...d, value: snapPageSetup(d.key, d.startVal + (e.clientX - d.startX) / zoom * (d.key === "marginRight" ? -1 : 1), geom) }));
    const up = () => { setPageDrag(d => { if (d && onSetupChange && d.value !== d.startVal) onSetupChange({ [d.key]: d.value }); return null; }); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!pageDrag]);
  const liveL = (pageDrag?.key === "marginLeft" ? pageDrag.value : g.marginLeft) * zoom;
  const liveR = (pageDrag?.key === "marginRight" ? pageDrag.value : g.marginRight) * zoom;
  const marker = (kind, left, title, shape, color) => (
    <button type="button" aria-label={title} title={title} onMouseDown={onDown(kind, kind === "left" ? st.left : kind === "right" ? st.right : st.first)}
      className="absolute p-0 border-0 bg-transparent cursor-ew-resize" style={{ left: left - 6, top: shape === "down" ? 1 : 13, width: 12, height: 12, minHeight: 0, lineHeight: 0 }}>
      {shape === "down"
        ? <svg width="12" height="9" viewBox="0 0 12 9"><path d="M1 0h10L6 8z" fill={color} /></svg>
        : <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 0l5 5v7H1V5z" fill={color} /></svg>}
    </button>
  );
  return (
    <div ref={ref} className="mx-auto relative select-none bg-white border border-neutral-200 rounded-md text-2xs text-neutral-500 overflow-hidden" style={{ width, height: 28 }} aria-label="Ruler">
      <div className="absolute inset-y-0 left-0 bg-neutral-100" style={{ width: mL }} />
      <div className="absolute inset-y-0 right-0 bg-neutral-100" style={{ width: mR }} />
      {Array.from({ length: Math.floor(textWidth / (pxPerIn / 2)) + 1 }, (_, i) => i / 2).map(inch => (
        <div key={inch} className="absolute bg-neutral-400" style={{ left: x(inch), top: inch % 1 === 0 ? 8 : 11, width: 1, height: inch % 1 === 0 ? 8 : 4 }} />
      ))}
      {Array.from({ length: Math.floor(textWidth / (pxPerIn / 8)) + 1 }, (_, i) => i / 8).filter(v => v % 0.5 !== 0).map(inch => (
        <div key={inch} className="absolute bg-neutral-300" style={{ left: x(inch), top: 12, width: 1, height: 2 }} />
      ))}
      {Array.from({ length: inches }, (_, i) => i + 1).map(n => <span key={n} className="absolute" style={{ left: x(n) + 3, top: 15 }}>{n}</span>)}
      {st.has && marker("first", x(st.left + st.first), `First-line indent ${st.first.toFixed(2)}"`, "down", "#4f46e5")}
      {st.has && marker("left", x(st.left), `Left indent ${st.left.toFixed(2)}"`, "up", "#4f46e5")}
      {st.has && marker("right", x(textWidth / pxPerIn - st.right), `Right indent ${st.right.toFixed(2)}"`, "up", "#4f46e5")}
      {onSetupChange && (
        <>
          <button type="button" aria-label={`Left page margin ${fmtIn(g.marginLeft)}`} title={`Left page margin ${fmtIn(g.marginLeft)} — drag`} onMouseDown={onPageDown("marginLeft")}
            className="absolute inset-y-0 p-0 border-0 bg-transparent cursor-ew-resize hover:bg-brand-100/60" style={{ left: liveL - 3, width: 6 }} />
          <button type="button" aria-label={`Right page margin ${fmtIn(g.marginRight)}`} title={`Right page margin ${fmtIn(g.marginRight)} — drag`} onMouseDown={onPageDown("marginRight")}
            className="absolute inset-y-0 p-0 border-0 bg-transparent cursor-ew-resize hover:bg-brand-100/60" style={{ left: width - liveR - 3, width: 6 }} />
          {pageDrag && <div className="absolute top-0 px-1 rounded bg-neutral-800 text-white" style={{ left: (pageDrag.key === "marginLeft" ? liveL : width - liveR) + 6, fontSize: 10 }}>{fmtIn(pageDrag.value)}</div>}
        </>
      )}
    </div>
  );
}

// The vertical ruler beside page 1: the top and bottom margins (where the
// body starts and ends) and the header and footer distances (where their
// text sits), each a handle to drag. Inches, like Word. A change is
// committed on release and re-flows the document.
export function VRuler({ setup, zoom = 1, onSetupChange }) {
  // The raw page setup (pageGeometry() re-maps marginTop to the add-on's
  // own meaning, so it is not read here).
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
  const d = DEFAULT_PAGE_SETUP;
  const g = { pageWidth: num(setup.pageWidth, d.pageWidth), pageHeight: num(setup.pageHeight, d.pageHeight), marginTop: num(setup.marginTop, d.marginTop), marginBottom: num(setup.marginBottom, d.marginBottom) };
  const geom = { ...g, headerDistance: Math.min(num(setup.headerDistance, d.headerDistance), g.marginTop), footerDistance: Math.min(num(setup.footerDistance, d.footerDistance), g.marginBottom) };
  const pxPerIn = 96 * zoom;
  const height = g.pageHeight * zoom;
  const [drag, setDrag] = useState(null);   // { key, startY, startVal, value } in page px
  const onDown = (key) => (e) => { e.preventDefault(); setDrag({ key, startY: e.clientY, startVal: geom[key], value: geom[key] }); };
  useEffect(() => {
    if (!drag) return undefined;
    const fromBottom = (k) => k === "marginBottom" || k === "footerDistance";
    const move = (e) => setDrag(d => ({ ...d, value: snapPageSetup(d.key, d.startVal + (e.clientY - d.startY) / zoom * (fromBottom(d.key) ? -1 : 1), geom) }));
    const up = () => { setDrag(d => { if (d && onSetupChange && d.value !== d.startVal) onSetupChange({ [d.key]: d.value }); return null; }); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag]);
  const val = (k) => (drag?.key === k ? drag.value : geom[k]);
  const y = { headerDistance: val("headerDistance") * zoom, marginTop: val("marginTop") * zoom, marginBottom: height - val("marginBottom") * zoom, footerDistance: height - val("footerDistance") * zoom };
  const inches = Math.floor(g.pageHeight / 96);
  const handle = (key, top, title, color, flip) => (
    <button type="button" aria-label={title} title={title + " — drag"} onMouseDown={onDown(key)}
      className="absolute p-0 border-0 bg-transparent cursor-ns-resize" style={{ top: top - 6, left: 4, width: 14, height: 12, minHeight: 0, lineHeight: 0 }}>
      <svg width="14" height="12" viewBox="0 0 14 12" style={{ display: "block" }}>{flip ? <path d="M1 11h12L7 2z" fill={color} /> : <path d="M1 1h12L7 10z" fill={color} />}</svg>
    </button>
  );
  return (
    <div className="absolute select-none bg-white border border-neutral-200 rounded-md text-2xs text-neutral-500 overflow-visible" style={{ left: -30, top: 0, width: 22, height }} aria-label="Vertical ruler">
      <div className="absolute inset-x-0 top-0 bg-neutral-100" style={{ height: y.marginTop }} />
      <div className="absolute inset-x-0 bottom-0 bg-neutral-100" style={{ height: height - y.marginBottom }} />
      {Array.from({ length: Math.floor(g.pageHeight / 48) + 1 }, (_, i) => i / 2).map(inch => (
        <div key={inch} className="absolute bg-neutral-400" style={{ top: inch * pxPerIn, left: inch % 1 === 0 ? 12 : 15, height: 1, width: inch % 1 === 0 ? 8 : 4 }} />
      ))}
      {Array.from({ length: inches }, (_, i) => i + 1).map(n => <span key={n} className="absolute" style={{ top: n * pxPerIn + 2, left: 2, fontSize: 9 }}>{n}</span>)}
      <div className="absolute inset-x-0 border-t border-dashed border-brand-300" style={{ top: y.headerDistance }} />
      <div className="absolute inset-x-0 border-t border-dashed border-brand-300" style={{ top: y.footerDistance }} />
      {handle("headerDistance", y.headerDistance, `Header from top ${fmtIn(val("headerDistance"))}`, "#c2410c", false)}
      {handle("marginTop", y.marginTop, `Top margin ${fmtIn(val("marginTop"))}`, "#4f46e5", true)}
      {handle("marginBottom", y.marginBottom, `Bottom margin ${fmtIn(val("marginBottom"))}`, "#4f46e5", false)}
      {handle("footerDistance", y.footerDistance, `Footer from bottom ${fmtIn(val("footerDistance"))}`, "#c2410c", true)}
      {drag && <div className="absolute px-1 rounded bg-neutral-800 text-white whitespace-nowrap" style={{ left: 26, top: y[drag.key] - 8, fontSize: 10 }}>{drag.key.replace(/([A-Z])/g, " $1").toLowerCase()} {fmtIn(drag.value)}</div>}
    </div>
  );
}

export default function RichTextEditor({ value = "", onChange, mergeFields = [], placeholder = "", minHeight = "400px", hideToolbar = false, onEditorReady = null, grow = false, onPageSetupChange = null, paperCanvas = false, pageSetup = null, readOnly = false, showRuler = true, showFieldChips = true }) {
  const [dragOver, setDragOver] = useState(false);
  const setup = { ...DEFAULT_PAGE_SETUP, ...(pageSetup || {}) };
  const setupKey = JSON.stringify(setup);
  const suggestRef = useRef(null);
  const [suggest, setSuggest] = useState(null);   // { from, to, query, index, x, y } while "{{" is being typed
  const editor = useEditor({
    extensions: docExtensions({
      // Real pages only on the paper canvas (template editor, previews).
      paged: paperCanvas,
      setup,
      // A read-only view shows the finished document: no "start typing"
      // hint, and any {{tag}} left unfilled should read as itself.
      extra: readOnly ? [] : [Placeholder.configure({ placeholder }), MergeTagHighlight, FieldSuggestKeys.configure({ handler: () => suggestRef.current })],
    }),
    editable: !readOnly,
    content: value,
    parseOptions: PARSE_OPTIONS,
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

  // "{{" typed in the page: watch the text before the cursor.
  const fieldsRef = useRef(mergeFields); fieldsRef.current = mergeFields;
  useEffect(() => {
    if (!editor || readOnly) return undefined;
    const onTr = () => {
      const { $from, empty } = editor.state.selection;
      if (!empty || !$from.parent.isTextblock) { setSuggest(null); return; }
      const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
      const m = before.match(SUGGEST_RE);
      if (!m || !(fieldsRef.current || []).length) { setSuggest(null); return; }
      let x = 0, y = 0;
      try { const c = editor.view.coordsAtPos($from.pos); x = c.left; y = c.bottom; } catch { /* no coords yet */ }
      setSuggest(prev => ({ from: $from.pos - m[0].length, to: $from.pos, query: m[1].trim().toLowerCase(), index: prev && prev.query === m[1].trim().toLowerCase() ? prev.index : 0, x, y }));
    };
    editor.on("transaction", onTr);
    editor.on("blur", () => setSuggest(null));
    return () => { editor.off("transaction", onTr); };
  }, [editor, readOnly]);
  const suggestions = suggest ? (mergeFields || []).filter(f => f.name && (!suggest.query || (f.label || "").toLowerCase().includes(suggest.query) || f.name.toLowerCase().includes(suggest.query))).slice(0, 8) : [];
  const pickSuggestion = (f) => {
    if (!editor || !suggest || !f) return;
    editor.chain().focus().insertContentAt({ from: suggest.from, to: suggest.to }, "{{" + f.name + "}}").run();
    setSuggest(null);
  };
  suggestRef.current = suggest && suggestions.length ? {
    move: (d) => { setSuggest(p => (p ? { ...p, index: (p.index + d + suggestions.length) % suggestions.length } : p)); return true; },
    pick: () => { pickSuggestion(suggestions[suggest.index] || suggestions[0]); return true; },
    close: () => { setSuggest(null); return true; },
  } : null;
  // For the browser tests: the editor instance, in development only.
  useEffect(() => { if (editor && process.env.NODE_ENV !== "production" && !readOnly) window.__hxEditor = editor; }, [editor, readOnly]);

  // A read-only view is driven by its `value`: the live preview re-merges
  // the document on every keystroke in the form beside it.
  // Compared against the last value APPLIED, not the editor's HTML: the
  // editor normalises markup, so the two never match and every unrelated
  // re-render would reload (and re-paginate) the whole document.
  const appliedValue = useRef(value);
  useEffect(() => {
    if (!editor || !readOnly || editor.isDestroyed) return;
    if (appliedValue.current === value) return;
    appliedValue.current = value;
    editor.commands.setContent(value || "", { emitUpdate: false, parseOptions: PARSE_OPTIONS });
  }, [editor, readOnly, value]);

  // Hand the editor instance up to the parent so it can mount the
  // standalone RichTextToolbar elsewhere (e.g. in the ribbon).
  useEffect(() => { if (editor && onEditorReady) onEditorReady(editor); }, [editor, onEditorReady]);

  // Header/footer text and page setup are edited in the side panel (or
  // replaced by a Word import) while the editor is open; push each change
  // into the page furniture.
  const { headerLeft, headerRight, footerLeft, footerRight, firstPageDifferent, firstHeaderLeft, firstHeaderRight, firstFooterLeft, firstFooterRight } = setup;
  const geometryKey = JSON.stringify(pageGeometry(setup, 0, 0));
  useEffect(() => {
    if (!editor || !paperCanvas || editor.isDestroyed) return;
    try { if (!editor.view.dom) return; } catch { return; }
    const s = JSON.parse(setupKey);
    const g = pageGeometry(s, furnitureHeight(s.headerLeft, s.headerRight), furnitureHeight(s.footerLeft, s.footerRight));
    // Page 1 keeps its own header and footer when asked; otherwise it
    // gets the common ones (there is no "clear" for a page, so set them).
    editor.chain()
      .updateHeaderContent(pageSlot(headerLeft), pageSlot(headerRight))
      .updateFooterContent(pageSlot(footerLeft), pageSlot(footerRight))
      .updateHeaderContent(pageSlot(firstPageDifferent ? firstHeaderLeft : headerLeft), pageSlot(firstPageDifferent ? firstHeaderRight : headerRight), 1)
      .updateFooterContent(pageSlot(firstPageDifferent ? firstFooterLeft : footerLeft), pageSlot(firstPageDifferent ? firstFooterRight : footerRight), 1)
      .updatePageWidth(g.pageWidth).updatePageHeight(g.pageHeight)
      .updateMargins({ top: g.marginTop, bottom: g.marginBottom, left: g.marginLeft, right: g.marginRight })
      .updateContentMargins({ top: g.contentMarginTop, bottom: g.contentMarginBottom })
      .run();
  // setupKey carries every field of the setup; geometryKey is the part of it that moves the layout.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, paperCanvas, headerLeft, headerRight, footerLeft, footerRight, firstPageDifferent, firstHeaderLeft, firstHeaderRight, firstFooterLeft, firstFooterRight, geometryKey]);

  // Settle the page count once layout (and the fonts) are in, and again
  // whenever the sheet is re-scaled. See settlePagination.
  const [zoom, setZoom] = useState(1);
  const paneRef = useRef(null);
  useEffect(() => {
    if (!editor || !paperCanvas) return undefined;
    let run = settlePagination(editor);
    if (document.fonts?.ready) document.fonts.ready.then(() => { run.cancel(); run = settlePagination(editor); }).catch(() => {});
    return () => run.cancel();
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
      const next = room > 0 && room < sheetWidth ? Math.max(0.4, Math.floor((room / sheetWidth) * 100) / 100) : 1;
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
        {!hideToolbar && !readOnly && (
          <div className="px-2 py-1.5 border-b border-neutral-100 bg-white">
            <RichTextToolbar editor={editor} compact />
          </div>
        )}
        {!readOnly && showFieldChips && mergeFields.length > 0 && (
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
        {suggest && suggestions.length > 0 && (
          <div role="listbox" aria-label="Fields" className="fixed z-50 w-72 bg-white border border-neutral-200 rounded-xl shadow-pop p-1 text-xs" style={{ left: suggest.x, top: suggest.y + 4 }} onMouseDown={e => e.preventDefault()}>
            <div className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-neutral-400">{suggest.query ? `Fields matching "${suggest.query}"` : "Fields"}</div>
            {suggestions.map((f, i) => (
              <button key={f.name} type="button" role="option" aria-selected={i === suggest.index} onClick={() => pickSuggestion(f)}
                className={"w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left " + (i === suggest.index ? "bg-brand-50 text-brand-800" : "hover:bg-neutral-50")}>
                <span className="font-semibold truncate">{f.label || f.name}</span>
                <code className="text-2xs text-neutral-400 shrink-0">{"{{" + f.name + "}}"}</code>
              </button>
            ))}
            <div className="px-2 py-1 text-2xs text-neutral-400 border-t border-neutral-100 mt-1">↑↓ choose · Enter insert · Esc close</div>
          </div>
        )}
        <div
          ref={paneRef}
          // `grow`: the pane takes the height of its pages and the window
          // scrolls (the signing page); otherwise it scrolls inside itself.
          className={(grow ? "overflow-visible" : "flex-1 overflow-auto") + " p-6 transition-colors"}
          style={{ background: dragOver ? "#eef2ff" : PAGE_GUTTER }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => { if (!readOnly) editor.chain().focus().run(); }}
        >
          {/* Sticky: the page area scrolls, the ruler stays at the top of
              it on every page (it used to scroll away with page 1). */}
          {!readOnly && showRuler && <div className="sticky -top-6 z-10 -mx-6 -mt-6 px-6 pt-6 pb-2 mb-2" style={{ background: PAGE_GUTTER }} onClick={e => e.stopPropagation()}><Ruler editor={editor} setup={setup} zoom={zoom} onSetupChange={onPageSetupChange} /></div>}
          <div className="relative mx-auto w-max">
          {!readOnly && showRuler && onPageSetupChange && <div onClick={e => e.stopPropagation()}><VRuler setup={setup} zoom={zoom} onSetupChange={onPageSetupChange} /></div>}
          <div className="mx-auto w-max" style={{ fontFamily: DOC_FONT_FAMILY, fontSize: DOC_FONT_SIZE, lineHeight: DOC_LINE_HEIGHT, zoom }} onClick={e => e.stopPropagation()}>
            <EditorContent editor={editor} className="paged-editor prose prose-sm max-w-none outline-none focus:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:bg-white [&_.ProseMirror]:text-neutral-900 [&_.ProseMirror]:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)] [&_.ProseMirror]:[overflow-wrap:anywhere] [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:h-auto" />
          </div>
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

        {suggest && suggestions.length > 0 && (
          <div role="listbox" aria-label="Fields" className="fixed z-50 w-72 bg-white border border-neutral-200 rounded-xl shadow-pop p-1 text-xs" style={{ left: suggest.x, top: suggest.y + 4 }} onMouseDown={e => e.preventDefault()}>
            <div className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-neutral-400">{suggest.query ? `Fields matching "${suggest.query}"` : "Fields"}</div>
            {suggestions.map((f, i) => (
              <button key={f.name} type="button" role="option" aria-selected={i === suggest.index} onClick={() => pickSuggestion(f)}
                className={"w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left " + (i === suggest.index ? "bg-brand-50 text-brand-800" : "hover:bg-neutral-50")}>
                <span className="font-semibold truncate">{f.label || f.name}</span>
                <code className="text-2xs text-neutral-400 shrink-0">{"{{" + f.name + "}}"}</code>
              </button>
            ))}
            <div className="px-2 py-1 text-2xs text-neutral-400 border-t border-neutral-100 mt-1">↑↓ choose · Enter insert · Esc close</div>
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
