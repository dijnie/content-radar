import { useCallback, useEffect, useRef, useState } from "react";
import { fetchStories, postAction } from "../api-client";
import { STATE_AFTER, type Filters, type Story, type StoryAction, type StoryListResponse, type Tab } from "../types";

interface State {
  stories: Story[];
  nextCursor: string | null;
  counts: StoryListResponse["counts"] | null;
  topics: StoryListResponse["topics"];
  timezone: string;
  loading: boolean;
  error: string | null;
}

const EMPTY: State = { stories: [], nextCursor: null, counts: null, topics: [], timezone: "UTC", loading: true, error: null };
const tabOf = (state: Story["userState"]): Tab => (state === "inbox" ? "inbox" : state === "dismissed" ? "dismissed" : "saved");

export function useStories(filters: Filters) {
  const [state, setState] = useState<State>(EMPTY);
  const [actionError, setActionError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const { tab, topic, q, sort } = filters;

  const load = useCallback(
    (cursor: string | null) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setState((current) => ({ ...(cursor ? current : { ...current, stories: [] }), loading: true, error: null }));
      fetchStories({ tab, topic, q, sort, view: "stories" }, cursor, controller.signal)
        .then((page) => setState((current) => ({ ...page, stories: cursor ? [...current.stories, ...page.stories] : page.stories, loading: false, error: null })))
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setState((current) => ({ ...current, loading: false, error: err instanceof Error ? err.message : "request failed" }));
        });
    },
    [tab, topic, q, sort],
  );

  useEffect(() => {
    load(null);
    return () => request.current?.abort();
  }, [load]);

  /** Optimistic: the card leaves (or relabels) at once, and comes back if the server refuses. */
  const act = useCallback(
    async (story: Story, action: StoryAction) => {
      const nextState = STATE_AFTER[action];
      const before = state;
      setActionError(null);
      setState((current) => {
        const staysInTab = tabOf(nextState) === tab;
        const stories = staysInTab ? current.stories.map((item) => (item.id === story.id ? { ...item, userState: nextState } : item)) : current.stories.filter((item) => item.id !== story.id);
        const counts = current.counts && { ...current.counts };
        if (counts && tabOf(story.userState) !== tabOf(nextState)) {
          counts[tabOf(story.userState)] = Math.max(0, counts[tabOf(story.userState)] - 1);
          counts[tabOf(nextState)] += 1;
        }
        return { ...current, stories, counts };
      });
      try {
        await postAction(story.id, action);
      } catch {
        setState(before);
        setActionError(`Could not ${action} “${story.label ?? story.headline.slice(0, 40)}”. Nothing was changed.`);
      }
    },
    [state, tab],
  );

  return { ...state, actionError, act, loadMore: () => state.nextCursor && load(state.nextCursor), reload: () => load(null) };
}
