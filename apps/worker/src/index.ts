import { handleBackfill } from "./api/admin-backfill";
import { handleProbe } from "./api/admin-probe";
import { verifyAccess } from "./api/access-auth";
import { guardRequest } from "./api/request-guard";
import type { Env } from "./env";
import { dispatchPolls } from "./ingest/dispatch-polls";
import { consumePollBatch } from "./ingest/poll-consumer";
import type { PollMessage } from "./llm/messages";

const CRON_POLL = "*/30 * * * *";
const QUEUE_POLL = "radar-poll";
const QUEUE_RETRY_DELAY_SECONDS = 300;

export default {
  async fetch(request, env): Promise<Response> {
    // Every request, static assets included, passes authentication and the
    // CSRF guard before any route or asset is served.
    const access = await verifyAccess(request, env);
    if (!access.ok) return Response.json({ error: access.reason }, { status: access.status });

    const rejection = guardRequest(request, env.APP_ORIGIN);
    if (rejection) return rejection;

    const { pathname } = new URL(request.url);
    if (pathname === "/api/admin/probe") return handleProbe(request, env);
    if (pathname === "/api/admin/backfill") return handleBackfill(request, env);
    if (pathname.startsWith("/api/")) return Response.json({ error: "not_found" }, { status: 404 });
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env): Promise<void> {
    const now = Math.floor(controller.scheduledTime / 1000);
    if (controller.cron === CRON_POLL) {
      const dispatched = await dispatchPolls(env, now);
      console.log(JSON.stringify({ event: "dispatch_polls", dispatched }));
      return;
    }
    console.log(JSON.stringify({ event: "scheduled", cron: controller.cron }));
  },

  async queue(batch, env): Promise<void> {
    if (batch.queue === QUEUE_POLL) return consumePollBatch(batch as MessageBatch<PollMessage>, env);
    // No consumer logic exists for the other queues yet; keep messages instead
    // of acknowledging work nobody has done.
    console.log(JSON.stringify({ event: "queue", queue: batch.queue, size: batch.messages.length }));
    batch.retryAll({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
  },
} satisfies ExportedHandler<Env>;
