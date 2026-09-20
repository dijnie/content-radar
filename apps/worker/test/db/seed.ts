import type { ItemInput } from "../../src/db/items-repo";

/** Inserts one source and returns its id. */
export async function seedSource(db: D1Database, type: "x" | "hn" | "rss" | "github", key: string): Promise<number> {
  const row = await db
    .prepare("INSERT INTO sources (type, key, label) VALUES (?, ?, ?) RETURNING id")
    .bind(type, key, key)
    .first<{ id: number }>();
  return row!.id;
}

export function itemInput(overrides: Partial<ItemInput> & Pick<ItemInput, "sourceId" | "externalId">): ItemInput {
  return {
    platform: "x",
    url: "https://x.com/someone/status/1",
    canonicalUrl: "https://x.com/someone/status/1",
    authorId: null,
    title: null,
    textExcerpt: "first version",
    lang: "en",
    kind: "post",
    parentExternalId: null,
    publishedAt: 1_790_000_000,
    fetchedAt: 1_790_000_100,
    rawR2Key: null,
    contentHash: "hash-1",
    topicHint: null,
    ingestMode: "live",
    ...overrides,
  };
}
