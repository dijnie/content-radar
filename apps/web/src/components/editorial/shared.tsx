import type { ReactNode } from "react";
import type { EditorialEntry, Publication } from "../../../../../packages/core/src/editorial-types";

export const FEED_LABEL = { news: "News", "hands-on": "Hands-on", "deep-dives": "Deep dives" };
export const compact = (value: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export function dateTime(at: number, timezone = "UTC") {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(at * 1000));
}

export function safeLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function Segments({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string; count?: number }[]; onChange: (value: string) => void }) {
  return (
    <div className="segment" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className="segment-item"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className="count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function PublicationLine({ publication, timezone }: { publication: Publication | null; timezone: string }) {
  const text = publication
    ? `Published from crawl #${publication.crawlId} · build #${publication.runId} · ${dateTime(publication.publishedAt, timezone)}`
    : "No feed published yet.";

  return <p className="publication-line">{text}</p>;
}

export function Pagination({ page, pageSize, total, label, onChange }: { page: number; pageSize: number; total: number; label: string; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const firstItem = total ? (page - 1) * pageSize + 1 : 0;
  const lastItem = Math.min(page * pageSize, total);

  return (
    <div className="editorial-pagination">
      <span>{label} · {firstItem}–{lastItem} of {total}</span>
      <nav aria-label={`${label} pages`}>
        <button className="button" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page">←</button>
        <span aria-live="polite">{page} / {pages}</span>
        <button className="button" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page">→</button>
      </nav>
    </div>
  );
}

export function ResourceState({ loading, error, empty, reload, children }: { loading: boolean; error: string | null; empty: boolean; reload: () => void; children: ReactNode }) {
  if (loading) {
    return <p className="notice" role="status">Loading…</p>;
  }
  if (error) {
    return (
      <div className="notice notice--error" role="alert">
        Could not load this section. <button className="button" onClick={reload}>Retry</button>
        <p className="caption">{error}</p>
      </div>
    );
  }
  if (empty) {
    return (
      <div className="editorial-empty">
        <p>No items match this view yet.</p>
        <p className="caption">Check the filters or open Jobs to review collection and feed builds.</p>
        <a className="button" href="?view=jobs">Open Jobs</a>
      </div>
    );
  }
  return children;
}

export function EntryDetails({ entry }: { entry: EditorialEntry }) {
  return (
    <details className="entry-details">
      <summary>details</summary>
      <div className="entry-detail-body">
        {entry.question && <p><strong>Question</strong> {entry.question}</p>}
        {entry.findings.length > 0 && (
          <ul>
            {entry.findings.map((finding, index) => <li key={index}>{finding}</li>)}
          </ul>
        )}
        <ul className="source-evidence">
          {entry.sources.map((source, index) => (
            <li key={`${source.itemId}-${index}`}>
              <a href={safeLink(source.url)} target="_blank" rel="noopener noreferrer">
                {source.title || source.source} ↗
              </a>
              <span>{source.author ?? source.source} · {source.platform}</span>
              {source.quote && <blockquote>{source.quote}</blockquote>}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
