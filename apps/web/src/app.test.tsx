import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import { parseFilters, serializeFilters } from "./hooks/use-url-state";
import type { Story, StoryListResponse } from "./types";

const story = (id: number, label: string): Story => ({
  id, label, headline: `Headline ${label}`, headlineSource: "llm", status: "lead", score: 60 + id, independentSources: 1, questions: [], hasCounter: false,
  topics: ["ai"], userState: "inbox", alive: true, lastClaimAt: 1_790_000_000, claims: [], claimCount: 0, links: [],
});
const page = (stories: Story[]): StoryListResponse => ({ stories, nextCursor: null, counts: { inbox: stories.length, saved: 1, dismissed: 0 }, topics: [{ slug: "ai", name: "AI" }, { slug: "backend", name: "Backend" }], timezone: "UTC" });

let actionStatus = 200;
const requests: string[] = [];

beforeEach(() => {
  actionStatus = 200;
  requests.length = 0;
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") return new Response(JSON.stringify(actionStatus === 200 ? { id: 1, userState: "saved" } : { error: "story_not_found" }), { status: actionStatus });
    return new Response(JSON.stringify(page([story(1, "alpha"), story(2, "beta")])));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("removes a saved card at once, moves the tab counts, and posts JSON", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "alpha" });
    expect(screen.getByRole("button", { name: /Ready · Lead\s*2/ })).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "Save" })[0]!);
    expect(screen.queryByRole("heading", { name: "alpha" })).toBeNull();
    expect(screen.getByRole("button", { name: /Ready · Lead\s*1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Saved\s*2/ })).toBeTruthy();
    await waitFor(() => expect(requests).toContain("POST /api/stories/1/action"));
  });

  it("puts the card back and says so when the server refuses the action", async () => {
    actionStatus = 404;
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "alpha" });
    await user.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);

    expect((await screen.findByRole("alert")).textContent).toContain("Nothing was changed");
    expect(screen.getByRole("heading", { name: "alpha" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ready · Lead\s*2/ })).toBeTruthy();
  });

  it("keeps filters in the URL and sends them to the API", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "alpha" });
    await user.click(screen.getByRole("button", { name: "Backend" }));
    await user.click(screen.getByRole("button", { name: "Newest" }));
    await user.type(screen.getByRole("searchbox"), "deepseek");

    await waitFor(() => expect(window.location.search).toBe("?topic=backend&q=deepseek&sort=newest"));
    await waitFor(() => expect(requests.at(-1)).toBe("GET /api/stories?tab=inbox&sort=newest&topic=backend&q=deepseek"));
    expect(screen.getByText("Newest first.")).toBeTruthy();
  });

  it("round-trips filters through the URL and ignores junk", () => {
    const filters = parseFilters("?tab=saved&topic=ai&q=a%20b&sort=newest");
    expect(filters).toEqual({ tab: "saved", topic: "ai", q: "a b", sort: "newest", view: "stories" });
    expect(parseFilters(serializeFilters(filters))).toEqual(filters);
    expect(parseFilters("?tab=hacked&sort=1")).toMatchObject({ tab: "inbox", sort: "score" });
    expect(serializeFilters(parseFilters(""))).toBe("");
  });
});
