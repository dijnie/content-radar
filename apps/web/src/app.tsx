import { SettingsPage } from "./components/settings-page";
import { EmptyState } from "./components/empty-state";
import { StatusPage } from "./components/status-page";
import { StoryGrid } from "./components/story-grid";
import { Toolbar } from "./components/toolbar";
import { useStories } from "./hooks/use-stories";
import { useUrlState } from "./hooks/use-url-state";
import { FeedPage } from "./components/editorial/feed-page";
import { JobsPage } from "./components/editorial/jobs-page";
import type { Filters } from "./types";
import "./editorial.css";

const NAVIGATION = [
  { view: "stories", label: "Stories" }, { view: "news", label: "News" }, { view: "hands-on", label: "Hands-on" },
  { view: "deep-dives", label: "Deep dives" }, { view: "jobs", label: "Jobs" }, { view: "settings", label: "Settings" },
] as const;

export function App() {
  const [filters, setFilters] = useUrlState();
  let content;
  switch (filters.view) {
    case "news":
    case "hands-on":
    case "deep-dives":
      content = <main><FeedPage key={filters.view} feed={filters.view} /></main>;
      break;
    case "jobs":
      content = <main><JobsPage /></main>;
      break;
    case "settings":
      content = <main><SettingsPage /></main>;
      break;
    default:
      content = <StoryViews filters={filters} setFilters={setFilters} />;
  }
  return <div className="page">
    <nav className="app-navigation" aria-label="Content Radar">{NAVIGATION.map(({ view, label }) =>
      <a key={view} href={view === "stories" ? "?" : `?view=${view}`} aria-current={filters.view === view ? "page" : undefined}>{label}</a>
    )}</nav>
    {content}
  </div>;
}

function StoryViews({ filters, setFilters }: { filters: Filters; setFilters: (patch: Partial<Filters>) => void }) {
  const stories = useStories(filters);
  const onStatus = filters.view === "status";

  return (
    <>
      <a className="skip-link" href="#content">Skip to stories</a>
      {!onStatus && <Toolbar filters={filters} counts={stories.counts} topics={stories.topics} onChange={setFilters} />}
      <div className="subbar">
        <p className="caption">{onStatus ? "System status" : filters.sort === "score" ? "Highest score first." : "Newest first."}</p>
        {onStatus && <button type="button" className="text-button" onClick={() => setFilters({ view: "stories" })}>← Back to stories</button>}
      </div>

      <main id="content" tabIndex={-1}>
        {onStatus ? (
          <StatusPage timeZone={stories.timezone} />
        ) : (
          <>
            {stories.actionError && <p className="notice notice--error" role="alert">{stories.actionError}</p>}
            {stories.error && (
              <p className="notice notice--error" role="alert">
                Could not load stories: {stories.error} <button type="button" className="button" onClick={stories.reload}>Retry</button>
              </p>
            )}
            <StoryGrid stories={stories.stories} timeZone={stories.timezone} onAction={stories.act} />
            {stories.loading && <p className="notice" role="status">Loading…</p>}
            {!stories.loading && !stories.error && stories.stories.length === 0 && <EmptyState filters={filters} onClear={() => setFilters({ q: "", topic: null })} />}
            {stories.nextCursor && !stories.loading && <button type="button" className="button load-more" onClick={stories.loadMore}>Show more</button>}
          </>
        )}
      </main>
      {!onStatus && <footer className="page-foot"><button type="button" className="text-button" onClick={() => setFilters({ view: "status" })}>System status</button></footer>}
    </>
  );
}
