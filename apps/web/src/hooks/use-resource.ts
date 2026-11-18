import { useCallback, useEffect, useState } from "react";
import { request } from "../api-client";

type ResourceState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

/** Abort stale reads so rapid filter changes cannot replace the current result with an older response. */
export function useResource<T>(path: string, pollMs = 0) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    loading: true,
    error: null,
  });
  const reload = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState((old) => ({ ...old, loading: true, error: null }));

    let timer: number | undefined;
    async function read() {
      try {
        const data = await request<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ data, loading: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState((old) => ({
            data: pollMs ? old.data : null,
            loading: false,
            error: error instanceof Error ? error.message : "Request failed",
          }));
        }
      } finally {
        if (pollMs && !controller.signal.aborted) timer = window.setTimeout(read, pollMs);
      }
    }
    void read();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [path, version, pollMs]);

  return { ...state, reload };
}

export function useSectionQuery(defaults: Record<string, string>) {
  const read = () => {
    const params = new URLSearchParams(window.location.search);
    return Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => [key, params.get(key) ?? fallback]),
    );
  };
  const [query, setQuery] = useState(read);

  useEffect(() => {
    const pop = () => setQuery(read());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  const update = (patch: Record<string, string>) => {
    setQuery((old) => {
      const next = { ...old, page: "1", ...patch };
      const params = new URLSearchParams(window.location.search);

      for (const [key, value] of Object.entries(next)) {
        if (value === defaults[key]) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }

      window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
      return next;
    });
  };

  return [query, update] as const;
}
