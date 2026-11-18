import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorSession } from "./operator-action";
import { StatusPage } from "./status-page";

const now = Date.UTC(2026, 10, 18, 12) / 1000;
const base = {
  now, pacificDay: "2026-11-18", timezone: "Asia/Ho_Chi_Minh", sources: [], itemsByStatus: [], cards: {}, backlog: [], clusterRuns: [],
  llm: { models: [{ model: "my/model", rpm: null, rpd: null }], unlimited: true, paused: false, usageToday: [] },
};
const emptyLog = { calls: [], nextBefore: null };
const renderPage = () => render(<OperatorSession><StatusPage timeZone="UTC" /></OperatorSession>);
const source = { type: "rss", enabled: 1, lastOkAt: null, consecutiveFailures: 0, itemsLastPoll: 0 };

function mockDashboard(status: object, {
  log = (_query: URLSearchParams) => emptyLog as object,
  live = () => ({ now, activeCalls: [] }) as object,
  control,
}: {
  log?: (query: URLSearchParams) => object;
  live?: () => object;
  control?: (init?: RequestInit) => Response;
} = {}) {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://radar.example");
    paths.push(url.pathname + url.search);
    if (url.pathname === "/api/status") return Response.json(status);
    if (url.pathname === "/api/status/llm-active") return Response.json(live());
    if (url.pathname === "/api/status/llm-calls") return Response.json(log(url.searchParams));
    if (url.pathname === "/api/status/ai-control" && control) return control(init);
    throw new Error("Unexpected request " + url.pathname);
  });
  return paths;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("filters the source table by collection after opening its details", async () => {
  mockDashboard({ ...base, sources: [
    { ...source, id: 1, label: "vLLM Blog", collection: "AI Agents & LLM Engineering" },
    { ...source, id: 2, label: "Legacy feed", collection: null },
  ] });
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByText(/^Nguồn dữ liệu$/i));
  const select = screen.getByRole("combobox", { name: /collection|bộ sưu tập|nhóm nguồn/i });
  await user.selectOptions(select, "AI Agents & LLM Engineering");
  expect(screen.getByRole("cell", { name: "vLLM Blog" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "Legacy feed" })).toBeNull();
  await user.selectOptions(select, "");
  expect(screen.getByRole("cell", { name: "Legacy feed" })).toBeTruthy();
});

it("opens the AI log by default, filters at the server, and pages older filtered calls", async () => {
  const call = { at: now, kind: "extract", httpStatus: 200, latencyMs: 2300, subjects: 5, claimsAccepted: 2, tokensIn: 24, tokensOut: 16, reason: null, retryable: 0 };
  const paths = mockDashboard(base, { log(query) {
    const filter = query.get("filter");
    if (filter === "failed") return query.has("before")
      ? { calls: [{ ...call, id: 6, status: "invalid_output" }], nextBefore: null }
      : { calls: [{ ...call, id: 12, status: "transient" }], nextBefore: 12 };
    if (filter === "active") return { calls: [{ ...call, id: 20, status: "running" }], nextBefore: null };
    return { calls: [{ ...call, id: 31, status: "ok" }], nextBefore: null };
  } });
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText("#31")).toBeTruthy();
  expect(screen.getByText("HTTP 200")).toBeTruthy();
  const time = screen.getByText("#31").closest("li")!.querySelector("time")!;
  expect(time.textContent).toContain("19:00:00"); // status.timezone overrides the supplied UTC fallback
  const select = screen.getByRole("combobox", { name: /lọc nhật ký/i });
  await user.selectOptions(select, "failed");
  expect(await screen.findByText("#12")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /cũ hơn/i }));
  expect(await screen.findByText("#6")).toBeTruthy();
  await user.selectOptions(select, "active");
  expect(await screen.findByText("#20")).toBeTruthy();
  expect(screen.queryByText("#6")).toBeNull();
  expect(paths).toContain("/api/status/llm-active");
  const logQueries = paths.filter(path => path.startsWith("/api/status/llm-calls?")).map(path => {
    const query = new URL(path, "https://radar.example").searchParams;
    return [query.get("model"), query.get("filter") ?? "all", query.get("before")];
  });
  expect(logQueries).toEqual(expect.arrayContaining([
    ["my/model", "all", null], ["my/model", "failed", null], ["my/model", "failed", "12"], ["my/model", "active", null],
  ]));
});

it("authenticates a manual batch of 100 items with an empty log and reports the number actually queued", async () => {
  const actions: { body: unknown; authorization: string | null }[] = [];
  mockDashboard({ ...base, backlog: [{ ingestMode: "live", queued: 43, oldestQueuedAt: now - 30, maxAttempts: 0 }] }, {
    control(init) {
      actions.push({ body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("Authorization") });
      return Response.json({ status: "queued", sent: 43 }, { status: 202 });
    },
  });
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText(/chưa có lượt gọi trong ngày Pacific/i)).toBeTruthy();
  await user.selectOptions(screen.getByRole("combobox", { name: /số bài/i }), "100");
  await user.click(screen.getByRole("button", { name: /chạy 100 bài/i }));
  const dialog = screen.getByRole("dialog");
  expect(actions).toEqual([]);
  await user.type(within(dialog).getByLabelText(/mật khẩu điều khiển/i), "test-password");
  await user.click(within(dialog).getByRole("button", { name: /xác nhận/i }));
  expect(await screen.findByText(/đã xếp 43 bài/i)).toBeTruthy();
  expect(actions).toEqual([{ body: { action: "retry", model: "my/model", limit: 100 }, authorization: "Basic " + btoa("settings:test-password") }]);
});

it("keeps run disabled while paused and refreshes active processing separately after 2.5 seconds", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const paths = mockDashboard({ ...base, llm: { ...base.llm, paused: true }, backlog: [{ ingestMode: "live", queued: 5, oldestQueuedAt: now, maxAttempts: 0 }] }, {
    live: () => ({ now, activeCalls: ++reads === 1 ? [] : [{ id: 9, at: now, model: "my/model", kind: "synthesize", subjects: 1, status: "processing" }] }),
  });
  await act(async () => { renderPage(); });
  expect(screen.getByRole("button", { name: /tiếp tục AI/i })).toBeTruthy();
  expect((screen.getByRole("button", { name: /chạy 10 bài/i }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("region", { name: /^đang xử lý$/i })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  const active = screen.getByRole("region", { name: /^đang xử lý$/i });
  expect(within(active).getByRole("listitem").textContent).toContain("1 câu chuyện");
  expect(within(active).queryByRole("button", { name: /dừng/i })).toBeNull();
  expect(paths.filter(path => path === "/api/status")).toHaveLength(1);
  expect(paths.filter(path => path === "/api/status/llm-active")).toHaveLength(2);
});
