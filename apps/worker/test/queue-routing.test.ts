import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { upsertItem } from "../src/db/items-repo";
import worker from "../src/index";
import { itemInput, seedSource } from "./db/seed";

const configured = { ...env, POLL_QUEUE_NAME: "custom-poll", LLM_QUEUE_NAME: "custom-llm", DLQ_QUEUE_NAME: "custom-dlq" };

function batch(queue: string, body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  const retryAll = vi.fn();
  const messages = [{ body, attempts: 1, ack, retry }];
  return { input: { queue, messages, retryAll } as unknown as MessageBatch, ack, retry, retryAll };
}

describe("queue names supplied by deployment setup", () => {
  it("routes renamed poll and LLM queues to their consumers", async () => {
    // Nonexistent subjects are acknowledged by the actual consumers without external calls.
    for (const [name, body] of [["custom-poll", { sourceId: -1 }], ["custom-llm", { kind: "extract", itemId: -1 }]] as const) {
      const message = batch(name, body);
      await worker.queue(message.input, configured);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(message.retryAll).not.toHaveBeenCalled();
    }
  });

  it("routes renamed dead letters and records failed extraction", async () => {
    const sourceId = await seedSource(env.DB, "x", "queue-routing-source");
    const result = await upsertItem(env.DB, itemInput({ sourceId, externalId: "queue-routing-item" }));
    const message = batch("custom-dlq", { kind: "extract", itemId: result.id });
    await worker.queue(message.input, configured);
    expect(await env.DB.prepare("SELECT status, filter_reason FROM items WHERE id = ?").bind(result.id).first()).toEqual({ status: "failed", filter_reason: "dead_letter" });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retryAll).not.toHaveBeenCalled();
  });

  it("retries a queue whose name no longer matches configuration", async () => {
    const message = batch("radar-poll", { sourceId: -1 });
    await worker.queue(message.input, configured);
    expect(message.retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(message.ack).not.toHaveBeenCalled();
  });
});
