import { SettingsPage } from "./components/settings-page";
import { EmptyState } from "./components/empty-state";
import { OperatorSession } from "./components/operator-action";
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
  { view: "deep-dives", label: "Deep dives" }, { view: "jobs", label: "Jobs" }, { view: "status", label: "Điều khiển AI" }, { view: "settings", label: "Settings" },
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
    case "status":
      content = <main id="content"><StatusPage /></main>;
      break;
    case "settings":
      content = <main><SettingsPage /></main>;
      break;
    default:
      content = <StoryViews filters={filters} setFilters={setFilters} />;
  }
  return <OperatorSession><div className="page">
    <nav className="app-navigation" aria-label="Content Radar">{NAVIGATION.map(({ view, label }) =>
      <a key={view} href={view === "stories" ? "?" : `?view=${view}`} aria-current={filters.view === view ? "page" : undefined}>{label}</a>
    )}</nav>
    {content}
  </div></OperatorSession>;
}

function StoryViews({ filters, setFilters }: { filters: Filters; setFilters: (patch: Partial<Filters>) => void }) {
  const stories = useStories(filters);

  return (
    <>
      <a className="skip-link" href="#content">Skip to stories</a>
      <Toolbar filters={filters} counts={stories.counts} topics={stories.topics} onChange={setFilters} />
      <div className="subbar">
        <p className="caption">{filters.sort === "score" ? "Highest score first." : "Newest first."}</p>
      </div>

      <main id="content" tabIndex={-1}>
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
      </main>
    </>
  );
}
