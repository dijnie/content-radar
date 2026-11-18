import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueSynthesisStep } from "../../src/cluster/enqueue-synthesis-step";
import type { ClusterEnv, JobContext } from "../../src/cluster/job-context";
import { runClusterJob } from "../../src/cluster/run-cluster-job";
import type { LlmEnv } from "../../src/llm/budgeted-call";
import { consumeLlmBatch } from "../../src/llm/llm-consumer";
import type { LlmMessage } from "../../src/llm/messages";
import { DEFAULT_PARAMS } from "@radar/core";
import envelope from "../fixtures/deepseek/success-envelope.json";
import { fakeEmbedder, fakeLlmQueue, seedClaims, wipeClusterState } from "./seed-claims";

const HOUR = 3600;
const T0 = Date.UTC(2026, 8, 20, 12, 5, 0) / 1000;

let llm: ReturnType<typeof fakeLlmQueue>;
let clusterEnv: ClusterEnv;
let llmEnv: LlmEnv;

beforeEach(async () => {
  await wipeClusterState(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_usage"), env.DB.prepare("DELETE FROM llm_calls"), env.DB.prepare("DELETE FROM settings WHERE key = 'llm_circuit'"),
    env.DB.prepare("UPDATE llm_models SET rpd = 1000, rpm = 1000, exhausted_until = NULL"),
  ]);
  llm = fakeLlmQueue();
  clusterEnv = { DB: env.DB, LLM_QUEUE: llm.queue };
  llmEnv = { DB: env.DB, RAW: env.RAW, LLM_QUEUE: llm.queue };
});

function deepseekReplying(payload: (prompt: string) => unknown) {
  const prompts: string[] = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const prompt: string = JSON.parse(String(init!.body)).messages[1].content;
    prompts.push(prompt);
    const body = structuredClone(envelope) as typeof envelope;
    body.choices[0]!.message.content = JSON.stringify(payload(prompt));
    return Response.json(body);
  }) as typeof fetch;
  return { fetcher, prompts };
}

async function deliver(messages: LlmMessage[], fetcher: typeof fetch, now: number, attempts = 1): Promise<string[]> {
  const outcomes: string[] = [];
  const batch = { queue: "radar-llm", messages: messages.map((body) => ({ body, attempts, ack: () => outcomes.push("ack"), retry: () => outcomes.push("retry") })) } as unknown as MessageBatch<LlmMessage>;
  await consumeLlmBatch(batch, llmEnv, { now, fetcher });
  return outcomes;
}

const story = (id: number) => env.DB.prepare("SELECT * FROM stories WHERE id = ?").bind(id).first<Record<string, unknown>>();
const ctxAt = (now: number): JobContext => ({ env: clusterEnv, embeddingModel: "test-embedding", db: env.DB, runId: 0, holder: "test", now, params: { ...DEFAULT_PARAMS }, embed: fakeEmbedder().embed, lastDoneRunStartedAt: 0 });

describe("synthesis", () => {
  it("keeps a story eligible for synthesis when quota waits outlast queue retries", async () => {
    await seedClaims(env.DB, [{ tag: "S1", publishedAt: T0 - HOUR }, { tag: "S1", publishedAt: T0 - 2 * HOUR }]);
    await runClusterJob(clusterEnv, { now: T0, embed: fakeEmbedder().embed });
    const messages = llm.sent.splice(0);
    const message = messages[0] as Extract<LlmMessage, { kind: "synthesize" }>;
    expect(message.kind).toBe("synthesize");
    await env.DB.prepare("UPDATE llm_models SET rpm = 0").run();
    const deepseek = deepseekReplying(() => ({}));

    expect(await deliver(messages, deepseek.fetcher, T0 + 60, 6)).toEqual(["ack"]);
    expect(deepseek.prompts).toEqual([]);
    expect(await story(message.storyId)).toMatchObject({ headline_source: "fallback", synthesis_attempts: 0 });

    await env.DB.prepare("UPDATE llm_models SET rpm = 1000").run();
    expect(await enqueueSynthesisStep(ctxAt(T0 + HOUR))).toBe(1);
    expect(llm.sent).toEqual([message]);
  });

  it("writes the headline, roles and questions, ignores a claim that is not in the story, and rescores on a counterpoint", async () => {
    const claimIds = await seedClaims(env.DB, Array.from({ length: 4 }, (_, k) => ({ tag: "S1", publishedAt: T0 - (k + 1) * HOUR })));
    const embedder = fakeEmbedder();
    await runClusterJob(clusterEnv, { now: T0, embed: embedder.embed });
    expect(llm.sent).toEqual([{ kind: "synthesize", storyId: expect.any(Number), membersHash: expect.any(String) }]);
    const message = llm.sent[0] as Extract<LlmMessage, { kind: "synthesize" }>;
    const before = await story(message.storyId);

    const deepseek = deepseekReplying(() => ({
      headline_vi: "Bốn tác giả độc lập cho biết S1 giảm độ trễ trên bộ thử nội bộ của họ.",
      roles: [{ claimId: claimIds[0], role: "evidence" }, { claimId: claimIds[1], role: "counter" }, { claimId: 987_654, role: "evidence" }],
      questions: ["Bộ thử nội bộ gồm những gì?", "Ai đã đo và trên phần cứng nào?", "Kết quả có lặp lại được không?"],
    }));
    expect(await deliver([message], deepseek.fetcher, T0 + 60)).toEqual(["ack"]);

    const after = await story(message.storyId);
    expect(after).toMatchObject({ headline_source: "llm", has_counter: 1, synthesized_hash: before!.members_hash, synthesized_at: T0 + 60, synthesized_sources: 4 });
    expect(String(after!.headline_vi)).toContain("Bốn tác giả");
    expect(JSON.parse(String(after!.questions_json))).toHaveLength(3);
    expect(Number(after!.score)).toBeCloseTo(Number(before!.score) + 10, 1);
    const roles = (await env.DB.prepare("SELECT claim_id, role FROM story_claims WHERE story_id = ? ORDER BY claim_id").bind(message.storyId).all()).results;
    expect(roles).toEqual([{ claim_id: claimIds[0], role: "evidence" }, { claim_id: claimIds[1], role: "counter" }, { claim_id: claimIds[2], role: "unassigned" }, { claim_id: claimIds[3], role: "unassigned" }]);
    // Crawled text reaches the model only inside data tags, addressed by our own ids.
    expect(deepseek.prompts[0]).toContain(`<claim claimId="${claimIds[0]}"`);

    // The next run keeps the LLM headline and the roles, and sees nothing new to synthesise.
    llm.sent.length = 0;
    await runClusterJob(clusterEnv, { now: T0 + HOUR, embed: embedder.embed });
    expect(await story(message.storyId)).toMatchObject({ headline_source: "llm", headline_vi: after!.headline_vi, has_counter: 1 });
    expect(llm.sent).toEqual([]);
  });

  it("does not re-queue a story for a 10% membership change, but does for 30%", async () => {
    const embedder = fakeEmbedder();
    await seedClaims(env.DB, Array.from({ length: 10 }, (_, k) => ({ tag: "S1", publishedAt: T0 - (k + 1) * HOUR, authorKey: "one-voice" })));
    await runClusterJob(clusterEnv, { now: T0, embed: embedder.embed });
    const message = llm.sent[0] as Extract<LlmMessage, { kind: "synthesize" }>;
    const deepseek = deepseekReplying(() => ({ headline_vi: "Một tác giả cho biết S1 có thay đổi đáng chú ý trong tuần này.", roles: [], questions: [] }));
    await deliver([message], deepseek.fetcher, T0 + 60);
    llm.sent.length = 0;

    await seedClaims(env.DB, [{ tag: "S1", publishedAt: T0 + HOUR, authorKey: "one-voice" }]);
    await runClusterJob(clusterEnv, { now: T0 + 7 * HOUR, embed: embedder.embed });
    expect(llm.sent).toEqual([]);

    await seedClaims(env.DB, Array.from({ length: 5 }, (_, k) => ({ tag: "S1", publishedAt: T0 + 2 * HOUR + k, authorKey: "one-voice" })));
    await runClusterJob(clusterEnv, { now: T0 + 14 * HOUR, embed: embedder.embed });
    expect(llm.sent).toEqual([{ kind: "synthesize", storyId: message.storyId, membersHash: expect.any(String) }]);
  });

  it("gives a two-hour-old story a slot even when bigger stories outscore it", async () => {
    await env.DB.prepare("UPDATE llm_models SET rpd = 0").run();
    await env.DB.prepare("UPDATE llm_models SET rpd = 15 WHERE model = 'deepseek-flash'").run(); // 3 synthesis slots today
    const insert = env.DB.prepare("INSERT INTO stories (headline_vi, score, first_seen_at, last_claim_at, members_hash, alive) VALUES ('h', ?, ?, ?, ?, 1) RETURNING id");
    const old: number[] = [];
    for (let n = 0; n < 5; n++) old.push((await insert.bind(90 - n, T0 - 48 * HOUR, T0, `old-${n}`).first<{ id: number }>())!.id);
    const fresh = (await insert.bind(35, T0 - 2 * HOUR, T0, "fresh").first<{ id: number }>())!.id;

    expect(await enqueueSynthesisStep(ctxAt(T0))).toBe(3);
    const chosen = llm.sent.map((message) => (message as { storyId: number }).storyId);
    expect(chosen).toContain(fresh);
    expect(chosen.filter((id) => old.includes(id))).toEqual([old[0], old[1]]);
    expect(await env.DB.prepare("SELECT synthesis_attempts FROM stories WHERE id = ?").bind(fresh).first()).toEqual({ synthesis_attempts: 1 });
  });

  it("queues nothing when the reserved share is used up, even if extraction budget remains", async () => {
    await env.DB.prepare("INSERT INTO stories (headline_vi, score, first_seen_at, last_claim_at, members_hash, alive) VALUES ('h', 80, ?, ?, 'x', 1)").bind(T0, T0).run();
    await env.DB.prepare("UPDATE llm_models SET rpd = 0").run();
    await env.DB.prepare("UPDATE llm_models SET rpd = 10 WHERE model = 'deepseek-flash'").run(); // reserved share: 2
    await env.DB.prepare("INSERT INTO llm_usage (day_pt, model, kind, requests) VALUES ('2026-09-20', 'deepseek-flash', 'adjudicate', 2)").run();
    expect(await enqueueSynthesisStep(ctxAt(T0))).toBe(0);
    expect(llm.sent).toEqual([]);
  });
});

describe("adjudication", () => {
  it("returns undecided entities to pending after prolonged model unavailability", async () => {
    await seedClaims(env.DB, [
      { tag: "M1", publishedAt: T0 - HOUR, entity: "E7 Orion Engine" },
      { tag: "M1", publishedAt: T0 - 2 * HOUR, entity: "E7 Orion Engin" },
    ]);
    const embedder = fakeEmbedder();
    await runClusterJob(clusterEnv, { now: T0, embed: embedder.embed });
    const messages = llm.sent.splice(0);
    expect(messages).toEqual([{ kind: "adjudicate", adjudicationIds: [expect.any(Number)] }]);
    await env.DB.prepare("UPDATE llm_models SET exhausted_until = ?").bind(T0 + 180).run();
    const deepseek = deepseekReplying(() => ({}));

    expect(await deliver(messages, deepseek.fetcher, T0 + 60, 6)).toEqual(["ack"]);
    expect(deepseek.prompts).toEqual([]);
    expect(await env.DB.prepare("SELECT status, decision FROM entity_adjudications").first()).toEqual({ status: "pending", decision: null });

    await runClusterJob(clusterEnv, { now: T0 + HOUR, embed: embedder.embed });
    expect(llm.sent).toEqual(messages);
  });

  it("a 'same' verdict lets two claims that a provisional entity kept apart join one story on the next run", async () => {
    const embedder = fakeEmbedder();
    // Related wording (cosine about 0.64) is not enough to link on its own; a shared entity is.
    const claimIds = await seedClaims(env.DB, [
      { tag: "M1", publishedAt: T0 - HOUR, entity: "E7 Orion Engine" },
      { tag: "M1", publishedAt: T0 - 2 * HOUR, entity: "E7 Orion Engin" },
    ]);
    await runClusterJob(clusterEnv, { now: T0, embed: embedder.embed });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM stories WHERE alive = 1").first()).toEqual({ n: 0 });
    const adjudication = await env.DB.prepare("SELECT id, status, similarity FROM entity_adjudications").first<{ id: number; status: string; similarity: number }>();
    expect(adjudication).toMatchObject({ status: "queued" });
    expect(adjudication!.similarity).toBeGreaterThan(0.75);
    expect(adjudication!.similarity).toBeLessThan(0.92);
    expect(llm.sent).toEqual([{ kind: "adjudicate", adjudicationIds: [adjudication!.id] }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM entities WHERE provisional = 1").first()).toEqual({ n: 1 });

    const deepseek = deepseekReplying(() => ({ decisions: [{ id: adjudication!.id, decision: "same" }] }));
    expect(await deliver(llm.sent.splice(0), deepseek.fetcher, T0 + 60)).toEqual(["ack"]);
    expect(await env.DB.prepare("SELECT status, decision FROM entity_adjudications").first()).toEqual({ status: "decided", decision: "same" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS entities, (SELECT COUNT(DISTINCT entity_id) FROM entity_mentions) AS mentioned, (SELECT COUNT(*) FROM entity_aliases) AS aliases FROM entities").first()).toEqual({ entities: 1, mentioned: 1, aliases: 2 });

    await runClusterJob(clusterEnv, { now: T0 + HOUR, embed: embedder.embed });
    const stories = (await env.DB.prepare("SELECT id FROM stories WHERE alive = 1").all<{ id: number }>()).results;
    expect(stories).toHaveLength(1);
    const members = (await env.DB.prepare("SELECT claim_id FROM story_claims WHERE story_id = ? AND active = 1 ORDER BY claim_id").bind(stories[0]!.id).all()).results;
    expect(members).toEqual(claimIds.map((id) => ({ claim_id: id })));
  });

  it("'version_of' keeps both entities and records the relation; an unusable answer never merges", async () => {
    const embedder = fakeEmbedder();
    await seedClaims(env.DB, [{ tag: "M2", publishedAt: T0 - HOUR, entity: "E8 Nova 4" }, { tag: "M2", publishedAt: T0 - 2 * HOUR, entity: "E8 Nova 4.1" }, { tag: "M3", publishedAt: T0 - HOUR, entity: "E9 Atlas" }, { tag: "M3", publishedAt: T0 - 2 * HOUR, entity: "E9 Atlass" }]);
    await runClusterJob(clusterEnv, { now: T0, embed: embedder.embed });
    const rows = (await env.DB.prepare("SELECT id, mention_normalized FROM entity_adjudications ORDER BY id").all<{ id: number; mention_normalized: string }>()).results;
    expect(rows).toHaveLength(2);
    const nova = rows.find((row) => row.mention_normalized.includes("nova"))!;

    const deepseek = deepseekReplying(() => ({ decisions: [{ id: nova.id, decision: "version_of" }, { id: 424_242, decision: "same" }] }));
    await deliver(llm.sent.filter((message) => message.kind === "adjudicate"), deepseek.fetcher, T0 + 60);

    expect((await env.DB.prepare("SELECT decision FROM entity_adjudications ORDER BY id").all()).results.map((row) => row.decision).sort()).toEqual(["different", "version_of"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM entities WHERE provisional = 1").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM entities").first()).toEqual({ n: 4 });
    expect(await env.DB.prepare("SELECT relation_type FROM entity_relations").first()).toEqual({ relation_type: "version_of" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM entities WHERE parent_entity_id IS NOT NULL").first()).toEqual({ n: 1 });
  });
});
