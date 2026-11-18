import { chunkedBatch } from "../db/batch";
import { listDueSources, scheduleNextPoll } from "../db/sources-repo";
import type { Env } from "../env";
import type { PollMessage } from "../llm/messages";

const MAX_SOURCES_PER_TICK = 500;
const SEND_BATCH_SIZE = 100;
/** A dispatched source is not due again for this long, even if its message is lost. */
const IN_FLIGHT_LEASE_SECONDS = 15 * 60;

/** Pushes due sources to `content-radar-poll`. The ledger is updated first, then the wake-ups go out. */
export async function dispatchPolls(env: Pick<Env, "DB" | "POLL_QUEUE">, now: number): Promise<number> {
  const due = await listDueSources(env.DB, now, MAX_SOURCES_PER_TICK);
  if (due.length === 0) return 0;
  await chunkedBatch(env.DB, due.map((source) => scheduleNextPoll(env.DB, source.id, now + IN_FLIGHT_LEASE_SECONDS)));
  for (let start = 0; start < due.length; start += SEND_BATCH_SIZE) {
    const messages = due.slice(start, start + SEND_BATCH_SIZE).map((source) => ({ body: { sourceId: source.id } satisfies PollMessage }));
    await env.POLL_QUEUE.sendBatch(messages);
  }
  return due.length;
}
