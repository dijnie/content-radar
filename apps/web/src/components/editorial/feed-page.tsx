import { useEffect, useState } from "react";
import type { EditorialEntry, EditorialFeedResponse, FeedKind } from "../../../../../packages/core/src/editorial-types";
import { request } from "../../api-client";
import { useResource, useSectionQuery } from "../../hooks/use-resource";
import { DeepDiveCard, HandsOnCard, NewsCard } from "./feed-cards";
import { FEED_LABEL, Pagination, PublicationLine, ResourceState, Segments } from "./shared";

const DEFAULTS = {
  window: "recent",
  category: "toolbox",
  months: "1",
  state: "unread",
  pillar: "",
  sort: "relevance",
  q: "",
  page: "1",
};

const DESCRIPTIONS = {
  news: "what the community is arguing about",
  "hands-on": "repos, rules, skills and model reviews people actually ran",
  "deep-dives": "papers and hard-won engineering writeups",
};

const CATEGORIES = [
  { value: "toolbox", label: "Community toolbox" },
  { value: "field-tests", label: "Field tests" },
  { value: "playbooks", label: "Playbooks" },
];

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  toolbox: "Repos, skills, libraries and reusable tools gaining traction in the community.",
  "field-tests": "First-hand tests and concrete observations from people using the tools.",
  playbooks: "Practical procedures, rules and repeatable workflows.",
};

type Query = Record<string, string>;
type UpdateQuery = (patch: Record<string, string>) => void;

function FeedHeader({
  feed,
  total,
  query,
  counts,
  update,
}: {
  feed: FeedKind;
  total: number;
  query: Query;
  counts: Record<string, number>;
  update: UpdateQuery;
}) {
  const monthOptions = [1, 2, 3].map((month) => ({
    value: String(month),
    label: month === 1 ? "Last month" : `Last ${month} months`,
    count: counts[`month${month}`] ?? 0,
  }));

  return (
    <header className="editorial-header">
      <h1 id="feed-title">{FEED_LABEL[feed]} <span className="count">{total}</span></h1>
      <p>{DESCRIPTIONS[feed]}</p>
      {feed === "deep-dives" && (
        <Segments
          label="Reading window"
          value={query.months!}
          options={monthOptions}
          onChange={(months) => update({ months })}
        />
      )}
    </header>
  );
}

function FeedControls({
  feed,
  data,
  query,
  draft,
  setDraft,
  update,
}: {
  feed: FeedKind;
  data: EditorialFeedResponse | null;
  query: Query;
  draft: string;
  setDraft: (value: string) => void;
  update: UpdateQuery;
}) {
  const counts = data?.counts ?? {};

  return (
    <div className="editorial-controls">
      {feed === "news" && (
        <>
          <p className="caption">
            {data?.eligible ?? 0} of {data?.publication?.total ?? 0} topics cleared the {data?.threshold ?? "configured"} score threshold in this window.
          </p>
          <Segments
            label="News window"
            value={query.window!}
            options={[{ value: "recent", label: "Recent" }, { value: "7d", label: "Last 7d" }]}
            onChange={(window) => update({ window })}
          />
        </>
      )}

      {feed === "hands-on" && (
        <>
          <Segments
            label="Hands-on category"
            value={query.category!}
            options={CATEGORIES.map((category) => ({
              ...category,
              count: counts[category.value] ?? 0,
            }))}
            onChange={(category) => update({ category })}
          />
          <p className="caption">{CATEGORY_DESCRIPTIONS[query.category!]}</p>
        </>
      )}

      {feed === "deep-dives" && (
        <>
          <Segments
            label="Reading state"
            value={query.state!}
            options={[
              { value: "unread", label: "Unread", count: counts.unread ?? 0 },
              { value: "read", label: "Read", count: counts.read ?? 0 },
            ]}
            onChange={(state) => update({ state })}
          />
          <label>
            pillar <select value={query.pillar} onChange={(event) => update({ pillar: event.target.value })}>
              <option value="">All</option>
              {data?.pillars.map((pillar) => <option key={pillar} value={pillar}>{pillar}</option>)}
            </select>
          </label>
          <label>
            sort <select value={query.sort} onChange={(event) => update({ sort: event.target.value })}>
              <option value="relevance">relevance</option>
              <option value="newest">newest</option>
            </select>
          </label>
          <input
            type="search"
            className="search"
            aria-label="Search deep dives"
            placeholder="Search deep dives…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </>
      )}
    </div>
  );
}

function FeedEntry({
  feed,
  entry,
  rank,
  readPending,
  onRead,
}: {
  feed: FeedKind;
  entry: EditorialEntry;
  rank: number;
  readPending: boolean;
  onRead: () => void;
}) {
  if (feed === "news") {
    return <NewsCard entry={entry} rank={rank} />;
  }
  if (feed === "hands-on") {
    return <HandsOnCard entry={entry} rank={rank} />;
  }
  return <DeepDiveCard entry={entry} pending={readPending} onRead={onRead} />;
}

export function FeedPage({ feed }: { feed: FeedKind }) {
  const [query, update] = useSectionQuery(DEFAULTS);
  const resource = useResource<EditorialFeedResponse>(`/api/feeds/${feed}?${new URLSearchParams(query)}`);
  const data = resource.data;
  const [draft, setDraft] = useState(query.q ?? "");
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => setDraft(query.q ?? ""), [query.q]);

  useEffect(() => {
    if (data && !resource.loading && data.page > 1 && !data.entries.length) {
      const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
      update({ page: String(lastPage) });
    }
  }, [data, resource.loading]);

  useEffect(() => {
    if (draft === query.q) return;

    const timer = setTimeout(() => update({ q: draft }), 300);
    return () => clearTimeout(timer);
  }, [draft, query.q]);

  const read = async (key: string, value: boolean) => {
    setPending(key);
    setActionError(null);
    try {
      await request("/api/feeds/deep-dives/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, read: value }),
      });
      resource.reload();
    } catch {
      setActionError("Could not save the reading state. Please try again.");
    } finally {
      setPending(null);
    }
  };

  const counts = data?.counts ?? {};
  const weights = data?.scoring.weights as Record<string, number> | undefined;
  const listClassName = feed === "hands-on" ? "tool-grid" : "editorial-list";
  const paginationLabel = feed === "hands-on"
    ? CATEGORIES.find((category) => category.value === query.category)?.label ?? FEED_LABEL[feed]
    : FEED_LABEL[feed];

  return (
    <section className={`editorial-page editorial-page--${feed}`} aria-labelledby="feed-title">
      <FeedHeader
        feed={feed}
        total={data?.publication?.total ?? 0}
        query={query}
        counts={counts}
        update={update}
      />
      <PublicationLine publication={data?.publication ?? null} timezone={data?.timezone ?? "UTC"} />
      <FeedControls
        feed={feed}
        data={data}
        query={query}
        draft={draft}
        setDraft={setDraft}
        update={update}
      />

      {feed === "hands-on" && query.category === "toolbox" && (
        <details className="scoring-legend">
          <summary>How repository scores work</summary>
          <p>
            {weights
              ? `Stars today · ${weights.starsToday} · Trending rank · ${weights.trendingRank} · Adoption scale · ${weights.adoption} · Repository freshness · ${weights.freshness} · Project health · ${weights.health}`
              : "The score breakdown appears with the first published repository snapshot."}
          </p>
          <p>Daily stars and total stars use logarithmic scales; rank and freshness use linear scales. Health records whether a repository is archived and has a declared license. Missing facts stay unavailable and contribute no points.</p>
        </details>
      )}

      {!!data?.awaitingEditorial && (
        <p className="caption">
          {data.awaitingEditorial} source items were awaiting analysis when this feed was built. More results can appear in a later build.
        </p>
      )}
      {actionError && <p className="notice notice--error" role="alert">{actionError}</p>}

      <ResourceState
        loading={resource.loading}
        error={resource.error}
        empty={!data?.entries.length}
        reload={resource.reload}
      >
        <div className={listClassName}>
          {data?.entries.map((entry, index) => (
            <FeedEntry
              key={entry.key}
              feed={feed}
              entry={entry}
              rank={(data.page - 1) * data.pageSize + index + 1}
              readPending={pending !== null}
              onRead={() => void read(entry.key, !entry.read)}
            />
          ))}
        </div>
      </ResourceState>

      {data && data.total > 0 && (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          label={paginationLabel}
          onChange={(page) => update({ page: String(page) })}
        />
      )}
    </section>
  );
}
