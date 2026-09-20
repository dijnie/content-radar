import type { Filters } from "../types";

export function EmptyState({ filters, onClear }: { filters: Filters; onClear: () => void }) {
  const filtered = filters.q !== "" || filters.topic !== null;
  const message = filtered
    ? "No story matches these filters."
    : filters.tab === "inbox"
      ? "Nothing to review yet. New stories appear after the hourly clustering run."
      : filters.tab === "saved"
        ? "Stories you save or mark as written are kept here."
        : "Dismissed stories are kept here, and can be restored.";
  return (
    <div className="empty" role="status">
      <p>{message}</p>
      {filtered && <button type="button" className="button" onClick={onClear}>Clear filters</button>}
    </div>
  );
}
