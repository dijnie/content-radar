import type { JobRow } from "../../../../../packages/core/src/editorial-types";

export interface CrawlSource {
  sourceId: number;
  label: string;
  type: string;
  status: "queued" | "running" | "ok" | "failed" | "stopped";
  finishedAt: number | null;
  itemsNew: number;
  error: string | null;
  attempts: number;
}

export function CrawlLog({ job, sources, timezone }: { job: JobRow; sources: CrawlSource[]; timezone: string }) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const stamp = (at: number | null) => at == null
    ? <span className="caption">Time unavailable</span>
    : <time dateTime={new Date(at * 1000).toISOString()}>{formatter.format(at * 1000)}</time>;
  const active = sources.filter((source) => source.status === "running" || (source.status === "queued" && source.attempts > 0));
  const finished = sources.filter((source) => source.status === "ok" || source.status === "failed")
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0) || a.sourceId - b.sourceId);

  return (
    <section className="crawl-log" aria-label={`Crawl #${job.id} log`}>
      <h3>Crawl log <span className="caption">{timezone}</span></h3>
      {active.map((source) => (
        <p key={source.sourceId} className="crawl-activity">
          <strong>{source.status === "running" ? "Polling" : "Waiting to retry"}</strong> {source.label}
          {source.attempts > 1 && ` · ${source.attempts} attempts`}
        </p>
      ))}
      {job.status === "running" && !active.length && sources.some((source) => source.status === "queued") && (
        <p className="crawl-activity">Waiting for a worker to pick up the next source.</p>
      )}
      <ol className="crawl-events" aria-label="Crawl events, newest first" tabIndex={0}>
        {job.finishedAt != null && <li>{stamp(job.finishedAt)} <span>Crawl finished · {job.status}</span></li>}
        {finished.map((source) => (
          <li key={source.sourceId}>
            {stamp(source.finishedAt)}
            <span>
              <strong>{source.label}</strong>
              {source.status === "failed"
                ? <span className="crawl-event-error"> · Failed{source.error ? ` · ${source.error}` : ""}</span>
                : ` · ${source.itemsNew} new ${source.itemsNew === 1 ? "item" : "items"}`}
              {source.attempts > 1 && ` · ${source.attempts} attempts`}
            </span>
          </li>
        ))}
        <li>{stamp(job.startedAt)} <span>Crawl started · {job.trigger === "manual" ? "manual" : "scheduled"}</span></li>
      </ol>
    </section>
  );
}
