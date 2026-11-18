import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { StatusPage } from "./status-page";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("filters sources by collection and restores unclassified sources in the full list", async () => {
  const source = { type: "rss", enabled: 1, lastOkAt: null, consecutiveFailures: 0, itemsLastPoll: 0 };
  vi.stubGlobal("fetch", async () => Response.json({
    now: 1, itemsByStatus: [{ status: "extracted", n: 12 }], cards: {}, backlog: [], clusterRuns: [], llm: { models: [] },
    sources: [
      { ...source, id: 1, label: "vLLM Blog", collection: "AI Agents & LLM Engineering" },
      { ...source, id: 2, label: "Legacy feed", collection: null },
    ],
  }));
  const user = userEvent.setup();
  render(<StatusPage timeZone="UTC" />);
  const select = await screen.findByRole("combobox", { name: "Collection" });
  expect(screen.getByText("12 extracted · 0 irrelevant · 0 failed")).toBeTruthy();
  await user.selectOptions(select, "AI Agents & LLM Engineering");
  expect(screen.getByText("vLLM Blog")).toBeTruthy();
  expect(screen.queryByText("Legacy feed")).toBeNull();
  await user.selectOptions(select, "");
  expect(screen.getByText("Legacy feed")).toBeTruthy();
});

it("opens the selected model's request log from its extraction budget", async () => {
  const queries: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    queries.push(path);
    if (path.startsWith("/api/status/llm-calls?")) return Response.json({
      calls: [{ id: 3, at: 1, kind: "extract", status: "ok", httpStatus: 200, latencyMs: 2300, subjects: 5, claimsAccepted: 2, tokensIn: 24, tokensOut: 16, reason: null }],
      nextBefore: null,
    });
    return Response.json({ now: 1, pacificDay: "1970-01-01", sources: [], itemsByStatus: [], cards: {}, backlog: [], clusterRuns: [],
      llm: { models: [{ model: "my/model", rpd: 100 }], usageToday: [{ model: "my/model", kind: "extract", requests: 5 }] } });
  });
  render(<StatusPage timeZone="UTC" />);
  const button = await screen.findByText("View log · extract 5");
  expect(queries).toEqual(["/api/status"]);
  await userEvent.setup().click(button);
  expect(await screen.findByRole("cell", { name: "ok · HTTP 200" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "2.3s" })).toBeTruthy();
  expect(queries).toContain("/api/status/llm-calls?model=my%2Fmodel");
});
