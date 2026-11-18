import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorialEntry, EditorialFeedResponse, JobsResponse } from "../../../../../packages/core/src/editorial-types";
import { App } from "../../app";

const entry: EditorialEntry = { key: "item:1", category: "deep-dives", pillar: "architecture", title: "A technical report", summary: "A source-grounded summary.", question: "Which setup was measured?", findings: ["Measured under a specified setup."], score: 70, publishedAt: 1790000000,
  sources: [{ itemId: 1, url: "https://example.com/paper", title: "Original paper", source: "Papers", author: "Research team", platform: "rss", publishedAt: 1790000000 }], voices: 1, labLeaders: null, interactions: null, platforms: 1, articles: 1, repository: null, scoreParts: {}, read: false };
const payload: EditorialFeedResponse = { feed: "deep-dives", publication: { runId: 2, crawlId: 1, publishedAt: 1790000000, total: 7 }, entries: [entry], total: 7, eligible: 7, page: 1, pageSize: 6, counts: { toolbox: 7, "field-tests": 0, playbooks: 0, month1: 7, month2: 7, month3: 7, unread: 7, read: 0 }, pillars: ["architecture"], threshold: 55, timezone: "UTC", scoring: {}, awaitingEditorial: 0 };
const calls: { path: string; body: unknown }[] = [];
beforeEach(() => { calls.length = 0; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function serve(feed: string, actionStatus = 200) {
  window.history.replaceState(null, "", `/?view=${feed}`);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (init?.method === "POST") return Response.json(actionStatus === 200 ? { key: entry.key, read: true } : { error: "internal_error" }, { status: actionStatus });
    return Response.json({ ...payload, feed, entries: [{ ...entry, category: feed === "hands-on" ? "toolbox" : feed }] });
  });
}

describe("editorial pages", () => {
  it("loads News alone, changes the date window, and exposes actual sources", async () => {
    serve("news");
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole("heading", { name: entry.title });
    expect(calls.every((call) => call.path.startsWith("/api/feeds/news"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Last 7d" }));
    await waitFor(() => expect(calls.at(-1)!.path).toContain("window=7d"));
    expect(window.location.search).toContain("window=7d");
    await screen.findByRole("heading", { name: entry.title });
    await user.click(screen.getByText("details"));
    expect(screen.getByRole("link", { name: /Original paper/ }).getAttribute("href")).toBe("https://example.com/paper");
  });
  it("changes Hands-on categories and paginates without losing the category", async () => {
    serve("hands-on");
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole("heading", { name: entry.title });
    await user.click(screen.getByRole("button", { name: /Field tests/ }));
    await waitFor(() => expect(calls.at(-1)!.path).toContain("category=field-tests"));
    await screen.findByRole("button", { name: "Next page" });
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(calls.at(-1)!.path).toContain("page=2"));
    expect(calls.at(-1)!.path).toContain("category=field-tests");
  });
  it("posts read state and retains the card with an error when persistence fails", async () => {
    serve("deep-dives", 500);
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole("heading", { name: entry.title });
    await user.click(screen.getByRole("button", { name: "Mark as read" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not save");
    expect(screen.getByRole("heading", { name: entry.title })).toBeTruthy();
    expect(calls.find((call) => call.path.endsWith("/read"))?.body).toEqual({ key: "item:1", read: true });
    await user.selectOptions(screen.getByRole("combobox", { name: "pillar" }), "architecture");
    await waitFor(() => expect(calls.at(-1)!.path).toContain("pillar=architecture"));
    await user.click(screen.getByRole("button", { name: /Last 3 months/ }));
    await waitFor(() => expect(calls.at(-1)!.path).toContain("months=3"));
  });
  it("refreshes an open crawl and replaces the Run confirmation with its current state", async () => {
    window.history.replaceState(null, "", "/?view=jobs");
    vi.useFakeTimers();
    let complete = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ id: 8, created: true });
      if (String(input).endsWith("/crawl/8")) return Response.json({ run: {}, sources: [
        { label: "Example feed", type: "rss", status: complete ? "ok" : "running", itemsNew: complete ? 12 : 0, attempts: 1, error: null },
      ] });
      return Response.json({ crawls: [{ id: 8, kind: "crawl", status: complete ? "ok" : "running", startedAt: 1790000000,
        sources: 2, sourcesProcessed: complete ? 2 : 1, sourcesRunning: complete ? 0 : 1, failures: 0, posts: 0, articles: 0 }],
        builds: [], schedules: [], total: 1, page: 1, pageSize: 30, timezone: "UTC" });
    });
    try {
      await act(async () => { render(<App />); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Run" })); });
      expect(screen.getByRole("status").textContent).toContain("Crawl #8 · running");
      const details = screen.getByText("crawl #8").closest("details")!;
      await act(async () => { details.open = true; fireEvent(details, new Event("toggle")); });
      expect(screen.getByRole("cell", { name: "running" })).toBeTruthy();
      expect(screen.getByRole("progressbar").getAttribute("value")).toBe("1");
      complete = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByRole("status").textContent).toContain("Crawl #8 · ok");
      expect(screen.getByRole("progressbar").getAttribute("value")).toBe("2");
      expect(screen.getByRole("cell", { name: "12" })).toBeTruthy();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
  it("starts a real Jobs request and independently builds a feed from the selected crawl", async () => {
    window.history.replaceState(null, "", "/?view=jobs");
    const jobs: JobsResponse = { crawls: [{ id: 4, kind: "crawl", status: "ok", trigger: "manual", startedAt: 1790000000, finishedAt: 1790000060, crawlId: null, sources: 2, sourcesProcessed: 2, sourcesRunning: 0, failures: 0, posts: 8, articles: 3, itemsNew: 5, entries: 0, stagedEntries: 0, error: null }], builds: [], schedules: [], total: 1, page: 1, pageSize: 30, timezone: "UTC" };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : null }); return Response.json(init?.method === "POST" ? { id: 5, created: true } : jobs); });
    const user = userEvent.setup(); render(<App />);
    await screen.findByText("crawl #4");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/api/jobs/crawls")).toBe(true));
    await user.selectOptions(screen.getByRole("combobox", { name: "Build from crawl" }), "4");
    await user.click(screen.getByRole("button", { name: "Build News" }));
    await waitFor(() => expect(calls.find((call) => call.path === "/api/jobs/feeds/news")?.body).toEqual({ crawlId: 4 }));
  });
});
