import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handleLlmCalls } from "../../src/api/llm-calls-route";
import { budgetedCall } from "../../src/llm/budgeted-call";
import { seedAi } from "../db/seed-ai";

const model = "test/log-model";
const now = Date.UTC(2026, 10, 1, 17, 30) / 1000; // Pacific fall-back day
const read = async (before?: number) => {
  const url = new URL("https://radar.example.com/api/status/llm-calls");
  url.searchParams.set("model", model);
  if (before) url.searchParams.set("before", String(before));
  return (await handleLlmCalls(new Request(url), env, now)).json() as Promise<{ calls: { id: number; status: string; httpStatus: number | null }[]; nextBefore: number | null; day: string }>;
};

describe("AI request log", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM llm_calls WHERE model = ?").bind(model).run(); });
  it("exposes one running attempt before the provider answers and finalizes the same row", async () => {
    await seedAi(env.DB, { model });
    let runningId: number | undefined;
    const result = await budgetedCall(env, { kind: "extract", promptVersion: 1, system: "private prompt", user: "private text", schema: {}, subjectIds: [2, 3] }, {
      now,
      fetcher: async () => {
        const page = await read();
        expect(page.calls).toHaveLength(1);
        runningId = page.calls[0]!.id;
        expect(page.calls[0]).toMatchObject({ status: "running", subjects: 2, latencyMs: null });
        return new Response("private provider body", { status: 400 });
      },
    });
    expect(result.status).toBe("rejected");
    const page = await read();
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]).toMatchObject({ id: runningId, status: "invalid_request", httpStatus: 400 });
    expect(JSON.stringify(page)).not.toContain("private");
  });

  it("separates models and Pacific days, pages older calls, and marks missing outcomes", async () => {
    const start = Date.UTC(2026, 10, 1, 7) / 1000;
    const insert = (at: number, name: string, status: string) => env.DB.prepare(
      "INSERT INTO llm_calls (at, model, kind, status, prompt_version, error) VALUES (?, ?, 'extract', ?, 1, 'private detail')"
    ).bind(at, name, status);
    await env.DB.batch([insert(start - 1, model, "yesterday"), insert(now, "other", "other"),
      insert(start, model, "running"), ...Array.from({ length: 30 }, () => insert(now, model, "ok"))]);
    const page = await read();
    expect(page.day).toBe("2026-11-01");
    expect(page.calls.length).toBe(30);
    const older = await read(page.nextBefore!);
    expect(older.calls).toHaveLength(1);
    expect(older.calls[0]).toMatchObject({ status: "no_final_result" });
    expect(older.nextBefore).toBeNull();
    expect(JSON.stringify(older)).not.toContain("private detail");
  });
});
