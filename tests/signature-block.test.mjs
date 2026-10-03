// The signature block and the signature stamp: adversarial checks on the
// rules (src/utils/signatureBlock.js, signatureStamp.js, docService's
// witness roles) and on the wiring that carries a slot from the template
// to the stored PDF.
import fs from "fs";
import { createRequire } from "module";
import { SIGNATURE_BLOCK_TOKEN, hasSignatureBlock, signerHeading, signatureRows, signatureBlockHtml, expandSignatureBlock, slotsIn } from "../src/utils/signatureBlock.js";
import { stampSignatures, signatureText, signedDateText, validAnchors } from "../src/utils/signatureStamp.js";
import { effectiveSignerRoles, signerDefaultFor, isWitnessRole, witnessedRole } from "../src/utils/signerRoles.js";
const require = createRequire(import.meta.url);
const PDFLib = require("../node_modules/pdf-lib");
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok = (name, c, extra = "") => { if (c) pass++; else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); } };

// ── token ───────────────────────────────────────────────────────────
ok("token detected, with or without spaces", hasSignatureBlock("<p>{{signature_block}}</p>") && hasSignatureBlock("{{ signature_block }}") && !hasSignatureBlock("{{signature}}") && !hasSignatureBlock(""));
ok("detection is stateless (a global regex that leaks lastIndex would flip)", hasSignatureBlock(SIGNATURE_BLOCK_TOKEN) && hasSignatureBlock(SIGNATURE_BLOCK_TOKEN) && hasSignatureBlock(SIGNATURE_BLOCK_TOKEN));

// ── rows ────────────────────────────────────────────────────────────
const roles = [
  { role: "tenant", label: "Tenant", order: 1, required: true },
  { role: "tenant_2", label: "Co-tenant 2", order: 1, required: false },
  { role: "tenant_3", label: "Co-tenant 3", order: 1, required: false },
  { role: "landlord", label: "Landlord", order: 2, required: true },
];
{
  const rows = signatureRows(roles, { tenant: "A", landlord: "L" });
  // The block follows Sigma's paper lease: the landlord's row first, then
  // the tenants (whatever the signing order).
  ok("unnamed optional slots are dropped; required ones kept", rows.map(r => r.role).join() === "landlord,tenant");
  const rows2 = signatureRows(roles, { tenant: "A", tenant_2: "B", landlord: "L" });
  ok("a named co-tenant gets a row: landlord first, then the tenants in signing order", rows2.map(r => r.role).join() === "landlord,tenant,tenant_2");
  ok("rows keep the printed name", rows2[2].name === "B");
  const kept = signatureRows(roles, {}, { dropUnnamedOptional: false });
  ok("a template preview can keep every slot", kept.length === 4);
  const unordered = signatureRows([{ role: "landlord", order: 2, required: true }, { role: "tenant", order: 1, required: true }], {});
  ok("rows sort landlord first, then by signing step, not by array position", unordered.map(r => r.role).join() === "landlord,tenant");
  ok("heading is the label, upper-cased, with a colon", signerHeading({ label: "Co-tenant 2" }) === "CO-TENANT 2:" && signerHeading({ role: "landlord" }) === "LANDLORD:");
}

// ── more adults than slots, and witnesses ───────────────────────────
{
  const eff = effectiveSignerRoles(roles, 5);
  ok("five adults -> two extra tenant rows", eff.filter(r => /^tenant/.test(r.role)).length === 5);
  const w = effectiveSignerRoles(roles, 1, { witnesses: true });
  ok("witnesses: one witness role after every signer, same step, optional", w.length === 8 && w[1].role === "witness_tenant" && w[1].order === 1 && w[1].required === false && w[7].role === "witness_landlord");
  ok("witness roles already present are not doubled", effectiveSignerRoles(w, 1, { witnesses: true }).length === 8);
  ok("a witness role is never counted as a tenant", effectiveSignerRoles([{ role: "witness_tenant", order: 1 }, { role: "tenant", order: 1 }], 2).filter(r => r.role.startsWith("tenant")).length === 2);
  ok("witness helpers", isWitnessRole("witness_tenant_2") && witnessedRole("witness_tenant_2") === "tenant_2" && !isWitnessRole("tenant"));
  const ctx = { signers: { tenants: [{ name: "T", email: "t@x.com" }], landlord: { name: "L", email: "l@x.com" } } };
  ok("a witness is never prefilled from the tenancy", signerDefaultFor("witness_tenant", ctx).name === "" && signerDefaultFor("witness_landlord", ctx).email === "");
  const rows = signatureRows(w, { tenant: "A", witness_tenant: "W", landlord: "L" });
  ok("witness rides on its signer's row, not a row of its own", rows.length === 2 && rows[1].witness.role === "witness_tenant" && rows[1].witness.name === "W" && rows[0].witness.role === "witness_landlord" && rows[0].witness.name === "");
}

// ── html ────────────────────────────────────────────────────────────
{
  const rows = signatureRows(effectiveSignerRoles(roles, 2, { witnesses: true }), { tenant: "Jane <b>Doe</b>", tenant_2: "Bob", witness_tenant: "W" });
  const html = signatureBlockHtml(rows);
  ok("one table row per signer", (html.match(/<tr>/g) || []).length === 3);
  ok("names are escaped", html.includes("Jane &lt;b&gt;Doe&lt;/b&gt;") && !html.includes("<b>Doe"));
  ok("every signer has a sign slot, landlord row first", slotsIn(html).filter(s => s.kind === "sign").map(s => s.role).join() === "witness_landlord,landlord,witness_tenant,tenant,witness_tenant_2,tenant_2");
  ok("no date slots: the paper lease has no date line (the date is in the tag and on the certificate)", slotsIn(html).filter(s => s.kind === "date").length === 0 && !/Date:/.test(html));
  ok("the right column reads heading, line + (SEAL), Print Name, as the paper lease does", /<p data-keep-next="1">LANDLORD:<\/p><p data-keep-next="1">&nbsp;<\/p><p data-keep-next="1"><span data-sig-role="landlord">_+<\/span> \(SEAL\)<\/p><p>Print Name: /.test(html));
  ok("(SEAL) follows the signature line", /data-sig-role="tenant">_+<\/span> \(SEAL\)/.test(html));
  ok("a named witness gets slots; an unnamed one still a printed line", html.includes('data-sig-role="witness_tenant_2"') && /Print Name: W</.test(html));
  ok("the table is borderless", html.includes('data-borders="none"'));
  ok("the witness column can be dropped", !signatureBlockHtml(rows, { witness: false }).includes("WITNESS"));
  ok("no rows -> nothing", signatureBlockHtml([]) === "" && expandSignatureBlock("<p>{{signature_block}}</p>", []) === "<p></p>");
  ok("the role name is escaped in the attribute", !signatureBlockHtml([{ role: 'x" onload="1', label: "X", name: "", required: true }]).includes('onload="1'));
}

// ── wiring: the slot survives every pass ────────────────────────────
{
  const docs = read("src/components/Documents.js");
  ok("the office sanitizer allow-lists the editor's data attributes", /ADD_ATTR: DOC_DATA_ATTRS/.test(docs) && ["data-page-break", "data-keep-next", "data-list-style", "data-bullet", "data-borders", "data-sig-role", "data-sig-date"].every(a => docs.includes(`"${a}"`)));
  ok("the merge expands the block before fields", /expandSignatureBlock\(body, signatureRows\(signerRoles, printedNames\)\)/.test(docs));
  const kit = read("src/utils/docKit.js");
  ok("the editor schema has the slot node, parsed from both attributes", /name: "signatureSlot"/.test(kit) && kit.includes('tag: "span[data-sig-role]"') && kit.includes('tag: "span[data-sig-date]"') && /SignatureSlot,\n/.test(kit));
  const pdf = read("src/utils/pagedPdf.js");
  ok("the renderer reports anchors for both slot kinds", /span\[data-sig-role\], span\[data-sig-date\]/.test(pdf) && /export async function renderPagedPdfWithAnchors/.test(pdf));
  ok("transparent cell borders are not drawn", /transparent\/\.test\(cs\.borderTopColor\)\) return;/.test(pdf));
  const api = read("api/_finalize-impl.js");
  ok("the finalize module stamps signatures (every signed row) before initials and the hash", api.indexOf("stampSignatures(") < api.indexOf("stampInitials(") && api.indexOf("stampInitials(") < api.indexOf('createHash("sha256").update(pdfBytes)') && /anchors/.test(api));
  const route = read("api/finalize-signed-pdf.js");
  ok("the finalize route takes the browser's anchors and hands them to the module", /sig_anchors/.test(route) && /finalizeFromBytes\(sb, req, doc, \{ pdfBytes, bodyPages: body_pages, anchors: sig_anchors \}\)/.test(route));
  // 2026-10-03: the last signature finishes the envelope on the server, from
  // the pages stored at send (a closed tab used to leave no signed copy).
  const signApi = read("api/_sign-document-impl.js");
  ok("the sign call finishes the envelope on the server when the last signature lands", /data\.all_signed && data\.doc_id/.test(signApi) && /finalizeFromStoredBody\(sb, req, doc\)/.test(signApi) && /server_finalized: true/.test(signApi));
  ok("the stored body carries its signature-line positions inside the PDF (the bucket is PDF-only)", /setSubject\(SUBJECT_MARK \+ JSON\.stringify\(meta\)\)/.test(api) && /getSubject\(\)/.test(api));
  ok("the builder stores the pages when the envelope is sent, before the emails go", docs.indexOf("await storeBodyForEnvelope(doc)") > docs.indexOf('supabase.rpc("create_doc_envelope"') && docs.indexOf("await storeBodyForEnvelope(doc)") < docs.indexOf("sendSignatureRequests(companyId, doc.id)"));
  ok("the staff repair path asks the server first and renders in the browser only for older envelopes", /finalizeOnServer\(companyId, d\.id\)/.test(docs) && /r\.status === 404/.test(docs));
  ok("Finalize (save as final) is not offered in the e-sign flow", /\{!esign && <Btn onClick=\{async \(\) => \{ await saveDocument\("final"\)/.test(docs));
  const sign = read("src/components/PublicSignPage.js");
  ok("the signing page sends the anchors", /sig_anchors: sigAnchors/.test(sign) && /renderPagedPdfWithAnchors/.test(sign));
  ok("the signing page takes the server's copy and renders one itself only for older envelopes", /if \(data\.signed_pdf_path\) setPdfStatus\("stored"\);\s*else renderAndUploadSignedPdf/.test(sign));
  ok("the done screen does not say 'safely close' while a copy is still being made", /\{pdfStatus !== "uploading" && <p[^>]*>You can safely close this window\.<\/p>\}/.test(sign) && /keep this window open/.test(sign));
  ok("Finish is locked until every tab is done", /disabled=\{!allDone \|\| submitting\}/.test(sign) && /initialsDone === initialSlots\.length/.test(sign));
  ok("initials record the page count", /\|pages:" \+ initialSlots\.length/.test(sign));
  const server = read("api/_signature-stamp.js"), client = read("src/utils/signatureStamp.js");
  const strip = (t) => t.replace(/^\/\/.*$/gm, "").replace(/^export /gm, "").replace(/module\.exports.*$/m, "").replace(/\s+/g, " ").trim();
  ok("server and browser stamps are the same code", strip(server) === strip(client));
}

// ── stamp ───────────────────────────────────────────────────────────
ok("typed signature text", signatureText("typed:Jane Doe|ts:2026-10-03T00:00:00Z") === "Jane Doe" && signatureText("data:image/png;base64,AAAA") === null && signatureText("") === null);
ok("date text", signedDateText("2026-10-03T07:10:08.278Z").length === 10 && signedDateText("junk") === "" && signedDateText(null) === "");
ok("anchors are validated", validAnchors([{ kind: "sign", role: "t", page: 0, x: 1, y: 2, w: 3, h: 4 }, { kind: "sign", role: "t", page: 9, x: 1, y: 2, w: 3, h: 4 }, { kind: "nope", role: "t", page: 0, x: 1, y: 2, w: 3, h: 4 }, { kind: "sign", role: "t", page: 0, x: NaN, y: 2, w: 3, h: 4 }, null, "x"], 3).length === 1);
ok("anchor list is capped", validAnchors(Array.from({ length: 500 }, () => ({ kind: "sign", role: "t", page: 0, x: 1, y: 2, w: 3, h: 4 }))).length === 200);
{
  const { PDFDocument } = PDFLib;
  const base = await PDFDocument.create(); base.addPage([612, 792]); base.addPage([612, 792]);
  const bytes = await base.save();
  const anchors = [{ kind: "sign", role: "tenant", page: 1, x: 100, y: 500, w: 200, h: 18 }, { kind: "date", role: "tenant", page: 1, x: 100, y: 540, w: 90, h: 18 }, { kind: "sign", role: "landlord", page: 1, x: 100, y: 600, w: 200, h: 18 }];
  const signers = [{ signer_role: "tenant", signature_data: "typed:Jane Trial|ts:x", signed_at: "2026-10-03T12:00:00Z", status: "signed" }, { signer_role: "landlord", signature_data: "typed:L|ts:x", signed_at: "2026-10-03T12:00:00Z", status: "sent" }];
  const out = await stampSignatures(PDFLib, bytes, signers, anchors);
  ok("stamp returns a PDF", Buffer.from(out.slice(0, 4)).toString() === "%PDF");
  const pdf = await PDFDocument.load(out);
  const p1 = pdf.getPages()[1].node.Contents();
  ok("stamps go on the anchored page only", !!p1 && !pdf.getPages()[0].node.Contents());
  ok("unsigned rows are not stamped (landlord still 'sent')", (await stampSignatures(PDFLib, bytes, signers.filter(s => s.signer_role === "landlord"), anchors)) === bytes);
  ok("nothing to draw -> the same bytes back", (await stampSignatures(PDFLib, bytes, [], anchors)) === bytes && (await stampSignatures(PDFLib, bytes, signers, [])) === bytes);
  const bad = await stampSignatures(PDFLib, bytes, [{ signer_role: "tenant", signature_data: "data:image/png;base64,not-a-png", signed_at: "2026-10-03", status: "signed" }], anchors);
  ok("a broken image is skipped, not thrown", Buffer.from(bad.slice(0, 4)).toString() === "%PDF");
}

// ── initials lines: landlord left, tenants right, no witness ─────────
{
  const { initialsBoxRect, INITIALS_BOX } = await import("../src/utils/initialsStamp.js");
  const { initialsRoster } = await import("../src/utils/signatureStamp.js");
  const roster = initialsRoster('<span data-sig-role="witness_landlord"></span><span data-sig-role="landlord"></span><span data-sig-role="witness_tenant"></span><span data-sig-role="tenant"></span><span data-sig-role="tenant_2"></span>');
  ok("the roster has no witness: they sign once, on the last page", roster.map(r => r.role).join() === "landlord,tenant,tenant_2");
  const L = initialsBoxRect(0, 612, roster), T = initialsBoxRect(1, 612, roster), T2 = initialsBoxRect(2, 612, roster);
  ok("the landlord's line is at the left margin", L.x === INITIALS_BOX.left);
  ok("the tenant's line is at the right margin", T.x + T.width === 612 - INITIALS_BOX.right);
  ok("a second tenant's line sits inside the first's", T2.x + T2.width < T.x && T2.x > L.x + L.width);
  const api = read("api/_initials-stamp.js"), web = read("src/utils/initialsStamp.js");
  const strip2 = (t) => t.replace(/^\/\/.*$/gm, "").replace(/^export /gm, "").replace(/module\.exports.*$/m, "").replace(/\s+/g, " ").trim();
  ok("server and browser initials stamps are the same code", strip2(api) === strip2(web));
}

console.log(`signature-block: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
