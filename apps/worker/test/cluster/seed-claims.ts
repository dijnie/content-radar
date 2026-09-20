import type { EmbedFn } from "../../src/cluster/embedding-client";
import { EMBEDDING_DIMS } from "../../src/cluster/vector-store";
import type { LlmMessage } from "../../src/llm/messages";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function randomVector(seed: number, scale = 1): Float32Array {
  const random = mulberry32(seed);
  return Float32Array.from({ length: EMBEDDING_DIMS }, () => (random() * 2 - 1) * scale);
}

/**
 * Test-only stand-in for Workers AI. Text starting with a tag such as "S3 " lands
 * near that tag's direction, so claims of one story are close and everything
 * else is near-orthogonal. The same text always gives the same vector.
 */
export function fakeEmbedder(): { embed: EmbedFn; texts: string[] } {
  const texts: string[] = [];
  const embed: EmbedFn = async (input) =>
    input.map((text) => {
      texts.push(text);
      const tag = /^(S\d+)\s/.exec(text)?.[1];
      if (!tag) return randomVector(hash(text));
      const base = randomVector(hash(tag));
      const noise = randomVector(hash(text), 0.15);
      return base.map((value, index) => value + noise[index]!);
    });
  return { embed, texts };
}

export function fakeLlmQueue() {
  const sent: LlmMessage[] = [];
  const queue = {
    send: async (body: LlmMessage) => void sent.push(body),
    sendBatch: async (messages: Iterable<{ body: LlmMessage }>) => void sent.push(...[...messages].map((message) => message.body)),
  } as unknown as Queue<LlmMessage>;
  return { queue, sent };
}

export interface SeedClaim {
  /** Story tag such as "S1", or null for an isolated claim. */
  tag: string | null;
  publishedAt: number;
  authorKey?: string;
  entity?: string;
  hasNumbers?: boolean;
}

let sequence = 0;

/** Inserts one item and one claim per spec, each by its own author unless told otherwise. Returns claim ids in order. */
export async function seedClaims(db: D1Database, specs: readonly SeedClaim[]): Promise<number[]> {
  const run = ++sequence;
  const source = await db.prepare("INSERT INTO sources (type, key, label) VALUES ('x', ?, 'seed') RETURNING id").bind(`cluster-seed-${run}-${Date.now()}`).first<{ id: number }>();
  const ids: number[] = [];
  for (const [n, spec] of specs.entries()) {
    const authorKey = spec.authorKey ?? `seed-author-${run}-${n}`;
    const author = await db.prepare("INSERT INTO authors (author_key, canonical_name) VALUES (?1, ?1) ON CONFLICT(author_key) DO UPDATE SET canonical_name = canonical_name RETURNING id").bind(authorKey).first<{ id: number }>();
    const item = await db
      .prepare(
        `INSERT INTO items (source_id, platform, external_id, url, canonical_url, author_id, text_excerpt, kind, published_at, fetched_at, content_hash, status)
         VALUES (?, 'x', ?, ?, ?, ?, 'seed', 'post', ?, ?, 'h', 'extracted') RETURNING id`,
      )
      .bind(source!.id, `seed-${run}-${n}`, `https://x.com/a/status/${run}${n}`, `https://x.com/a/status/${run}${n}`, author!.id, spec.publishedAt, spec.publishedAt)
      .first<{ id: number }>();
    const label = spec.tag ?? `ISO${run}x${n}`;
    const claim = await db
      .prepare(
        `INSERT INTO claims (item_id, author_id, kind, text_vi, text_en, quote, has_numbers, first_hand, topics_json, published_at, content_hash, derivation_reason, model, prompt_version, created_at)
         VALUES (?, ?, 'report', ?, ?, ?, ?, 0, '["ai"]', ?, ?, NULL, 'test', 1, ?) RETURNING id`,
      )
      .bind(item!.id, author!.id, `Nhận định ${label} số ${n} của tác giả ${authorKey}.`, `${label} claim ${n} of run ${run} about the subject`, `quote ${run}-${n}`, spec.hasNumbers ? 1 : 0, spec.publishedAt, `seed-${run}-${n}`, spec.publishedAt)
      .first<{ id: number }>();
    if (spec.entity) {
      await db.prepare("INSERT INTO entity_mentions (claim_id, surface, normalized, surface_type) VALUES (?, ?, ?, 'product')").bind(claim!.id, spec.entity, spec.entity.toLowerCase()).run();
    }
    ids.push(claim!.id);
  }
  return ids;
}

export async function wipeClusterState(db: D1Database): Promise<void> {
  await db.batch(
    ["user_actions", "story_daily", "lineage_events", "story_claims", "run_members", "run_communities", "cluster_runs", "job_leases", "claim_edges", "claim_embeddings",
     "entity_adjudications", "entity_mentions", "entity_embeddings", "entity_aliases", "entity_relations", "entity_daily", "claims", "stories", "entities", "item_metrics", "item_links", "items"]
      .map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
}
