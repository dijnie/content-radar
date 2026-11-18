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
