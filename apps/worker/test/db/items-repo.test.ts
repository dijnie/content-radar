import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { feedExternalId, getItemsByIds, getItemStates, insertItemLinks, insertMetricSnapshot, touchEnqueued, upsertItem, upsertItemStatement } from "../../src/db/items-repo";
import { itemInput, seedSource } from "./seed";

describe("upsertItem", () => {
  it("does not duplicate an item and never rewrites url, source or publish time", async () => {
    const sourceId = await seedSource(env.DB, "x", "upsert-a");
    const otherSourceId = await seedSource(env.DB, "x", "upsert-b");
    const first = await upsertItem(env.DB, itemInput({ sourceId, externalId: "tweet-100" }));
    const second = await upsertItem(
      env.DB,
      itemInput({
        sourceId: otherSourceId,
        externalId: "tweet-100",
        url: "https://evil.example/redirect",
        publishedAt: 1,
        textExcerpt: "edited version",
        fetchedAt: 1_790_000_900,
      }),
    );

    expect(second.id).toBe(first.id);
    const [row] = await getItemsByIds(env.DB, [first.id]);
    expect(row).toMatchObject({
      url: "https://x.com/someone/status/1",
      source_id: sourceId,
      published_at: 1_790_000_000,
      text_excerpt: "edited version",
      fetched_at: 1_790_000_900,
    });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE external_id = 'tweet-100'").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("writes the ledger state with the row and never reopens finished work", async () => {
    const sourceId = await seedSource(env.DB, "x", "upsert-c");
    const { id, status } = await upsertItem(env.DB, itemInput({ sourceId, externalId: "tweet-200" }));
    expect(status).toBe("queued");
    let [row] = await getItemsByIds(env.DB, [id]);
    expect(row).toMatchObject({ status: "queued", queued_at: 1_790_000_100, enqueue_attempts: 0 });

    await env.DB.prepare("UPDATE items SET status = 'extracted' WHERE id = ?").bind(id).run();
    const again = await upsertItem(env.DB, itemInput({ sourceId, externalId: "tweet-200", fetchedAt: 1_790_009_999 }));
    expect(again.status).toBe("extracted");
    await touchEnqueued(env.DB, id, 1_790_009_999).run();
    [row] = await getItemsByIds(env.DB, [id]);
    expect(row).toMatchObject({ status: "extracted", queued_at: 1_790_000_100, enqueue_attempts: 0 });
  });

  it("stores a filtered item without a queue timestamp", async () => {
    const sourceId = await seedSource(env.DB, "x", "upsert-d");
    const { id } = await upsertItem(env.DB, itemInput({ sourceId, externalId: "tweet-300", status: "filtered_out", filterReason: "repost" }));
    const [row] = await getItemsByIds(env.DB, [id]);
    expect(row).toMatchObject({ status: "filtered_out", filter_reason: "repost", queued_at: null, enqueue_attempts: 0 });
  });

  it("writes an item, its links and its metrics in one batch, idempotently", async () => {
    const sourceId = await seedSource(env.DB, "x", "upsert-e");
    const write = () =>
      env.DB.batch([
        upsertItemStatement(env.DB, itemInput({ sourceId, externalId: "tweet-400" })),
        ...insertItemLinks(env.DB, "x", "tweet-400", ["https://a.example/x", "https://a.example/x", "https://b.example/y"]),
        insertMetricSnapshot(env.DB, "x", { externalId: "tweet-400", capturedAt: 1_790_000_100, likes: 10 }),
      ]);
    await write();
    await write();
    const states = await getItemStates(env.DB, "x", ["tweet-400", "tweet-unknown"]);
    expect([...states.keys()]).toEqual(["tweet-400"]);
    const itemId = states.get("tweet-400")!.id;
    const counts = await env.DB
      .prepare("SELECT (SELECT COUNT(*) FROM item_links WHERE item_id = ?1) AS links, (SELECT COUNT(*) FROM item_metrics WHERE item_id = ?1) AS metrics")
      .bind(itemId)
      .first();
    expect(counts).toEqual({ links: 2, metrics: 1 });
  });

  it("keeps two feeds with the same guid as two items", async () => {
    const feedA = await seedSource(env.DB, "rss", "https://a.example/feed");
    const feedB = await seedSource(env.DB, "rss", "https://b.example/feed");
    const guid = "https://shared.example/post-1";
    const a = await upsertItem(env.DB, itemInput({ sourceId: feedA, platform: "rss", kind: "article", externalId: await feedExternalId(feedA, guid) }));
    const b = await upsertItem(env.DB, itemInput({ sourceId: feedB, platform: "rss", kind: "article", externalId: await feedExternalId(feedB, guid) }));

    expect(a.id).not.toBe(b.id);
    const rows = await getItemsByIds(env.DB, [a.id, b.id]);
    expect(rows.map((row) => row.source_id).sort()).toEqual([feedA, feedB].sort());
  });

  it("loads more ids than one statement can bind", async () => {
    const ids = Array.from({ length: 205 }, (_, i) => 900_000 + i);
    await expect(getItemsByIds(env.DB, ids)).resolves.toEqual([]);
  });
});

describe("CHECK constraints", () => {
  it("reject unknown enum values", async () => {
    const sourceId = await seedSource(env.DB, "x", "check-a");
    await expect(upsertItem(env.DB, itemInput({ sourceId, externalId: "bad-kind", kind: "thread" as never }))).rejects.toThrow(/CHECK/);
    await expect(env.DB.prepare("INSERT INTO sources (type, key, label) VALUES ('reddit', 'r/ai', 'Reddit')").run()).rejects.toThrow(/CHECK/);

    const { id } = await upsertItem(env.DB, itemInput({ sourceId, externalId: "good-kind" }));
    await expect(env.DB.prepare("UPDATE items SET status = 'done' WHERE id = ?").bind(id).run()).rejects.toThrow(/CHECK/);
    await expect(env.DB.prepare("UPDATE items SET ingest_mode = 'replay' WHERE id = ?").bind(id).run()).rejects.toThrow(/CHECK/);
  });
});
