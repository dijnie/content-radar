import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { insertClaim, insertMentions, listClaimsForItem, type ClaimInput } from "../../src/db/claims-repo";
import { upsertItem } from "../../src/db/items-repo";
import { itemInput, seedSource } from "./seed";

function claimInput(itemId: number, overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    itemId,
    authorId: null,
    kind: "measurement",
    textVi: "Tác giả đo được độ trễ giảm 40% trên bộ thử nội bộ.",
    textEn: "The author measured a 40% latency drop on an internal benchmark.",
    quote: "latency dropped 40% on our internal benchmark",
    hasNumbers: true,
    firstHand: true,
    topics: ["ai"],
    publishedAt: 1_790_000_000,
    contentHash: "quote-hash-1",
    model: "gemini-3.8-flash",
    promptVersion: 1,
    llmCallId: null,
    createdAt: 1_790_000_500,
    ...overrides,
  };
}

describe("insertClaim", () => {
  it("ignores a replayed claim with the same (item_id, content_hash)", async () => {
    const sourceId = await seedSource(env.DB, "x", "claims-a");
    const { id: itemId } = await upsertItem(env.DB, itemInput({ sourceId, externalId: "claims-tweet-1" }));
    const mentions = [
      { surface: "DeepSeek V4", normalized: "deepseek v4", surfaceType: "model" },
      { surface: "OpenAI", normalized: "openai", surfaceType: "org" },
    ];
    const writeOnce = () =>
      env.DB.batch([insertClaim(env.DB, claimInput(itemId)), ...insertMentions(env.DB, itemId, "quote-hash-1", mentions)]);

    await writeOnce();
    await writeOnce();

    const claims = await listClaimsForItem(env.DB, itemId);
    expect(claims).toHaveLength(1);
    const mentionCount = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM entity_mentions WHERE claim_id = ?")
      .bind(claims[0]!.id)
      .first<{ n: number }>();
    expect(mentionCount?.n).toBe(2);
  });

  it("keeps a different quote on the same item as a separate claim", async () => {
    const sourceId = await seedSource(env.DB, "x", "claims-b");
    const { id: itemId } = await upsertItem(env.DB, itemInput({ sourceId, externalId: "claims-tweet-2" }));
    await env.DB.batch([
      insertClaim(env.DB, claimInput(itemId)),
      insertClaim(env.DB, claimInput(itemId, { contentHash: "quote-hash-2", quote: "throughput doubled" })),
    ]);
    expect(await listClaimsForItem(env.DB, itemId)).toHaveLength(2);
  });

  it("rejects a quote longer than 300 characters and an unknown kind", async () => {
    const sourceId = await seedSource(env.DB, "x", "claims-c");
    const { id: itemId } = await upsertItem(env.DB, itemInput({ sourceId, externalId: "claims-tweet-3" }));
    await expect(insertClaim(env.DB, claimInput(itemId, { quote: "x".repeat(301) })).run()).rejects.toThrow(/CHECK/);
    await expect(insertClaim(env.DB, claimInput(itemId, { kind: "rumour" as never })).run()).rejects.toThrow(/CHECK/);
  });
});
