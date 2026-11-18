import { useState, type FormEvent } from "react";
import { ApiError, request } from "../api-client";

interface SavedSettings {
  revision: number;
  enabled: boolean;
  chatEndpoint: string;
  chatModel: string;
  hasChatKey: boolean;
  embeddingEndpoint: string;
  embeddingModel: string;
  hasEmbeddingKey: boolean;
}

const errors: Record<string, string> = {
  invalid_password: "Incorrect password. Try again.",
  password_required: "Enter the Settings password.",
  password_not_configured: "Set PASSWORD in the Worker's Variables and Secrets to unlock Settings.",
  settings_database_not_ready: "Apply the Radar migrations to the D1 database bound as DB, then reload Settings.",
  provider_key_required: "Enter a new API key for the provider whose endpoint changed.",
  invalid_endpoint: "Use an HTTPS endpoint with the API key in its own field.",
  settings_changed: "Settings changed in another tab. Reload the saved settings before editing.",
  invalid_settings: "Check the endpoints, models and API keys.",
};

export function SettingsPage() {
  const [password, setPassword] = useState("");
  const [saved, setSaved] = useState<SavedSettings | null>(null);
  const [draft, setDraft] = useState<SavedSettings | null>(null);
  const [shared, setShared] = useState(true);
  const [chatKey, setChatKey] = useState("");
  const [embeddingKey, setEmbeddingKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(save: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const bytes = new TextEncoder().encode(`settings:${password}`);
      const credentials = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
      const headers = { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" };
      const body = save && draft ? JSON.stringify({
        revision: draft.revision, enabled: draft.enabled, chatEndpoint: draft.chatEndpoint.trim(), chatModel: draft.chatModel.trim(),
        chatKey, embeddingEndpoint: shared ? "" : draft.embeddingEndpoint.trim(), embeddingModel: draft.embeddingModel.trim(),
        embeddingKey: shared ? "" : embeddingKey,
      }) : undefined;
      const result = await request<SavedSettings>("/api/settings/ai", body ? { method: "POST", headers, body } : { headers, cache: "no-store" });
      setSaved(result);
      setDraft({ ...result, enabled: result.revision === 0 || result.enabled });
      setShared(!result.embeddingEndpoint);
      setChatKey("");
      setEmbeddingKey("");
      if (save) setNotice("Settings saved.");
    } catch (err) {
      const action = save ? "save" : "load";
      setError(err instanceof ApiError
        ? errors[err.code] ?? `Could not ${action} settings (HTTP ${err.status}).`
        : `Could not ${action} settings. Check your connection and try again.`);
    } finally { setBusy(false); }
  }
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(Boolean(saved));
  }
  function lock() {
    setSaved(null); setDraft(null); setPassword(""); setChatKey(""); setEmbeddingKey(""); setError(""); setNotice("");
  }
  const chatKeySaved = Boolean(saved?.hasChatKey && saved.chatEndpoint === draft?.chatEndpoint.trim());
  const embeddingKeySaved = Boolean(saved?.hasEmbeddingKey && saved.embeddingEndpoint === draft?.embeddingEndpoint.trim());

  return <section className="settings-page">
    <header className="editorial-header"><h1>Settings</h1>{saved && <button type="button" className="text-button" onClick={lock} disabled={busy}>Lock settings</button>}</header>
    <form onSubmit={onSubmit}>
      {!saved || !draft ? <fieldset className="card" disabled={busy}>
        <legend>Unlock settings</legend>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
        <details><summary>Where to set the password</summary>
          <p>In the Cloudflare Worker settings, set <code>PASSWORD</code> under Variables and Secrets. Choose the Secret type.</p>
          <p>For local development, set <code>PASSWORD</code> in <code>apps/worker/.dev.vars</code>.</p>
        </details>
        <button className="button button--primary" disabled={!password}>{busy ? "Unlocking…" : "Unlock settings"}</button>
      </fieldset> : <>
        <fieldset className="card" disabled={busy}>
          <legend>Chat model</legend>
          <label>API endpoint<input type="url" required placeholder="https://provider.example/v1" value={draft.chatEndpoint} onChange={e => setDraft({ ...draft, chatEndpoint: e.target.value })} /></label>
          <label>Model ID<input required value={draft.chatModel} onChange={e => setDraft({ ...draft, chatModel: e.target.value })} /></label>
          <label>API key<input type="password" autoComplete="new-password" value={chatKey} placeholder={chatKeySaved ? "Leave blank to keep the saved key" : ""} required={!chatKeySaved} onChange={e => setChatKey(e.target.value)} /></label>
        </fieldset>
        <fieldset className="card" disabled={busy}>
          <legend>Embeddings</legend>
          <label className="settings-check"><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />Use the chat endpoint and API key</label>
          {!shared && <>
            <label>Embedding endpoint<input type="url" required value={draft.embeddingEndpoint} onChange={e => setDraft({ ...draft, embeddingEndpoint: e.target.value })} /></label>
            <label>Embedding API key<input type="password" autoComplete="new-password" value={embeddingKey} required={!embeddingKeySaved} placeholder={embeddingKeySaved ? "Leave blank to keep the saved key" : ""} onChange={e => setEmbeddingKey(e.target.value)} /></label>
          </>}
          <label>Embedding model ID<input required aria-describedby="embedding-dims" value={draft.embeddingModel} onChange={e => setDraft({ ...draft, embeddingModel: e.target.value })} /></label>
          <p id="embedding-dims" className="caption">The model must return 1,024-dimensional vectors.</p>
        </fieldset>
        <label className="settings-check"><input type="checkbox" disabled={busy} checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />Enable AI processing</label>
        <div className="settings-actions"><button className="button button--primary" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
          {error && <button type="button" className="text-button" disabled={busy} onClick={() => void submit(false)}>Reload saved settings</button>}
        </div>
      </>}
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </form>
  </section>;
}
