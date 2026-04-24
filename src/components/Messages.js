import React, { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { supabase } from "../supabase";
import { Btn, Input, PageHeader, Textarea, TextLink} from "../ui";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { shortId, sanitizeFileName, getSignedUrl } from "../utils/helpers";
import { Spinner } from "./shared";

// Emoji picker is ~180 kB gzipped — lazy-load so it only downloads when a
// user first opens the picker. Initial bundle stays unchanged.
const EmojiPicker = React.lazy(() => import("emoji-picker-react"));

// Narrower than the documents uploader — chat attachments are casual
// context (screenshots, lease scans, utility bills). No executables.
const MSG_ATTACHMENT_EXT = /\.(pdf|png|jpe?g|gif|webp|heic|doc|docx|xls|xlsx|txt|csv)$/i;
const MSG_ATTACHMENT_MAX = 10 * 1024 * 1024; // 10MB

// ============================================================
// MessageThread — shared bubble renderer
// Used by the admin Messages page AND by the tenant-portal/tenants-drawer
// "messages" tabs so the chat styling stays in one place.
// ============================================================
export function MessageThread({ messages, viewerRole, viewerName, emptyLabel, onDelete, tenantName, companyName }) {
  const scrollRef = useRef(null);
  // Autoscroll to bottom on new message — checked by length so we don't
  // fight the user when they scroll up to read history (a small UX win
  // for long conversations).
  const lastLenRef = useRef(0);
  useEffect(() => {
    if (!scrollRef.current) return;
    if (messages.length !== lastLenRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      lastLenRef.current = messages.length;
    }
  }, [messages.length]);

  if (!messages || messages.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-neutral-400 text-sm p-6">{emptyLabel || "No messages yet."}</div>;
  }

  // Group by local day for date dividers. The plan keeps it simple:
  // "Today" / "Yesterday" / full date.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const dayLabel = (d) => {
    const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
    if (dayStart.getTime() === today.getTime()) return "Today";
    if (dayStart.getTime() === yesterday.getTime()) return "Yesterday";
    return dayStart.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: dayStart.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  };
  const bubbles = [];
  let lastDay = null;
  for (const m of messages) {
    const created = new Date(m.created_at);
    const dayKey = new Date(created); dayKey.setHours(0, 0, 0, 0);
    const key = dayKey.getTime();
    if (key !== lastDay) { bubbles.push({ type: "divider", key: "d_" + key, label: dayLabel(created) }); lastDay = key; }
    bubbles.push({ type: "bubble", key: "m_" + m.id, m });
  }

  const viewerIsStaff = viewerRole !== "tenant";
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-neutral-50/50">
      {bubbles.map(b => b.type === "divider" ? (
        <div key={b.key} className="flex items-center gap-2 my-3 text-[11px] text-neutral-400 uppercase tracking-wide">
          <div className="flex-1 h-px bg-neutral-200" /><span>{b.label}</span><div className="flex-1 h-px bg-neutral-200" />
        </div>
      ) : (() => {
        const m = b.m;
        // Outgoing = bubble belongs to the viewer. Staff viewers own every
        // admin/office_assistant-role row; tenant viewers own only their
        // own tenant-role rows. Falling back to the legacy `sender` text
        // when sender_role is missing keeps old rows readable.
        const role = m.sender_role || (m.sender === "admin" ? "admin" : "tenant");
        const outgoing = viewerIsStaff ? role !== "tenant" : role === "tenant";
        // Pick a display name that matches the viewer's expectation:
        //
        // 1) Outgoing bubbles (bubbles the viewer's side owns): show
        //    the ACTUAL author from `m.sender`. Previously this used
        //    `viewerName` unconditionally, which meant an admin viewing
        //    a staff-authored message on the PM side saw their own
        //    name stamped on it (one staff "impersonating" another).
        //    Fall back to viewerName only when sender wasn't captured.
        //
        // 2) Tenant-side incoming bubbles (staff → tenant): collapse
        //    every staff author behind the property-management company
        //    name. Tenants don't care whether Harkirat or Sahil typed
        //    the message — from their POV the landlord is the company.
        //    Requires `companyName` from the caller (defaults to a
        //    generic "Property Manager" if we don't have it).
        //
        // 3) PM-side incoming bubbles (tenant → staff): show the
        //    tenant's name (either the drawer context or whoever wrote
        //    it, matching today's behavior).
        let displayName;
        if (outgoing) {
          displayName = m.sender || viewerName || "You";
        } else if (viewerRole === "tenant") {
          displayName = companyName || "Property Manager";
        } else {
          displayName = m.sender || tenantName || "Tenant";
        }
        const avatarInitial = (displayName[0] || "?").toUpperCase();
        const avatarCls = outgoing
          ? "bg-brand-700 text-white"
          : "bg-brand-100 text-brand-700";
        const created = new Date(m.created_at);
        const timeLabel = created.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const receipt = outgoing ? (m.read_at ? "✓✓ read " + new Date(m.read_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "✓ sent") : null;
        const canDelete = outgoing && typeof onDelete === "function";
        return (
          <div key={b.key} className={"group flex items-end gap-2 " + (outgoing ? "justify-end" : "justify-start")}>
            {!outgoing && (
              <div className={"w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 " + avatarCls}>{avatarInitial}</div>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={() => onDelete(m)}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full text-neutral-400 hover:text-danger-600 hover:bg-danger-50"
                title="Delete message"
                aria-label="Delete message"
              >
                <span className="material-icons-outlined text-sm">delete</span>
              </button>
            )}
            <div className={"max-w-sm rounded-2xl px-4 py-2 shadow-sm " + (outgoing ? "bg-brand-600 text-white" : "bg-white border border-neutral-200 text-neutral-800")}>
              {m.message && <div className="text-sm whitespace-pre-wrap break-words">{m.message}</div>}
              {m.attachment_url && <AttachmentChip url={m.attachment_url} name={m.attachment_name} outgoing={outgoing} />}
              <div className={"flex items-center gap-1.5 text-[11px] mt-1 " + (outgoing ? "text-brand-100" : "text-neutral-400")}>
                <span>{displayName}</span><span>·</span><span>{timeLabel}</span>
                {receipt && <><span>·</span><span>{receipt}</span></>}
              </div>
            </div>
            {outgoing && (
              <div className={"w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 " + avatarCls}>{avatarInitial}</div>
            )}
          </div>
        );
      })())}
    </div>
  );
}

// ============================================================
// AttachmentChip — resolved signed URL for a stored attachment
// ============================================================
function AttachmentChip({ url, name, outgoing }) {
  const [signed, setSigned] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getSignedUrl("documents", url).then(u => { if (!cancelled) setSigned(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [url]);
  const label = name || url.split("/").pop();
  const cls = outgoing
    ? "mt-1 inline-flex items-center gap-1.5 text-xs underline decoration-brand-200 hover:decoration-white text-brand-50"
    : "mt-1 inline-flex items-center gap-1.5 text-xs underline decoration-neutral-300 hover:decoration-brand-500 text-brand-600";
  if (!signed) return <div className={cls + " opacity-60"}><span className="material-icons-outlined text-sm">attach_file</span>{label}</div>;
  return <a href={signed} target="_blank" rel="noopener noreferrer" className={cls}><span className="material-icons-outlined text-sm">attach_file</span>{label}</a>;
}

// ============================================================
// Composer — textarea + attachment + send
// Enter sends, Shift+Enter for newline. Extracted so both panes
// (admin here, tenant in TenantPortal) can drop it in identically.
// ============================================================
export function MessageComposer({ value, onChange, onSend, placeholder, disabled, sending, attachment, onAttachmentChange, showToast }) {
  const fileRef = useRef(null);
  const [showEmoji, setShowEmoji] = useState(false);
  // Close the picker on outside-click or Escape.
  const pickerWrapRef = useRef(null);
  useEffect(() => {
    if (!showEmoji) return;
    function onDoc(e) {
      if (pickerWrapRef.current && !pickerWrapRef.current.contains(e.target)) setShowEmoji(false);
    }
    function onKey(e) { if (e.key === "Escape") setShowEmoji(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [showEmoji]);
  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!sending) onSend(); }
  }
  function handlePickFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!MSG_ATTACHMENT_EXT.test(f.name)) {
      (showToast || alert)("Attachment must be a PDF, image, document, or spreadsheet.", "error");
      e.target.value = ""; return;
    }
    if (f.size > MSG_ATTACHMENT_MAX) {
      (showToast || alert)("Attachment must be under 10MB.", "error");
      e.target.value = ""; return;
    }
    onAttachmentChange(f);
    e.target.value = "";
  }
  // Emoji insertion. Appends to the current value — we don't have a
  // forwarded ref on the Textarea primitive, so cursor-position insert
  // would need a ui.js change. Appending is the common UX anyway (users
  // typically pick an emoji after finishing the thought).
  function insertEmoji(emojiData) {
    const ch = emojiData?.emoji || "";
    if (!ch) return;
    onChange((value || "") + ch);
  }
  const canSend = !disabled && !sending && (value.trim() || attachment);
  return (
    <div className="border-t border-neutral-200 bg-white p-3 relative safe-bottom">
      {attachment && (
        <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-brand-50 text-brand-700 text-xs">
          <span className="material-icons-outlined text-sm">attach_file</span>
          <span className="flex-1 truncate">{attachment.name}</span>
          <TextLink tone="brand" size="xs" underline={false} onClick={() => onAttachmentChange(null)}  title="Remove">
            <span className="material-icons-outlined text-sm">close</span>
          </TextLink>
        </div>
      )}
      {showEmoji && (
        <div ref={pickerWrapRef} className="absolute bottom-full left-0 mb-2 z-50 shadow-xl rounded-2xl overflow-hidden">
          <Suspense fallback={<div className="bg-white border border-neutral-200 rounded-2xl px-4 py-6 text-sm text-neutral-500">Loading emoji picker…</div>}>
            <EmojiPicker onEmojiClick={insertEmoji} width={320} height={400} searchPlaceHolder="Search emojis…" previewConfig={{ showPreview: false }} skinTonesDisabled lazyLoadEmojis />
          </Suspense>
        </div>
      )}
      <div className="flex gap-2 items-end">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || sending}
          className="p-2 rounded-xl text-neutral-400 hover:text-brand-600 hover:bg-brand-50 transition-colors disabled:opacity-50"
          title="Attach file"
        >
          <span className="material-icons-outlined">attach_file</span>
        </button>
        <button
          type="button"
          onClick={() => setShowEmoji(s => !s)}
          disabled={disabled || sending}
          className={"p-2 rounded-xl transition-colors disabled:opacity-50 " + (showEmoji ? "bg-brand-50 text-brand-600" : "text-neutral-400 hover:text-brand-600 hover:bg-brand-50")}
          title="Insert emoji"
          aria-label="Insert emoji"
        >
          <span className="material-icons-outlined">mood</span>
        </button>
        <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.doc,.docx,.xls,.xlsx,.txt,.csv" className="hidden" onChange={handlePickFile} />
        <Textarea
          rows={1}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder || "Type a message…"}
          disabled={disabled}
          className="flex-1 resize-none max-h-32"
        />
        <Btn variant="primary" onClick={onSend} disabled={!canSend}>
          {sending ? "Sending…" : "Send"}
        </Btn>
      </div>
    </div>
  );
}

// Upload a chat attachment to the `documents` bucket and return the
// storage path. Keeps the upload logic near the composer so the portal
// and tenants-drawer both pick it up through `MessageComposer`/`sendChatMessage`.
export async function uploadMessageAttachment(file, companyId) {
  if (!file || !companyId) return null;
  const path = companyId + "/messages/" + shortId() + "_" + sanitizeFileName(file.name);
  const { error } = await supabase.storage.from("documents").upload(path, file, { cacheControl: "3600", upsert: false });
  if (error) { pmError("PM-7002", { raw: error, context: "message attachment upload" }); return null; }
  return path;
}

// ============================================================
// Messages — admin two-pane inbox
// Left pane: tenant conversation list with unread counts.
// Right pane: selected conversation thread + composer.
// ============================================================
function Messages({ companyId, userProfile, userRole, showToast, showConfirm }) {
  const [tenants, setTenants] = useState([]);
  const [allMsgs, setAllMsgs] = useState([]);  // last 500 per-company rollup
  const [threadMsgs, setThreadMsgs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  // Rollup — last message + unread count per tenant. We fetch the tenants
  // list once and a bounded slice of recent messages, reducing client-side
  // to avoid a per-tenant roundtrip (which would be O(N) queries for a
  // company with hundreds of tenants).
  const fetchRollup = useCallback(async () => {
    if (!companyId) return;
    try {
      const [tRes, mRes] = await Promise.all([
        supabase.from("tenants")
          .select("id,name,property,email")
          .eq("company_id", companyId)
          .is("archived_at", null)
          .order("name"),
        supabase.from("messages")
          .select("id,tenant_id,message,sender_role,sender,created_at,read_at")
          .eq("company_id", companyId)
          .not("tenant_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(500),
      ]);
      if (tRes.error) pmError("PM-8006", { raw: tRes.error, context: "Messages fetch tenants", silent: true });
      if (mRes.error) pmError("PM-8006", { raw: mRes.error, context: "Messages fetch rollup", silent: true });
      setTenants(tRes.data || []);
      setAllMsgs(mRes.data || []);
    } finally { setLoading(false); }
  }, [companyId]);

  const fetchThread = useCallback(async (tid) => {
    if (!companyId || !tid) return;
    const { data, error } = await supabase.from("messages")
      .select("*")
      .eq("company_id", companyId)
      .eq("tenant_id", tid)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) pmError("PM-8006", { raw: error, context: "Messages fetch thread", silent: true });
    setThreadMsgs(data || []);
  }, [companyId]);

  // Mark the tenant-side inbound messages as read when the staff user
  // opens the conversation. Keeps `read` boolean in sync for any legacy
  // callers that still read it.
  const markRead = useCallback(async (tid) => {
    if (!companyId || !tid) return;
    const { error } = await supabase.from("messages")
      .update({ read_at: new Date().toISOString(), read: true })
      .eq("company_id", companyId)
      .eq("tenant_id", tid)
      .is("read_at", null)
      .eq("sender_role", "tenant");
    if (error) pmError("PM-8006", { raw: error, context: "Messages mark read", silent: true });
  }, [companyId]);

  useEffect(() => { fetchRollup(); }, [fetchRollup]);

  // Poll every 15s + on window focus so the list/thread stay warm. No
  // realtime subscription — keeps the polling pattern consistent with
  // the rest of the app (see Notifications.js), and avoids the extra
  // Supabase channel overhead.
  useEffect(() => {
    const tick = () => { fetchRollup(); if (selectedId) fetchThread(selectedId); };
    const id = setInterval(tick, 15000);
    window.addEventListener("focus", tick);
    return () => { clearInterval(id); window.removeEventListener("focus", tick); };
  }, [fetchRollup, fetchThread, selectedId]);

  async function handleSelectTenant(t) {
    setSelectedId(t.id);
    await fetchThread(t.id);
    await markRead(t.id);
    // Refresh rollup so the unread badge clears immediately.
    fetchRollup();
  }

  async function handleSend() {
    const tenant = tenants.find(t => t.id === selectedId);
    if (!tenant) return;
    const body = draft.trim();
    if (!body && !attachment) return;
    if (!guardSubmit("messages:send")) return;
    setSending(true);
    try {
      // Upload attachment first — we want the path in the row, and if the
      // upload fails we bail without inserting an empty message.
      let attachmentPath = null;
      let attachmentName = null;
      if (attachment) {
        attachmentPath = await uploadMessageAttachment(attachment, companyId);
        if (!attachmentPath) {
          if (showToast) showToast("Attachment upload failed. Message not sent.", "error");
          return;
        }
        attachmentName = attachment.name;
      }

      const role = userRole === "tenant" ? "tenant" : "admin";
      const { data: inserted, error } = await supabase.from("messages").insert([{
        company_id: companyId,
        tenant_id: tenant.id,
        tenant: tenant.name,
        property: tenant.property,
        sender: userProfile?.name || role,
        sender_email: userProfile?.email || null,
        sender_role: role,
        message: body,
        attachment_url: attachmentPath,
        attachment_name: attachmentName,
        read: false,
        read_at: null,
      }]).select("id").maybeSingle();
      if (error) { pmError("PM-8006", { raw: error, context: "Messages send" }); return; }

      setDraft("");
      setAttachment(null);
      if (tenant.email) {
        await queueNotification("message_received", tenant.email, {
          sender: userProfile?.name || "Property Manager",
          preview: body ? body.slice(0, 120) : (attachmentName ? "[attachment: " + attachmentName + "]" : ""),
          tenant: tenant.name,
          property: tenant.property,
        }, companyId);
      }
      logAudit("create", "messages", "Sent message to " + tenant.name, inserted?.id, userProfile?.email, userRole, companyId);
      await Promise.all([fetchThread(tenant.id), fetchRollup()]);
    } finally {
      setSending(false);
      guardRelease("messages:send");
    }
  }

  // Soft-delete an outgoing message. Same scope rule as the send path —
  // only the viewer's own bubbles expose the delete affordance, so this
  // never touches the other party's rows.
  async function handleDelete(m) {
    if (!m?.id) return;
    if (!await showConfirm({ message: "Delete this message? The tenant will no longer see it.", variant: "danger", confirmText: "Delete" })) return;
    const { error } = await supabase.from("messages").delete().eq("id", m.id).eq("company_id", companyId);
    if (error) { pmError("PM-8006", { raw: error, context: "Messages delete" }); return; }
    logAudit("delete", "messages", "Deleted message " + m.id, m.id, userProfile?.email, userRole, companyId);
    if (selectedId) fetchThread(selectedId);
    fetchRollup();
  }

  // Build the conversation list: reduce allMsgs to {lastMsg, unread} per
  // tenant, then sort by lastMsg.created_at DESC with tenants who've
  // never messaged falling to the bottom alphabetically.
  const convoByTenant = {};
  for (const m of allMsgs) {
    const tid = m.tenant_id;
    if (!tid) continue;
    if (!convoByTenant[tid]) convoByTenant[tid] = { lastMsg: m, unread: 0 };
    // allMsgs is DESC-ordered so the first one we see IS the latest.
    if (m.sender_role === "tenant" && !m.read_at) convoByTenant[tid].unread += 1;
  }
  const q = search.trim().toLowerCase();
  const convoList = tenants
    .filter(t => !q || (t.name || "").toLowerCase().includes(q) || (t.property || "").toLowerCase().includes(q))
    .map(t => ({ tenant: t, ...(convoByTenant[t.id] || { lastMsg: null, unread: 0 }) }))
    .sort((a, b) => {
      const aTime = a.lastMsg ? new Date(a.lastMsg.created_at).getTime() : 0;
      const bTime = b.lastMsg ? new Date(b.lastMsg.created_at).getTime() : 0;
      if (aTime !== bTime) return bTime - aTime;
      return (a.tenant.name || "").localeCompare(b.tenant.name || "");
    });

  const selectedTenant = tenants.find(t => t.id === selectedId) || null;
  const viewerName = userProfile?.name || "You";

  if (loading) return <Spinner />;

  // Mobile iMessage behavior: one pane at a time. On list view, tapping
  // a tenant switches to thread view. A back button in the thread header
  // returns to the list. Desktop keeps the two-pane layout unchanged.
  const showListOnMobile = !selectedTenant;
  const showThreadOnMobile = !!selectedTenant;

  return (
    <div>
      {/* Desktop-only page header — on mobile the thread/list has its own
          compact header so we can fit the composer in-viewport. */}
      <div className="hidden md:block">
        <PageHeader title="Messages" subtitle="Chat with your tenants." />
      </div>
      <div
        className="bg-white md:rounded-3xl md:shadow-card md:border md:border-brand-50 overflow-hidden flex flex-col md:flex-row h-[calc(100dvh-120px-env(safe-area-inset-bottom,0px))] md:h-[calc(100dvh-180px)]"
        style={{ minHeight: "320px" }}
      >
        {/* LEFT PANE — conversation list. Full-width on mobile when no
            thread is active; hidden once a thread is open. Fixed 320px
            on desktop. */}
        <div className={`${showListOnMobile ? "flex" : "hidden"} md:flex w-full md:w-80 border-r-0 md:border-r border-neutral-200 flex-col`}>
          <div className="p-3 border-b border-neutral-200 bg-white">
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tenants…" size="sm" />
          </div>
          <div className="flex-1 overflow-y-auto">
            {convoList.length === 0 && (
              <div className="text-center p-6 text-sm text-neutral-400">No tenants match.</div>
            )}
            {convoList.map(({ tenant, lastMsg, unread }) => {
              const isActive = tenant.id === selectedId;
              const preview = lastMsg?.message ? lastMsg.message.slice(0, 60) + (lastMsg.message.length > 60 ? "…" : "") : "No messages yet";
              const when = lastMsg ? relativeWhen(lastMsg.created_at) : "";
              return (
                <button key={tenant.id} onClick={() => handleSelectTenant(tenant)}
                  className={"w-full text-left px-4 py-3 border-b border-neutral-100 flex items-start gap-3 transition-colors " + (isActive ? "bg-brand-50" : "hover:bg-neutral-50")}>
                  <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-sm font-bold shrink-0">{(tenant.name || "?")[0]?.toUpperCase()}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-neutral-800 truncate">{tenant.name || "Unknown"}</div>
                      <div className="text-[11px] text-neutral-400 shrink-0">{when}</div>
                    </div>
                    <div className="text-xs text-neutral-500 truncate mt-0.5">{preview}</div>
                    <div className="text-[11px] text-neutral-400 truncate">{tenant.property || ""}</div>
                  </div>
                  {unread > 0 && <div className="w-5 h-5 rounded-full bg-danger-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">{unread > 9 ? "9+" : unread}</div>}
                </button>
              );
            })}
          </div>
        </div>

        {/* RIGHT PANE — thread + composer. On mobile, takes over the full
            viewport width when a tenant is selected; otherwise hidden. On
            desktop, always visible on the right. */}
        <div className={`${showThreadOnMobile ? "flex" : "hidden"} md:flex flex-1 flex-col min-w-0`}>
          {!selectedTenant ? (
            <div className="flex-1 items-center justify-center text-neutral-400 text-sm hidden md:flex">Pick a tenant on the left to see the conversation.</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-neutral-200 bg-white flex items-center gap-3">
                {/* Back button — mobile-only. Clears selection so the
                    list view comes back. */}
                <button
                  onClick={() => setSelectedId(null)}
                  className="md:hidden -ml-1 p-1 rounded-lg text-brand-600 hover:bg-brand-50 shrink-0"
                  aria-label="Back to conversations"
                >
                  <span className="material-icons-outlined">arrow_back</span>
                </button>
                <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-sm font-bold shrink-0 md:hidden">
                  {(selectedTenant.name || "?")[0]?.toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-neutral-800 truncate">{selectedTenant.name}</div>
                  <div className="text-xs text-neutral-500 truncate">{selectedTenant.property}{selectedTenant.email ? " · " + selectedTenant.email : ""}</div>
                </div>
              </div>
              <MessageThread
                messages={threadMsgs}
                viewerRole={userRole}
                viewerName={viewerName}
                tenantName={selectedTenant.name}
                onDelete={handleDelete}
                emptyLabel={"No messages yet. Say hi to " + selectedTenant.name + "."}
              />
              <MessageComposer
                value={draft}
                onChange={setDraft}
                onSend={handleSend}
                sending={sending}
                placeholder={"Message " + selectedTenant.name + "…"}
                attachment={attachment}
                onAttachmentChange={setAttachment}
                showToast={showToast}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Short relative label — "2m", "3h", "Mon", "Apr 18". Not trying to be
// perfect; admin conversation list just needs a quick at-a-glance age.
function relativeWhen(ts) {
  if (!ts) return "";
  const now = Date.now();
  const t = new Date(ts).getTime();
  const diffMs = now - t;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "now";
  if (min < 60) return min + "m";
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + "h";
  const days = Math.floor(hrs / 24);
  if (days < 7) {
    return new Date(ts).toLocaleDateString(undefined, { weekday: "short" });
  }
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export { Messages };
export default Messages;
