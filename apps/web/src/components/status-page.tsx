import { useState } from "react";
import { useResource } from "../hooks/use-resource";
import { formatTime } from "./story-card";

interface SourceRow { id: number; type: string; label: string; collection: string | null; enabled: number; lastOkAt: number | null; lastError: string | null; consecutiveFailures: number; itemsLastPoll: number }
interface ModelRow { model: string; rpd: number; rpm: number; limitsAreDefaults: boolean; exhaustedUntil: number | null }
interface UsageRow { model: string; kind: string; requests: number }
interface RunRow { id: number; startedAt: number; status: string; stage: string | null; claims: number | null; communities: number | null; error: string | null }
interface BacklogRow { ingestMode: string; queued: number; oldestQueuedAt: number | null; maxAttempts: number }
interface Status {
  itemsByStatus: { status: string; n: number }[];
  now: number; pacificDay: string; sources: SourceRow[]; backlog: BacklogRow[];
  llm: { models: ModelRow[]; usageToday: UsageRow[]; circuitOpenUntil: number | null };
  clusterRuns: RunRow[]; cards: { alive: number; fallbackHeadlines: number | null; ready: number | null; lead: number | null };
}

const ago = (now: number, at: number | null) => (at === null ? "never" : now - at < 3600 ? `${Math.max(1, Math.round((now - at) / 60))} min ago` : now - at < 86_400 ? `${Math.round((now - at) / 3600)} h ago` : `${Math.round((now - at) / 86_400)} d ago`);

export function StatusPage({ timeZone }: { timeZone: string }) {
  const { data: status, error } = useResource<Status>("/api/status", 15000);
  const [collection, setCollection] = useState("");
  if (error) return <p className="notice notice--error" role="alert">Could not load the system status: {error}</p>;
  if (!status) return <p className="notice" role="status">Loading system status…</p>;
  const failing = status.sources.filter((source) => source.enabled === 1 && source.consecutiveFailures > 0);

  const counts = new Map(status.itemsByStatus.map((row) => [row.status, row.n]));
  return (
    <div className="status-page">
      <section className="panel">
        <h2>Pipeline</h2>
        <p className="caption">Updated {formatTime(status.now, timeZone)} · Refreshes every 15s · <a href="?view=jobs">View crawl and feed jobs</a></p>
        <dl className="facts">
          <div><dt>AI extraction queue</dt><dd>{status.backlog.length === 0 ? "empty" : status.backlog.map((row) => `${row.queued} ${row.ingestMode} (oldest ${ago(status.now, row.oldestQueuedAt)})`).join(", ")}</dd></div>
          <div><dt>Extraction results</dt><dd>{counts.get("extracted") ?? 0} extracted · {counts.get("irrelevant") ?? 0} irrelevant · {counts.get("failed") ?? 0} failed</dd></div>
          <div><dt>LLM circuit</dt><dd>{status.llm.circuitOpenUntil ? `open until ${formatTime(status.llm.circuitOpenUntil, timeZone)}` : "closed"}</dd></div>
          <div><dt>Cards</dt><dd>{status.cards.alive} alive · {status.cards.ready ?? 0} ready · {status.cards.lead ?? 0} lead · {status.cards.fallbackHeadlines ?? 0} on fallback headline</dd></div>
          <div><dt>Sources</dt><dd>{status.sources.filter((source) => source.enabled === 1).length} enabled · {failing.length} failing</dd></div>
        </dl>
      </section>

      <section className="panel">
        <h2>AI app budget, Pacific day {status.pacificDay}</h2>
        {status.llm.models.map((model) => {
          const used = status.llm.usageToday.filter((row) => row.model === model.model);
          const total = used.reduce((sum, row) => sum + row.requests, 0);
          return (
            <div className="budget" key={model.model}>
              <div className="budget-head">
                <span className="mono">{model.model}</span>
                <span>{total} / {model.rpd} requests{model.limitsAreDefaults ? " (safe default)" : ""}{model.exhaustedUntil && model.exhaustedUntil > status.now ? " · parked" : ""}</span>
              </div>
              <progress value={Math.min(total, model.rpd)} max={Math.max(1, model.rpd)} aria-label={`${model.model} requests used today`} />
              <p className="budget-kinds">{used.length === 0 ? "no calls today" : used.map((row) => `${row.kind} ${row.requests}`).join(" · ")}</p>
            </div>
          );
        })}
      </section>

      <section className="panel">
        <h2>Cluster runs</h2>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Run</th><th>Started</th><th>Status</th><th>Claims</th><th>Stories</th><th>Note</th></tr></thead>
            <tbody>
              {status.clusterRuns.length === 0 && <tr><td colSpan={6}>No run yet.</td></tr>}
              {status.clusterRuns.map((run) => (
                <tr key={run.id}><td className="mono">{run.id}</td><td>{ago(status.now, run.startedAt)}</td><td><span className={`state state--${run.status}`}>{run.status}</span></td><td>{run.claims ?? "–"}</td><td>{run.communities ?? "–"}</td><td>{run.error ?? run.stage ?? ""}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Sources</h2>
        <label>Collection{" "}
          <select value={collection} onChange={(event) => setCollection(event.target.value)}>
            <option value="">All collections</option>
            {[...new Set(status.sources.map((source) => source.collection).filter((name) => name != null))].sort().map((name) =>
              <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Source</th><th>Collection</th><th>Type</th><th>Last success</th><th>Failures in a row</th><th>New items</th><th>Last error</th></tr></thead>
            <tbody>
              {status.sources.filter((source) => !collection || source.collection === collection).map((source) => (
                <tr key={source.id} className={source.enabled === 1 ? "" : "row--disabled"}>
                  <td>{source.label}</td><td>{source.collection ?? "—"}</td><td className="mono">{source.type}</td><td>{ago(status.now, source.lastOkAt)}</td>
                  <td>{source.consecutiveFailures > 0 ? <span className="state state--failed">{source.consecutiveFailures}</span> : 0}</td><td>{source.itemsLastPoll}</td><td>{source.lastError ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
