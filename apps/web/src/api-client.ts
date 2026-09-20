import type { Filters, StoryAction, StoryListResponse, UserState } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? "request_failed");
  }
  return (await response.json()) as T;
}

export function fetchStories(filters: Filters, cursor: string | null, signal: AbortSignal): Promise<StoryListResponse> {
  const params = new URLSearchParams({ tab: filters.tab, sort: filters.sort });
  if (filters.topic) params.set("topic", filters.topic);
  if (filters.q) params.set("q", filters.q);
  if (cursor) params.set("cursor", cursor);
  return request(`/api/stories?${params}`, { signal });
}

export function postAction(storyId: number, action: StoryAction): Promise<{ id: number; userState: UserState }> {
  // JSON plus a same-origin request is exactly what the Worker's CSRF guard requires.
  return request(`/api/stories/${storyId}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
}

export const fetchStatus = (signal: AbortSignal): Promise<Record<string, unknown>> => request("/api/status", { signal });
