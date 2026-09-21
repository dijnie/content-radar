import { useState, type FormEvent } from "react";
import type { FeedKind, FeedSchedule, JobRow, JobsResponse } from "../../../../../packages/core/src/editorial-types";
import { ApiError, request } from "../../api-client";
import { useResource, useSectionQuery } from "../../hooks/use-resource";
import { dateTime, FEED_LABEL, Pagination, ResourceState } from "./shared";

const defaults = { days: "7", failures: "0", page: "1" };
const FEEDS: FeedKind[] = ["news", "hands-on", "deep-dives"];

type JobDetailResponse = {
  sources?: {
    label: string;
    type: string;
    status: string;
    itemsNew: number;
    error: string | null;
    attempts: number;
  }[];
  run: { error?: string | null };
};

const duration = (job: JobRow) => {
  const finishedAt = job.finishedAt ?? Math.floor(Date.now() / 1000);
  const seconds = Math.max(0, finishedAt - job.startedAt);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const post = <T,>(path: string, body: unknown = {}) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function JobDetail({ job }: { job: JobRow }) {
  const resource = useResource<JobDetailResponse>(`/api/jobs/${job.kind}/${job.id}`);

  return (
    <ResourceState loading={resource.loading} error={resource.error} empty={false} reload={resource.reload}>
      <div className="job-detail">
        {resource.data?.sources ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Source</th><th>Status</th><th>New items</th><th>Attempts</th><th>Error</th></tr>
              </thead>
              <tbody>
                {resource.data.sources.map((source, index) => (
                  <tr key={index}>
                    <td>{source.label} <span className="caption">{source.type}</span></td>
                    <td>{source.status}</td>
                    <td>{source.itemsNew}</td>
                    <td>{source.attempts}</td>
                    <td>{source.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>{resource.data?.run.error ?? `Built from crawl #${job.crawlId}. ${job.entries} entries.`}</p>
        )}
      </div>
    </ResourceState>
  );
}

type JobProps = {
  job: JobRow;
  timezone: string;
  onBuild: (feed: FeedKind, crawlId: number) => void;
  pending: boolean;
};

function Job({ job, timezone, onBuild, pending }: JobProps) {
  const [open, setOpen] = useState(false);
  const isCrawl = job.kind === "crawl";
  const jobLabel = job.kind === "crawl" ? "crawl" : FEED_LABEL[job.kind];
  const canBuildFeeds = isCrawl && ["ok", "partial"].includes(job.status);
  const canRunAgain = !isCrawl && job.crawlId !== null && !["queued", "running"].includes(job.status);

  return (
    <div className="job-card">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="job-row">
          <strong>{jobLabel} #{job.id}</strong>
          <time>{dateTime(job.startedAt, timezone)}</time>
          <span className={`state state--${job.status}`}>
            {job.status}{job.failures ? ` · ${job.failures} sources` : ""}
          </span>
          {isCrawl ? (
            <div className="job-stats">
              <span><b>{job.sources}</b> Sources</span>
              <span><b>{job.posts}</b> Posts</span>
              <span><b>{job.articles}</b> Articles</span>
            </div>
          ) : (
            <div className="job-stats">
              <span>crawl <b>#{job.crawlId}</b></span>
              <span><b>{job.entries}</b> Entries</span>
            </div>
          )}
          <span className="job-duration">{duration(job)}</span>
        </summary>
        {open && <JobDetail job={job} />}
      </details>
      {open && (
        <div className="job-actions">
          {canBuildFeeds && FEEDS.map((feed) => (
            <button className="button" disabled={pending} key={feed} onClick={() => onBuild(feed, job.id)}>
              Build {FEED_LABEL[feed]}
            </button>
          ))}
          {canRunAgain && (
            <button className="button" disabled={pending} onClick={() => onBuild(job.kind as FeedKind, job.crawlId!)}>
              Run again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Schedule({ schedule, onSaved }: { schedule: FeedSchedule; onSaved: () => void }) {
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [minutes, setMinutes] = useState(schedule.intervalMinutes);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      await post(`/api/jobs/schedules/${schedule.feed}`, { enabled, intervalMinutes: minutes });
      setMessage("Saved");
      onSaved();
    } catch {
      setMessage("Could not save schedule. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="schedule-row" onSubmit={save}>
      <strong>{FEED_LABEL[schedule.feed]}</strong>
      <label>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enabled
      </label>
      <label>
        Every <input
          type="number"
          min="30"
          max="10080"
          step="1"
          required
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
          aria-label={`${FEED_LABEL[schedule.feed]} interval in minutes`}
        /> minutes
      </label>
      <button className="button" disabled={pending}>{pending ? "Saving…" : "Save schedule"}</button>
      {message && <span role="status">{message}</span>}
    </form>
  );
}

export function JobsPage() {
  const [query, update] = useSectionQuery(defaults);
  const resource = useResource<JobsResponse>(`/api/jobs?${new URLSearchParams(query)}`, 5000);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crawlId, setCrawlId] = useState("");

  const run = async (feed?: FeedKind, selected?: number) => {
    setPending(true);
    setError(null);
    setMessage(null);
    const path = feed ? `/api/jobs/feeds/${feed}` : "/api/jobs/crawls";
    const body = feed ? { crawlId: selected ?? (crawlId ? Number(crawlId) : null) } : {};

    try {
      const result = await post<{ id: number; created: boolean }>(path, body);
      const jobName = feed ? FEED_LABEL[feed] : "Crawl";
      const status = result.created ? "queued" : "already in progress";
      setMessage(`${jobName} #${result.id} ${status}.`);
      resource.reload();
    } catch (reason) {
      const completedCrawlRequired = reason instanceof ApiError && reason.code === "completed_crawl_required";
      setError(completedCrawlRequired
        ? "Finish a crawl successfully before building a feed."
        : "Could not start the job. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const data = resource.data;
  const finishedCrawls = data?.crawls.filter((job) => ["ok", "partial"].includes(job.status));

  return (
    <section className="jobs-page" aria-labelledby="jobs-title">
      <header className="jobs-header">
        <div>
          <h1 id="jobs-title">Jobs</h1>
          <p>Crawling and feed building are separate jobs. A crawl stops after dedup; each feed is built from a finished crawl on its own schedule and can be re-run independently.</p>
        </div>
        <div className="jobs-filters">
          <label>
            Date <select value={query.days} onChange={(event) => update({ days: event.target.value })}>
              {[7, 30, 90, 365].map((days) => <option value={String(days)} key={days}>Last {days} days</option>)}
            </select>
          </label>
          <button
            type="button"
            className="button"
            aria-pressed={query.failures === "1"}
            onClick={() => update({ failures: query.failures === "1" ? "0" : "1" })}
          >
            Failures only
          </button>
          <span className="caption">{data?.total ?? 0} jobs</span>
        </div>
      </header>

      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="notice notice--error" role="alert">{error}</p>}

      <div className="editorial-section-heading">
        <h2>Crawls <span className="count">{data?.crawls.length ?? 0} shown</span></h2>
        <button className="button button--primary" disabled={pending} onClick={() => void run()}>
          {pending ? "Starting…" : "Run"}
        </button>
      </div>
      <ResourceState loading={resource.loading && !data} error={resource.error} empty={false} reload={resource.reload}>
        <div className="job-list">
          {data?.crawls.map((job) => (
            <Job key={job.id} job={job} timezone={data.timezone} pending={pending} onBuild={(feed, id) => void run(feed, id)} />
          ))}
          {data && !data.crawls.length && <p className="notice">No crawls in this view.</p>}
        </div>
      </ResourceState>

      <div className="editorial-section-heading">
        <h2>Feed builds</h2>
        <label>
          From crawl <select aria-label="Build from crawl" value={crawlId} onChange={(event) => setCrawlId(event.target.value)}>
            <option value="">Latest finished</option>
            {finishedCrawls?.map((job) => (
              <option value={job.id} key={job.id}>#{job.id} · {dateTime(job.startedAt, data!.timezone)}</option>
            ))}
          </select>
        </label>
        <div className="job-actions">
          {FEEDS.map((feed) => (
            <button className="button" key={feed} disabled={pending} onClick={() => void run(feed)}>
              Build {FEED_LABEL[feed]}
            </button>
          ))}
        </div>
      </div>

      <div className="job-list">
        {data?.builds.map((job) => (
          <Job key={`${job.kind}-${job.id}`} job={job} timezone={data.timezone} pending={pending} onBuild={(feed, id) => void run(feed, id)} />
        ))}
        {data && !data.builds.length && <p className="notice">No feed builds in this view.</p>}
      </div>

      {data && data.total > 0 && (
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} label="Jobs" onChange={(page) => update({ page: String(page) })} />
      )}

      <details className="schedules">
        <summary>Feed schedules</summary>
        <p className="caption">Each feed uses the latest finished crawl. Disabling a schedule keeps its published feed available.</p>
        {data?.schedules.map((schedule) => (
          <Schedule key={schedule.feed} schedule={schedule} onSaved={resource.reload} />
        ))}
      </details>
    </section>
  );
}
