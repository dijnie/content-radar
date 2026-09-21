import type { EditorialEntry } from "../../../../../packages/core/src/editorial-types";
import { compact, EntryDetails, safeLink } from "./shared";

const PART_LABELS: Record<string, string> = {
  starsToday: "Stars today",
  trendingRank: "Trending rank",
  adoption: "Adoption scale",
  freshness: "Repository freshness",
  health: "Project health",
};

function Voices({ entry }: { entry: EditorialEntry }) {
  const names = [...new Set(entry.sources.map((source) => source.author ?? source.source))];
  const visibleNames = names.slice(0, 2).join(", ");
  const remainingNames = names.length > 2 ? ` and ${names.length - 2} others` : "";
  const articleCount = entry.articles
    ? `${entry.articles} article${entry.articles === 1 ? "" : "s"}`
    : "no article yet";

  return (
    <div className="voices">
      <div className="voice-avatars" aria-hidden="true">
        {names.slice(0, 5).map((name) => (
          <span key={name}>
            {name.split(/[\s/_-]+/).slice(0, 2).map((part) => part[0]).join("")}
          </span>
        ))}
      </div>
      <span>{visibleNames}{remainingNames}</span>
      <span className="caption">· {articleCount}</span>
    </div>
  );
}

export function NewsCard({ entry, rank }: { entry: EditorialEntry; rank: number }) {
  const labLeaders = entry.labLeaders === null
    ? "lab leaders not tagged"
    : `${entry.labLeaders} lab leaders`;
  const interactions = entry.interactions === null
    ? "interactions unavailable"
    : `${compact(entry.interactions)} interactions`;

  return (
    <article className="news-card">
      <span className="entry-rank">{rank}</span>
      <div className="news-content">
        <h2>{entry.title}</h2>
        <p className="entry-meta">
          {entry.voices} voices · {labLeaders} · {interactions} · {entry.platforms} platforms
        </p>
        <Voices entry={entry} />
        <EntryDetails entry={entry} />
      </div>
      <div className="heat">
        <meter min="0" max="100" value={entry.score} aria-label="News score" />
        <strong>{Math.round(entry.score)}</strong>
      </div>
    </article>
  );
}

function ScoreTrack({ entry }: { entry: EditorialEntry }) {
  return (
    <div className="score-track" aria-label="Score components">
      {Object.entries(entry.scoreParts).map(([part, value]) => (
        <span
          key={part}
          className={`score-part score-part--${part}`}
          style={{ width: `${value ?? 0}%` }}
          title={`${PART_LABELS[part]}: ${value === null ? "unavailable" : value.toFixed(1)}`}
        />
      ))}
    </div>
  );
}

function ToolFacts({ entry }: { entry: EditorialEntry }) {
  const repo = entry.repository;
  if (!repo) {
    const interactions = entry.interactions === null
      ? "interactions unavailable"
      : `${compact(entry.interactions)} interactions`;
    return <p className="tool-facts">{entry.sources[0]?.source} · {interactions}</p>;
  }

  return (
    <p className="tool-facts">
      <strong>{repo.trendingRank === null ? "Repository discovery" : `#${repo.trendingRank} GitHub Trending`}</strong>
      <span>{repo.starsToday === null ? "daily stars unavailable" : `+${compact(repo.starsToday)} today`}</span>
      <span>{compact(repo.stars)} stars</span>
    </p>
  );
}

export function HandsOnCard({ entry, rank }: { entry: EditorialEntry; rank: number }) {
  const repo = entry.repository;
  const type = entry.category === "toolbox"
    ? "Developer tool"
    : entry.category === "field-tests"
      ? "Field test"
      : "Playbook";

  return (
    <article className={`tool-card tool-card--rank-${Math.min(rank, 4)}`}>
      <span className="tool-rank">{rank}</span>
      <div className="tool-content">
        <div className="tool-heading">
          <h2>
            <a href={safeLink(entry.sources[0]?.url ?? "")} target="_blank" rel="noopener noreferrer">
              {entry.title}
            </a>
          </h2>
          <div className="tool-score">
            <strong>{entry.score.toFixed(1)}</strong>
            {repo && <ScoreTrack entry={entry} />}
          </div>
        </div>
        <p className="tool-type">
          <strong>{type}</strong>
          <span>{entry.sources[0]?.author ?? entry.sources[0]?.source}</span>
        </p>
        <p className="tool-summary">{entry.summary || "Open the source for the repository description."}</p>
        <ToolFacts entry={entry} />
        <EntryDetails entry={entry} />
      </div>
    </article>
  );
}

function DeepDiveActivity({ entry }: { entry: EditorialEntry }) {
  const source = entry.sources[0];
  const hasSourceActivity = source?.upvotes != null || source?.comments != null;

  return (
    <p>
      {source?.source} · {source?.author ?? "Author unavailable"}
      {source?.upvotes != null && <> · <strong>{compact(source.upvotes)} upvotes</strong></>}
      {source?.comments != null && <> · {compact(source.comments)} comments</>}
      {!hasSourceActivity && entry.interactions !== null && (
        <> · <strong>{compact(entry.interactions)} interactions</strong></>
      )}
    </p>
  );
}

export function DeepDiveCard({ entry, pending, onRead }: { entry: EditorialEntry; pending: boolean; onRead: () => void }) {
  return (
    <article className="deep-card">
      <span className="deep-pillar">{entry.pillar}</span>
      <div className="deep-content">
        <div className="deep-heading">
          <h2>{entry.title}</h2>
          <button type="button" className="button" disabled={pending} onClick={onRead}>
            {pending ? "Saving…" : entry.read ? "Mark as unread" : "Mark as read"}
          </button>
        </div>
        {entry.question && (
          <div className="deep-question">
            <strong>Question</strong>
            <p>{entry.question}</p>
          </div>
        )}
        <p className="deep-summary">{entry.summary}</p>
        {entry.findings.length > 0 && (
          <ul className="deep-findings">
            {entry.findings.map((finding, index) => <li key={index}>{finding}</li>)}
          </ul>
        )}
        <div className="deep-footer">
          <DeepDiveActivity entry={entry} />
          <div className="deep-links">
            <EntryDetails entry={entry} />
            <a href={safeLink(entry.sources[0]?.url ?? "")} target="_blank" rel="noopener noreferrer">open ↗</a>
          </div>
        </div>
      </div>
    </article>
  );
}
