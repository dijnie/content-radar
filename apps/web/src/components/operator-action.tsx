import { useState } from "react";
import { ApiError, request } from "../api-client";

export function operatorAuthorization(password: string) {
  const bytes = new TextEncoder().encode(`settings:${password}`);
  return "Basic " + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
}

type Result = { status: string; sent?: number; until?: number };
const messages: Record<string, string> = {
  paused: "AI processing paused.", stopped: "Stopped.", already_requested: "A retry was just requested.",
  no_eligible_items: "No eligible items to retry now.", ai_paused: "Resume AI before retrying.",
  call_not_retryable: "This call has no eligible batch to retry.", model_changed: "The configured model changed. Refresh and retry.",
  ai_not_configured: "Enable a provider in Settings first.", job_already_finished: "This job has already finished.",
  call_already_finished: "This request has already finished.", password_not_configured: "Configure the Worker password first.",
};

export function OperatorAction({ label, path = "/api/status/ai-control", body = {}, refresh }: {
  label: string; path?: string; body?: object; refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function submit() {
    setPending(true);
    setMessage("");
    try {
      const result = await request<Result>(path, { method: "POST", body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", Authorization: operatorAuthorization(password) } });
      setMessage(result.status === "queued" ? `Queued ${result.sent} items.`
        : result.status === "cooldown" ? (result.until ? `Provider cooldown until ${new Date(result.until * 1000).toLocaleTimeString()}.` : "No available model.")
        : messages[result.status] ?? result.status);
      setOpen(false);
      setPassword("");
      refresh();
    } catch (error) {
      setMessage(error instanceof ApiError ? (["invalid_password", "password_required"].includes(error.code) ? "Incorrect password." : messages[error.code] ?? "Action failed. Please retry.") : "Could not reach Radar.");
    } finally { setPending(false); }
  }
  return <div className="operator-action">
    {open ? <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>Settings password <input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="button" disabled={pending || !password}>{pending ? "Working…" : label}</button>
      <button type="button" className="text-button" disabled={pending} onClick={() => { setOpen(false); setPassword(""); setMessage(""); }}>Cancel</button>
    </form> : <button type="button" className="button" onClick={() => { setOpen(true); setMessage(""); }}>{label}</button>}
    {message && <span role="status">{message}</span>}
  </div>;
}
