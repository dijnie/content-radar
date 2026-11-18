import { useCallback, useEffect, useState } from "react";
import type { Filters, Sort, Tab } from "../types";

const TABS: readonly Tab[] = ["inbox", "saved", "dismissed"];
const VIEWS: readonly Filters["view"][] = ["stories", "status", "news", "hands-on", "deep-dives", "jobs", "settings"];

export function parseFilters(search: string): Filters {
  const params = new URLSearchParams(search);
  const tab = params.get("tab") as Tab;
  return {
    tab: TABS.includes(tab) ? tab : "inbox",
    topic: params.get("topic") || null,
    q: params.get("q") ?? "",
    sort: (params.get("sort") as Sort) === "newest" ? "newest" : "score",
    view: VIEWS.includes(params.get("view") as Filters["view"]) ? params.get("view") as Filters["view"] : "stories",
  };
}

export function serializeFilters(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.view !== "stories") params.set("view", filters.view);
  if (filters.tab !== "inbox") params.set("tab", filters.tab);
  if (filters.topic) params.set("topic", filters.topic);
  if (filters.q) params.set("q", filters.q);
  if (filters.sort !== "score") params.set("sort", filters.sort);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Filters live in the URL, so a reload or a shared link restores the same view. */
export function useUrlState(): [Filters, (patch: Partial<Filters>) => void] {
  const [filters, setFilters] = useState(() => parseFilters(window.location.search));
  useEffect(() => {
    const onPop = () => setFilters(parseFilters(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const update = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => {
      const next = { ...current, ...patch };
      window.history.replaceState(null, "", `${window.location.pathname}${serializeFilters(next)}`);
      return next;
    });
  }, []);
  return [filters, update];
}
