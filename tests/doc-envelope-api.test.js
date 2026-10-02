// End-to-end tests for the document e-sign pipeline against the TEST
// database: create_doc_envelope / sign_document (the database half) and
// /api/notifications?action=doc + /api/finalize-signed-pdf (the server half),
// driven in-process with a real staff login and real signer tokens.
//
// Emails are never sent here: DOC_EMAIL_TRANSPORT=log makes every send a
// 'suppressed' row in doc_email_log, which is what the assertions read.
//
// What this guards (each was broken before 2026-10-02):
//   - two signers at one step: the next step must wait for BOTH
//   - the next signer is emailed, by the server, exactly once
//   - a request can be re-sent (it used to hit a foreign-key error)
//   - an envelope can be cancelled, and a cancelled link stops working
//   - a lease's signature_status follows the envelope
//   - the signed PDF is stored, filed under Documents, and copies are sent
//   - a staff member can store the signed PDF when the signer's browser did not
//   - a tenant-role member cannot read signing links
require("./sandbox-env");   // must precede any use of process.env.SUPABASE_*
const { createClient } = require("@supabase/supabase-js");

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;
const ANON = process.env.TEST_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
process.env.DOC_EMAIL_TRANSPORT = "log";
process.env.DOC_EMAIL_ALLOWLIST = "owner-allowlisted@example.com";
process.env.APP_URL = "https://test.example";
delete process.env.VERCEL_ENV;

const docImpl = require("../api/_doc-email-impl");
const finalize = require("../api/finalize-signed-pdf");

const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
const COMPANY = "sandbox-llc";
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) passed++; else { failed++; console.log("❌ " + name + (extra ? "\n     " + extra : "")); } };

function call(handler, { body, token, query = {} }) {
  return new Promise((resolve) => {
    const req = { method: "POST", headers: token ? { authorization: "Bearer " + token, origin: "https://test.example" } : { origin: "https://test.example" }, body, query };
    const res = {
      _status: 200, setHeader() {}, status(c) { this._status = c; return this; },
      json(o) { resolve({ status: this._status, body: o }); }, end() { resolve({ status: this._status, body: null }); },
    };
    Promise.resolve(handler(req, res)).catch(e => resolve({ status: 599, body: { error: String(e && e.message) } }));
  });
}
const sign = (anon, token, name) => anon.rpc("sign_document", {
  p_token: token, p_signer_name: name, p_signature_data: "typed:" + name + "|ts:" + new Date().toISOString(),
  p_signing_method: "type", p_consent_text: "I agree to sign this document electronically.", p_user_agent: "test",
  p_e_records_consented: true, p_hw_sw_acknowledged: true, p_consent_version: "test-v1",
});
// The smallest thing that passes the "%PDF" check.
const fakePdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(400, 32), Buffer.from("\n%%EOF")]);

(async () => {
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: login, error: loginErr } = await anon.auth.signInWithPassword({ email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD });
  if (loginErr || !login.session) { console.log("❌ could not log in the sandbox staff user: " + (loginErr && loginErr.message)); process.exit(1); }
  const jwt = login.session.access_token;
  const staff = createClient(URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + jwt } } });
  const signerClient = createClient(URL, ANON, { auth: { persistSession: false } });

  const { data: lease } = await svc.from("leases").select("id, signature_status, tenant_id, tenant_name, property, property_id").eq("company_id", COMPANY).eq("status", "active").limit(1).maybeSingle();
  ok("sandbox has an active lease to hang the document on", !!lease);
  const leaseStatusBefore = lease && lease.signature_status;
  const created = [];
  const mkDoc = async (extra = {}) => {
    const { data, error } = await svc.from("doc_generated").insert([{
      company_id: COMPANY, name: "Envelope API test " + Date.now() + Math.random().toString(36).slice(2, 6),
      rendered_body: "<p>Test lease body</p>", field_values: {}, status: "sent", created_by: process.env.TEST_EMAIL, ...extra,
    }]).select().single();
    if (error) throw new Error("seed doc: " + error.message);
    created.push(data.id);
    return data;
  };
  const sigsOf = async (docId) => (await svc.from("doc_signatures").select("*").eq("doc_id", docId).order("sign_order").order("created_at")).data || [];
  const logOf = async (docId) => (await svc.from("doc_email_log").select("*").eq("doc_id", docId).order("created_at")).data || [];

  try {
    // ── A. three signers, two steps ────────────────────────────────────
    const doc = await mkDoc({ lease_id: lease.id, doc_kind: "lease", tenant_id: lease.tenant_id, tenant_name: lease.tenant_name, property_address: lease.property, property_id: lease.property_id });
    const signers = [
      { role: "tenant", name: "Ann Tenant", email: "ann@example.com", order: 1 },
      { role: "tenant_2", name: "Bob Tenant", email: "bob@example.com", order: 1 },
      { role: "landlord", name: "Lee Landlord", email: "owner-allowlisted@example.com", order: 2 },
    ];
    const { error: envErr } = await staff.rpc("create_doc_envelope", { p_doc_id: doc.id, p_signers: signers, p_signing_mode: "sequential" });
    ok("staff can create an envelope", !envErr, envErr && envErr.message);
    let sigs = await sigsOf(doc.id);
    const by = (role) => sigs.find(s => s.signer_role === role && s.status !== "voided");
    ok("both tenants are asked first, landlord waits", by("tenant")?.status === "sent" && by("tenant_2")?.status === "sent" && by("landlord")?.status === "pending", sigs.map(s => s.signer_role + "=" + s.status).join(","));
    ok("lease shows pending", (await svc.from("leases").select("signature_status").eq("id", lease.id).single()).data.signature_status === "pending");

    let r = await call(docImpl, { body: { op: "send-requests", company_id: COMPANY, doc_id: doc.id }, token: jwt });
    ok("send-requests answers 200", r.status === 200, JSON.stringify(r.body));
    ok("only the two tenants are emailed", r.body.results?.length === 2 && r.body.results.every(x => /^(ann|bob)@/.test(x.email)), JSON.stringify(r.body.results));
    let log = await logOf(doc.id);
    ok("each request is logged with intended and actual recipient", log.length === 2 && log.every(l => l.kind === "sign_request" && l.status === "suppressed" && l.to_email === "owner-allowlisted@example.com" && /@example\.com$/.test(l.intended_email)), JSON.stringify(log.map(l => [l.kind, l.status, l.to_email, l.intended_email])));
    ok("a tenant's mail is redirected on a non-production site, and says so", log.every(l => l.subject.startsWith("[TEST, meant for ")));

    r = await call(docImpl, { body: { op: "send-requests", company_id: COMPANY, doc_id: doc.id }, token: null });
    ok("send-requests refuses a caller with no login", r.status === 401);
    r = await call(docImpl, { body: { op: "send-requests", company_id: "some-other-company", doc_id: doc.id }, token: jwt });
    ok("send-requests refuses a company the caller is not in", r.status === 403 || r.status === 404, String(r.status));

    // Ann signs: Bob is still out, so the landlord must NOT be asked yet.
    let s1 = await sign(signerClient, by("tenant").access_token, "Ann Tenant");
    ok("first tenant signs", s1.data?.success === true, JSON.stringify(s1.data || s1.error));
    ok("landlord is not promoted while a tenant is outstanding", s1.data?.next_signers_count === 0 && s1.data?.all_signed === false);
    r = await call(docImpl, { body: { op: "next-signers", token: by("tenant").access_token } });
    ok("next-signers after the first tenant asks nobody new", r.status === 200 && r.body.asked === 0, JSON.stringify(r.body));
    ok("lease shows partially signed", (await svc.from("leases").select("signature_status").eq("id", lease.id).single()).data.signature_status === "partially_signed");

    // A signer's token must not be usable as a staff credential.
    r = await call(docImpl, { body: { op: "next-signers", token: by("tenant_2").access_token } });
    ok("next-signers refuses a token that has not signed", r.status === 403);

    // Resend to Bob: used to be impossible.
    sigs = await sigsOf(doc.id);
    const bob = by("tenant_2");
    r = await call(docImpl, { body: { op: "resend", company_id: COMPANY, signature_id: bob.id }, token: jwt });
    ok("a request can be re-sent", r.status === 200, JSON.stringify(r.body));
    const bobAfter = (await svc.from("doc_signatures").select("access_token, token_expires_at, status").eq("id", bob.id).single()).data;
    ok("re-sending keeps the same link and extends it", bobAfter.access_token === bob.access_token && new Date(bobAfter.token_expires_at) >= new Date(bob.token_expires_at));
    r = await call(docImpl, { body: { op: "resend", company_id: COMPANY, signature_id: by("landlord").id }, token: jwt });
    ok("cannot remind someone whose turn has not come", r.status === 409, JSON.stringify(r.body));

    let s2 = await sign(signerClient, bob.access_token, "Bob Tenant");
    ok("second tenant signs and the landlord is promoted", s2.data?.success === true && s2.data?.next_signers_count === 1 && s2.data?.next_signer_email === "owner-allowlisted@example.com", JSON.stringify(s2.data || s2.error));
    r = await call(docImpl, { body: { op: "next-signers", token: bob.access_token } });
    ok("the landlord is emailed by the server", r.status === 200 && r.body.asked === 1, JSON.stringify(r.body));
    ok("the signer is not told who is next", r.body.results === undefined && !JSON.stringify(r.body).includes("@"));
    r = await call(docImpl, { body: { op: "next-signers", token: bob.access_token } });
    log = await logOf(doc.id);
    ok("asking twice does not email the landlord twice", r.body.asked === 0 && log.filter(l => l.intended_email === "owner-allowlisted@example.com" && l.kind === "sign_request").length === 1, JSON.stringify(r.body));
    ok("landlord's own address is on the allowlist, so not redirected", log.some(l => l.intended_email === "owner-allowlisted@example.com" && !l.subject.startsWith("[TEST")));

    // Finalize with the WRONG signer's token must fail; envelope not complete yet either.
    r = await call(finalize, { body: { token: bob.access_token, doc_id: doc.id, pdf_base64: fakePdf.toString("base64") } });
    ok("no signed copy can be stored before everyone has signed", r.status === 403, JSON.stringify(r.body));

    sigs = await sigsOf(doc.id);
    const s3 = await sign(signerClient, by("landlord").access_token, "Lee Landlord");
    ok("landlord signs and the envelope completes", s3.data?.all_signed === true, JSON.stringify(s3.data || s3.error));
    ok("lease shows fully signed", (await svc.from("leases").select("signature_status").eq("id", lease.id).single()).data.signature_status === "fully_signed");

    r = await call(finalize, { body: { token: bob.access_token, doc_id: doc.id, pdf_base64: fakePdf.toString("base64") } });
    ok("only the signer who completed the envelope may store the copy", r.status === 403, JSON.stringify(r.body));
    r = await call(finalize, { body: { token: by("landlord").access_token, doc_id: doc.id, pdf_base64: Buffer.from("not a pdf at all, just words".repeat(20)).toString("base64") } });
    ok("a non-PDF is refused", r.status === 400, JSON.stringify(r.body));
    r = await call(finalize, { body: { token: by("landlord").access_token, doc_id: doc.id, pdf_base64: fakePdf.toString("base64") } });
    ok("the signed copy is stored", r.status === 200 && !!r.body.signed_pdf_path, JSON.stringify(r.body));
    const docAfter = (await svc.from("doc_generated").select("signed_pdf_path, signed_pdf_hash, filed_document_id").eq("id", doc.id).single()).data;
    ok("path and fingerprint are recorded", !!docAfter.signed_pdf_path && /^[0-9a-f]{64}$/.test(docAfter.signed_pdf_hash || ""));
    ok("it is filed under Documents", !!docAfter.filed_document_id);
    if (docAfter.filed_document_id) {
      const filed = (await svc.from("documents").select("*").eq("id", docAfter.filed_document_id).single()).data;
      ok("the filed document is linked to the tenant and property by id", filed.tenant_id === lease.tenant_id && filed.property_id === lease.property_id && filed.tenant_visible === true && filed.type === "Lease", JSON.stringify({ t: filed.tenant_id, p: filed.property_id, type: filed.type }));
      const dl = await svc.storage.from("documents").download(filed.url);
      ok("the filed PDF is really in the documents bucket", !dl.error && dl.data && dl.data.size === fakePdf.length);
      await svc.storage.from("documents").remove([filed.url]);
      await svc.from("documents").delete().eq("id", filed.id);
    }
    log = await logOf(doc.id);
    ok("every signer is sent a copy", log.filter(l => l.kind === "signed_copy").length === 3, JSON.stringify(log.map(l => l.kind)));
    r = await call(finalize, { body: { token: by("landlord").access_token, doc_id: doc.id, pdf_base64: fakePdf.toString("base64") } });
    ok("storing twice is harmless and sends nothing more", r.status === 200 && r.body.already_set === true && (await logOf(doc.id)).filter(l => l.kind === "signed_copy").length === 3);
    await svc.storage.from("signed-documents").remove([docAfter.signed_pdf_path]);
    const again = await sign(signerClient, by("tenant").access_token, "Ann Again");
    ok("a used link cannot sign again", !!again.data?.error);

    // ── B. cancel ───────────────────────────────────────────────────────
    const doc2 = await mkDoc();
    await staff.rpc("create_doc_envelope", { p_doc_id: doc2.id, p_signers: [{ role: "tenant", name: "Cy", email: "cy@example.com", order: 1 }] });
    const cy = (await sigsOf(doc2.id))[0];
    r = await call(docImpl, { body: { op: "void", company_id: COMPANY, doc_id: doc2.id, reason: "sent to the wrong person" }, token: jwt });
    ok("an envelope can be cancelled", r.status === 200 && r.body.voided === true, JSON.stringify(r.body));
    const d2 = (await svc.from("doc_generated").select("envelope_status, void_reason, voided_by").eq("id", doc2.id).single()).data;
    ok("the cancellation records who and why", d2.envelope_status === "voided" && d2.void_reason === "sent to the wrong person" && !!d2.voided_by);
    const opened = await signerClient.rpc("get_signature_by_token", { p_token: cy.access_token });
    ok("a cancelled link no longer opens the document", !!opened.data?.error && !opened.data?.doc_body, JSON.stringify(opened.data));
    const signedVoid = await sign(signerClient, cy.access_token, "Cy");
    ok("a cancelled link cannot sign", !!signedVoid.data?.error);
    const resend2 = await staff.rpc("create_doc_envelope", { p_doc_id: doc2.id, p_signers: [{ role: "tenant", name: "Cy", email: "cy.right@example.com", order: 1 }] });
    ok("a cancelled document can be sent again", !resend2.error, resend2.error && resend2.error.message);
    const cy2 = (await sigsOf(doc2.id)).filter(s => s.status === "sent");
    ok("the new request has a new link", cy2.length === 1 && cy2[0].access_token !== cy.access_token);

    // ── C. the signer's browser never uploaded: staff stores the copy ───
    await sign(signerClient, cy2[0].access_token, "Cy Right");
    r = await call(finalize, { body: { company_id: COMPANY, doc_id: doc2.id, pdf_base64: fakePdf.toString("base64") }, token: jwt });
    ok("staff can store the signed copy afterwards", r.status === 200 && !!r.body.signed_pdf_path, JSON.stringify(r.body));
    r = await call(finalize, { body: { company_id: COMPANY, doc_id: doc2.id, pdf_base64: fakePdf.toString("base64") } });
    ok("but not without a login", r.status === 401, String(r.status));
    const d2b = (await svc.from("doc_generated").select("signed_pdf_path, filed_document_id").eq("id", doc2.id).single()).data;
    if (d2b.signed_pdf_path) await svc.storage.from("signed-documents").remove([d2b.signed_pdf_path]);
    if (d2b.filed_document_id) { const f = (await svc.from("documents").select("url").eq("id", d2b.filed_document_id).single()).data; if (f) await svc.storage.from("documents").remove([f.url]); await svc.from("documents").delete().eq("id", d2b.filed_document_id); }

    // ── D. guards ───────────────────────────────────────────────────────
    const doc3 = await mkDoc();
    const bad = await staff.rpc("create_doc_envelope", { p_doc_id: doc3.id, p_signers: [{ role: "tenant", name: "No Email", email: "", order: 1 }] });
    ok("a signer with no email is refused up front", !!bad.error, "accepted an empty email");
    const none = await staff.rpc("create_doc_envelope", { p_doc_id: doc3.id, p_signers: [] });
    ok("an envelope with no signers is refused", !!none.error);
    const anonEnv = await signerClient.rpc("create_doc_envelope", { p_doc_id: doc3.id, p_signers: [{ role: "t", name: "x", email: "x@example.com", order: 1 }] });
    ok("someone who is not logged in cannot create an envelope", !!anonEnv.error);
    const anonRead = await signerClient.from("doc_signatures").select("access_token").eq("doc_id", doc.id);
    ok("signing links cannot be read without a login", (anonRead.data || []).length === 0);
    const staffRead = await staff.from("doc_signatures").select("access_token").eq("doc_id", doc.id);
    ok("staff can read them", (staffRead.data || []).length >= 3);
    const logWrite = await staff.from("doc_email_log").insert({ company_id: COMPANY, kind: "x", to_email: "x@example.com", status: "sent" });
    ok("the email log cannot be written from the browser", !!logWrite.error);

    r = await call(docImpl, { body: { op: "send-document", company_id: COMPANY, doc_id: doc3.id, to: ["cy@example.com", "not-an-email"], pdf_base64: fakePdf.toString("base64") }, token: jwt });
    ok("send-document refuses a bad address", r.status === 400, JSON.stringify(r.body));
    r = await call(docImpl, { body: { op: "send-document", company_id: COMPANY, doc_id: doc3.id, to: ["cy@example.com"], message: "Here is your notice.", pdf_base64: fakePdf.toString("base64"), filename: "notice.pdf" }, token: jwt });
    ok("send-document logs the send", r.status === 200 && r.body.results?.[0]?.status === "suppressed" && (await logOf(doc3.id)).some(l => l.kind === "document"), JSON.stringify(r.body));
  } catch (e) {
    failed++; console.log("❌ test crashed: " + (e && e.stack || e));
  } finally {
    for (const id of created) await svc.from("doc_generated").delete().eq("id", id);
    if (lease) await svc.from("leases").update({ signature_status: leaseStatusBefore }).eq("id", lease.id);
  }
  console.log(`\n✅ Passed: ${passed}\n❌ Failed: ${failed}`);
  process.exit(failed ? 1 : 0);
})();
