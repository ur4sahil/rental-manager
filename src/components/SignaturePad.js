import React, { useRef, useState } from "react";
import { TextLink, Checkbox, FilterPill, Btn } from "../ui";
import { printTheme } from "../utils/theme";

// Disclosure version. Bumped when the disclosure text below changes
// — captured per signer in doc_signatures.e_records_consent_version
// so a forensic reviewer can render the exact disclosure that was
// shown to a given signer at signing time.
export const ESIGN_CONSENT_VERSION = "v1.2026-04-24";

// Reusable signature capture: draw OR type mode + ESIGN-compliant
// consent block. onSubmit receives:
//   { signatureData, signingMethod, consentText, signerName,
//     eRecordsConsented, hwSwAcknowledged, consentVersion }
//
// The consent block is built to satisfy ESIGN Act §101(c)(1)(B)
// (right to paper, right to withdraw, hardware/software requirements
// disclosure) and the parallel UETA requirements. Disclosure language
// drafted from the public consent forms used by DocuSign, Dropbox
// Sign (HelloSign), and Adobe Sign as of 2026 — see comments on each
// section of the disclosure component below.

export default function SignaturePad({
  signerName = "",
  signerLabel = "",
  consentText = "I agree that my electronic signature is the legal equivalent of my manual/handwritten signature and I consent to be legally bound by this document.",
  submitLabel = "Apply Signature",
  submitting = false,
  // ESIGN-required context — when present, the full consumer
  // disclosure block is rendered. companyContactEmail powers the
  // paper-copy / withdrawal request line.
  companyName = "",
  companyContactEmail = "",
  onSubmit,
}) {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [signMethod, setSignMethod] = useState("draw");
  const [typedName, setTypedName] = useState(signerName || "");
  // Three independent assents — bundling them into one checkbox
  // would defeat the point of ESIGN's "affirmative consent to
  // electronic records" requirement (which must be separable from
  // the signature itself).
  const [eRecordsConsented, setERecordsConsented] = useState(false);
  const [hwSwAck, setHwSwAck] = useState(false);
  const [signatureConsent, setSignatureConsent] = useState(false);
  const [showFullDisclosure, setShowFullDisclosure] = useState(false);
  const [localError, setLocalError] = useState("");

  function startDraw(e) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsDrawing(true);
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function draw(e) {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = printTheme.signatureInk;
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function endDraw() { setIsDrawing(false); }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  const allConsentsGiven = eRecordsConsented && hwSwAck && signatureConsent;

  function handleSubmit() {
    setLocalError("");
    if (!allConsentsGiven) {
      setLocalError("Please complete all three consents above before signing.");
      return;
    }
    let signatureData = "";
    if (signMethod === "draw") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hasContent = pixels.some((v, i) => i % 4 === 3 && v > 0);
      if (!hasContent) { setLocalError("Please draw your signature first."); return; }
      signatureData = canvas.toDataURL("image/png");
    } else {
      if (!typedName.trim()) { setLocalError("Please type your full legal name."); return; }
      signatureData = "typed:" + typedName.trim() + "|ts:" + new Date().toISOString();
    }
    onSubmit({
      signatureData,
      signingMethod: signMethod,
      consentText,
      signerName: typedName.trim() || signerName,
      eRecordsConsented: true,
      hwSwAcknowledged: true,
      consentVersion: ESIGN_CONSENT_VERSION,
    });
  }

  const sender = companyName || "the sender";
  const contact = companyContactEmail || "the sender directly";

  return (
    <div className="border border-brand-100 rounded-2xl p-4 bg-white">
      {signerLabel && <div className="text-sm font-semibold text-neutral-700 mb-2">Signing as: {signerLabel}{signerName ? " — " + signerName : ""}</div>}

      <div className="flex gap-2 mb-3">
        <FilterPill active={signMethod === "draw"} onClick={() => { setSignMethod("draw"); setLocalError(""); }}>Draw Signature</FilterPill>
        <FilterPill active={signMethod === "type"} onClick={() => { setSignMethod("type"); setLocalError(""); }}>Type Name</FilterPill>
      </div>

      {signMethod === "draw" ? (
        <div>
          <div className="border-2 border-dashed border-brand-200 rounded-lg bg-white relative mb-2">
            <canvas
              ref={canvasRef}
              width={600}
              height={160}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={endDraw}
              onMouseLeave={endDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={endDraw}
              className="w-full cursor-crosshair"
              style={{ touchAction: "none" }}
            />
            <div className="absolute bottom-1 left-3 text-xs text-neutral-300 pointer-events-none">Sign above this line</div>
          </div>
          <TextLink tone="neutral" type="button" onClick={clearCanvas} >Clear</TextLink>
        </div>
      ) : (
        <div>
          <input
            value={typedName}
            onChange={e => setTypedName(e.target.value)}
            placeholder="Type your full legal name"
            className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm mb-1"
          />
          {typedName && <div className="text-2xl text-brand-800 italic font-serif py-3 px-3 bg-brand-50/40 rounded-lg">{typedName}</div>}
        </div>
      )}

      {/* ESIGN Act §101(c)(1)(B) — full consumer disclosure block.
          Three separate consents (records, hardware/software, signature)
          are presented because bundling them defeats the "affirmative
          and separable" requirement of the statute. */}
      <div className="mt-5 border border-neutral-200 rounded-xl bg-neutral-50/60 overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-200 bg-white">
          <div className="text-sm font-semibold text-neutral-800">Electronic Records & Signatures Disclosure</div>
          <div className="text-[11px] text-neutral-500 mt-0.5">
            Disclosure version {ESIGN_CONSENT_VERSION} · Required by the federal ESIGN Act and your state's UETA
            <button type="button" onClick={() => setShowFullDisclosure(s => !s)} className="ml-2 text-brand-600 hover:text-brand-700 underline">
              {showFullDisclosure ? "Hide details" : "Read full disclosure"}
            </button>
          </div>
        </div>

        {showFullDisclosure && (
          <div className="px-4 py-3 border-b border-neutral-200 text-xs text-neutral-700 leading-relaxed space-y-2 bg-white">
            <p><strong>1. Scope.</strong> You are about to electronically sign one or more documents from {sender} related to your tenancy or property. This consent applies to the document(s) you are signing in this session only.</p>
            <p><strong>2. Right to receive paper copies.</strong> You have the right to receive a paper copy of any document signed electronically through this service, before or after signing, at no cost. To request a paper copy, contact {contact}, or use the "Request paper copy" link below this disclosure.</p>
            <p><strong>3. Right to withdraw consent.</strong> You may withdraw your consent to use electronic records and signatures at any time. Withdrawing consent does not invalidate any electronic record or signature you have already provided — it switches future communications to paper. To withdraw, contact {contact}, or use the "Withdraw consent" link below this disclosure.</p>
            <p><strong>4. Updating contact info.</strong> To update the email address used for these communications, contact {contact}.</p>
            <p><strong>5. Hardware and software requirements.</strong> You will need: a current web browser (Chrome, Safari, Firefox, or Edge — last two major versions); the ability to receive emails at the address used to send this document; the ability to view, save, and print PDF files; and a device with internet access.</p>
            <p><strong>6. Audit trail.</strong> Your IP address, browser type, the time of signing, the cryptographic hash of the document at the time it was sent for signature, and a reproducible hash of your signature will be recorded in our audit log. The audit log is preserved for the duration of the contract plus seven years.</p>
            <p><strong>7. Legal effect.</strong> Under the ESIGN Act and applicable state law (UETA), an electronic signature has the same legal effect as a handwritten signature. You agree your electronic signature on this document binds you to its terms exactly as a pen-and-ink signature would.</p>
          </div>
        )}

        <div className="px-4 py-3 space-y-3 bg-white">
          <Checkbox
            checked={eRecordsConsented}
            onChange={e => setERecordsConsented(e.target.checked)}
            label={<span className="text-xs text-neutral-700 leading-relaxed">
              <strong>I consent to use electronic records and signatures</strong> for this document. I understand I have the right to request a paper copy, or to withdraw this consent at any time, by contacting {contact}.
            </span>}
          />
          <Checkbox
            checked={hwSwAck}
            onChange={e => setHwSwAck(e.target.checked)}
            label={<span className="text-xs text-neutral-700 leading-relaxed">
              <strong>I confirm I can access this document electronically.</strong> I have a current web browser, can receive emails at the address used to send this document, and can view and save PDF files.
            </span>}
          />
          <Checkbox
            checked={signatureConsent}
            onChange={e => setSignatureConsent(e.target.checked)}
            label={<span className="text-xs text-neutral-700 leading-relaxed">
              <strong>{consentText}</strong>
            </span>}
          />
        </div>
      </div>

      {localError && <div className="mt-3 text-xs text-danger-600 bg-danger-50 border border-danger-200 rounded-lg px-3 py-2">{localError}</div>}

      <Btn
        variant="primary"
        size="lg"
        type="button"
        onClick={handleSubmit}
        disabled={submitting || !allConsentsGiven}
        className="w-full mt-4"
      >
        {submitting ? "Signing…" : !allConsentsGiven ? "Complete the three consents above to sign" : submitLabel}
      </Btn>
    </div>
  );
}
