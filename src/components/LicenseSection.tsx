// License / plan section for Settings. Progressive disclosure: novices see just
// their plan and a one-tap "Activate license" flow; experts can expand the
// details (id, dates, unlocked features). Reads the app-wide licenseStore and
// calls its activate/deactivate/refresh — it never touches the verifier.

import { useRef, useState } from "react";
import { useStore } from "zustand";
import { licenseStore } from "../license";

// Human labels for the store status. Free/none are the same to a novice ("Free
// plan"); the others explain why a key isn't granting Pro right now.
function planLabel(tier: string, status: string): string {
  if (tier === "pro" && status === "valid") return "Pro — active";
  if (status === "expired") return "Pro — expired";
  if (status === "not-yet-valid") return "Pro — not active yet";
  return "Free plan";
}

export function LicenseSection() {
  const status = useStore(licenseStore, (s) => s.status);
  const tier = useStore(licenseStore, (s) => s.entitlements.tier);
  const message = useStore(licenseStore, (s) => s.message);
  const token = useStore(licenseStore, (s) => s.token);

  const [activating, setActivating] = useState(false); // paste UI open?
  const [expanded, setExpanded] = useState(false); // expert details open?
  const [keyText, setKeyText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isPro = tier === "pro" && status === "valid";
  const hasToken = token !== null;

  function submit() {
    const result = licenseStore.getState().activate(keyText);
    // A signature-valid token (even expired) is accepted and its field cleared;
    // a forged/garbled key keeps the field open with the error shown.
    if (result.status === "malformed" || result.status === "invalid-signature") {
      setError(result.message);
      return;
    }
    setError(null);
    setKeyText("");
    setActivating(false);
  }

  // Read a pasted-in license file into the field with the WKWebView FileReader.
  function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setKeyText(String(reader.result ?? "").trim());
    reader.readAsText(file);
  }

  function remove() {
    licenseStore.getState().deactivate();
    setError(null);
    setKeyText("");
    setActivating(false);
    setExpanded(false);
  }

  return (
    <section className="mt-4 border-t border-border pt-3" aria-labelledby="license-heading">
      <div className="flex items-center justify-between">
        <h2 id="license-heading" className="font-semibold tracking-[0.12em] text-text">
          license
        </h2>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            isPro ? "bg-accent/15 text-accent" : "text-text-dim"
          }`}
        >
          {planLabel(tier, status)}
        </span>
      </div>

      {/* Expired/not-yet-valid guidance — features are off but nothing broke. */}
      {hasToken && !isPro && (status === "expired" || status === "not-yet-valid") && (
        <p className="mt-2 text-[11px] text-text-dim">{message}</p>
      )}

      {!activating ? (
        <div className="mt-2 flex items-center gap-2">
          {!isPro ? (
            <button
              type="button"
              onClick={() => {
                setActivating(true);
                setError(null);
              }}
              className="rounded px-2 py-1 text-left text-text-dim hover:bg-surface-hover hover:text-text"
            >
              activate license…
            </button>
          ) : (
            <button
              type="button"
              onClick={remove}
              title="Remove this license from this device"
              className="rounded px-2 py-1 text-left text-text-dim hover:bg-surface-hover hover:text-text"
            >
              remove license
            </button>
          )}
          {hasToken && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="rounded px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
            >
              {expanded ? "hide details" : "details"}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <label htmlFor="license-key" className="block text-[11px] text-text-dim">
            Paste your license key, or import it from a file.
          </label>
          <textarea
            id="license-key"
            value={keyText}
            onChange={(event) => setKeyText(event.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="paste license key…"
            className="w-full resize-none rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] text-text focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {error && (
            <p role="alert" className="text-[11px] text-[var(--kd-error)]">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={keyText.trim() === ""}
              className="rounded bg-accent/15 px-2 py-1 text-accent hover:bg-accent/25 disabled:opacity-50"
            >
              activate
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
            >
              from file…
            </button>
            <button
              type="button"
              onClick={() => {
                setActivating(false);
                setError(null);
                setKeyText("");
              }}
              className="rounded px-2 py-1 text-text-dim hover:bg-surface-hover hover:text-text"
            >
              cancel
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.lic,.key,text/plain"
              onChange={onFile}
              className="hidden"
              aria-hidden="true"
            />
          </div>
        </div>
      )}

      {/* Expert details — dates, id, and exactly which features are unlocked. */}
      {expanded && token && (
        <dl className="mt-2 space-y-1 text-[10px] text-text-dim">
          <div className="flex justify-between gap-2">
            <dt>license id</dt>
            <dd className="font-mono">{token.id}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>issued</dt>
            <dd className="tabular-nums">{token.issuedAt.slice(0, 10)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>expires</dt>
            <dd className="tabular-nums">{token.expiry ? token.expiry.slice(0, 10) : "never"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt>features</dt>
            <dd className="text-right font-mono">
              {token.features.length ? token.features.join(", ") : "—"}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
