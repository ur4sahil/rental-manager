import React, { useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
// TipTap v3 consolidates the Table extensions into one package — use named imports.
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";

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

export default function RichTextEditor({ value = "", onChange, mergeFields = [], placeholder = "", minHeight = "400px" }) {
  const [dragOver, setDragOver] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
    ],
    content: value,
    onUpdate: ({ editor: ed }) => { if (onChange) onChange(ed.getHTML()); },
  });

  useEffect(() => () => { if (editor) editor.destroy(); }, [editor]);

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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-1 flex-wrap p-2 border border-neutral-100 rounded-t-xl bg-neutral-50">
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="Bold"><b>B</b></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="Italic"><i>I</i></ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} title="Underline"><span className="underline">U</span></ToolbarBtn>
        <span className="w-px h-5 bg-brand-100 mx-1" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })} title="Heading 1">H1</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} title="Heading 2">H2</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })} title="Heading 3">H3</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().setParagraph().run()} active={editor.isActive("paragraph")} title="Paragraph">¶</ToolbarBtn>
        <span className="w-px h-5 bg-brand-100 mx-1" />
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="Bulleted list">•</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Numbered list">1.</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} title="Blockquote">&ldquo;</ToolbarBtn>
        <span className="w-px h-5 bg-brand-100 mx-1" />
        <ToolbarBtn onClick={setLink} active={editor.isActive("link")} title="Link">🔗</ToolbarBtn>
        <ToolbarBtn onClick={insertTable} title="Insert table">⊞</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule">―</ToolbarBtn>
        <span className="w-px h-5 bg-brand-100 mx-1" />
        <ToolbarBtn onClick={() => editor.chain().focus().undo().run()} title="Undo">↶</ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().redo().run()} title="Redo">↷</ToolbarBtn>
      </div>

      {/* Merge fields row — click OR drag onto the canvas to insert */}
      {mergeFields.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap px-2 py-1.5 border-x border-neutral-100 bg-white">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 mr-1">Drag or click a field</span>
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
              className="text-[10px] bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full hover:bg-brand-100 border border-brand-200 cursor-grab active:cursor-grabbing"
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
        <EditorContent editor={editor} className="prose prose-sm max-w-none p-4 outline-none focus:outline-none [&_.ProseMirror]:outline-none [&_.ProseMirror]:min-h-[200px]" />
      </div>
    </div>
  );
}
