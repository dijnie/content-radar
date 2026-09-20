import { useEffect, useState } from "react";
import type { Filters, Sort, StoryListResponse, Tab } from "../types";

const TAB_LABEL: Record<Tab, string> = { inbox: "Ready · Lead", saved: "Saved", dismissed: "Dismissed" };
const SORT_LABEL: Record<Sort, string> = { newest: "Newest", score: "Score" };

interface Props {
  filters: Filters;
  counts: StoryListResponse["counts"] | null;
  topics: StoryListResponse["topics"];
  onChange: (patch: Partial<Filters>) => void;
}

function Segment<T extends string>({ label, options, value, onSelect }: { label: string; options: { value: T; text: string; count?: number | undefined }[]; value: T; onSelect: (value: T) => void }) {
  return (
    <div className="segment" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className="segment-item" aria-pressed={option.value === value} onClick={() => onSelect(option.value)}>
          {option.text}
          {option.count !== undefined && <span className="count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Toolbar({ filters, counts, topics, onChange }: Props) {
  const [draft, setDraft] = useState(filters.q);
  useEffect(() => setDraft(filters.q), [filters.q]);
  // Typing updates the list after a short pause instead of on every keystroke.
  useEffect(() => {
    if (draft === filters.q) return;
    const timer = setTimeout(() => onChange({ q: draft.trim() }), 300);
    return () => clearTimeout(timer);
  }, [draft, filters.q, onChange]);

  return (
    <div className="toolbar">
      <Segment label="Story state" value={filters.tab} onSelect={(tab) => onChange({ tab })} options={(Object.keys(TAB_LABEL) as Tab[]).map((tab) => ({ value: tab, text: TAB_LABEL[tab], count: counts?.[tab] }))} />
      <Segment label="Topic" value={filters.topic ?? ""} onSelect={(topic) => onChange({ topic: topic || null })} options={[{ value: "", text: "All" }, ...topics.map((topic) => ({ value: topic.slug, text: topic.name }))]} />
      <input className="search" type="search" aria-label="Search stories" placeholder="Search entity, title or idea" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <div className="sort">
        <span className="sort-label" id="sort-label">sort</span>
        <Segment label="Sort order" value={filters.sort} onSelect={(sort) => onChange({ sort })} options={(Object.keys(SORT_LABEL) as Sort[]).map((sort) => ({ value: sort, text: SORT_LABEL[sort] }))} />
      </div>
    </div>
  );
}
