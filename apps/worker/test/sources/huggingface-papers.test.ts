import { describe, expect, it } from "vitest";
import { pollHuggingfacePapers } from "../../src/sources/huggingface-papers";
import type { AdapterContext } from "../../src/sources/source-adapter";

const now = Date.UTC(2026, 8, 21) / 1000;
const paper = { paper: { id: "2609.12345", title: "An architecture study", summary: "The authors measured performance on an open benchmark.", publishedAt: "2026-09-20T12:00:00Z", authors: [{ name: "Researcher" }], upvotes: 12 }, numComments: 3 };
const context = (response: unknown) => ({ now, fetchJson: async () => response }) as unknown as AdapterContext;

describe("Hugging Face Papers", () => {
  it("preserves public abstract provenance and measured engagement with source-scoped ids", async () => {
    const result = await pollHuggingfacePapers(1, context([paper]));
    expect(result.items[0]).toMatchObject({ title: paper.paper.title, summaryOnly: true, links: ["https://arxiv.org/abs/2609.12345"], url: "https://huggingface.co/papers/2609.12345", author: { displayName: "Researcher" } });
    expect(result.metrics[0]).toMatchObject({ points: 12, comments: 3 });
    const other = await pollHuggingfacePapers(2, context([paper]));
    expect(other.items[0]!.externalId).not.toBe(result.items[0]!.externalId);
  });
  it("leaves unreported metrics unknown and rejects malformed upstream payloads", async () => {
    const result = await pollHuggingfacePapers(1, context([{ paper: { ...paper.paper, upvotes: undefined } }]));
    expect(result.metrics[0]).toMatchObject({ points: null, comments: null });
    await expect(pollHuggingfacePapers(1, context({ error: "unavailable" }))).rejects.toThrow("invalid_response");
    await expect(pollHuggingfacePapers(1, context([{ paper: { ...paper.paper, publishedAt: "not-a-date" } }]))).rejects.toThrow("no_valid_recent_items");
  });
});
