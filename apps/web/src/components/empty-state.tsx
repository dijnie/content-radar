import type { Filters } from "../types";

export function EmptyState({ filters, onClear }: { filters: Filters; onClear: () => void }) {
  const filtered = filters.q !== "" || filters.topic !== null;
  const message = filtered
    ? "No story matches these filters."
    : filters.tab === "inbox"
      ? "No stories yet. Stories appear after AI processing and clustering."
      : filters.tab === "saved"
        ? "Stories you save or mark as written are kept here."
        : "Dismissed stories are kept here, and can be restored.";
  return (
    <div className="empty" role="status">
      <p>{message}</p>
      {!filtered && filters.tab === "inbox" && <a className="button" href="?view=status">Check processing status</a>}
      {filtered && <button type="button" className="button" onClick={onClear}>Clear filters</button>}
    </div>
  );
}
