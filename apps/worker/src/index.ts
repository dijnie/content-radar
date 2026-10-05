import { guardRequest } from "./api/request-guard";
import { routeApi } from "./api/router";
import { runClusterJob } from "./cluster/run-cluster-job";
import type { Env } from "./env";
import { recoverCrawls, startCrawl } from "./jobs/crawl-runs";
import { recoverFeedRuns, runFeedBuild, scheduleFeeds } from "./jobs/feed-runs";
import { drainEditorial } from "./llm/drain-editorial";
import { consumePollBatch } from "./ingest/poll-consumer";
import { consumeDeadLetters } from "./llm/dlq-consumer";
import { drainBacklog } from "./llm/drain-backlog";
import { consumeLlmBatch } from "./llm/llm-consumer";
import type { LlmMessage, PollMessage, PollQueueMessage } from "./llm/messages";
import { runDailyMaintenance } from "./maintenance/run-daily-maintenance";

const CRON_POLL = "*/30 * * * *";
const CRON_CLUSTER = "5 * * * *";
const CRON_MAINTENANCE = "20 8 * * *";
const QUEUE_POLL = "radar-poll";
const QUEUE_LLM = "radar-llm";
const QUEUE_DEAD_LETTER = "radar-dlq";

export default {
  async fetch(request, env): Promise<Response> {
    // Public access: visitors can read and interact without signing in.
    // Browser writes must still originate from the site serving this request.
    const rejection = guardRequest(request);
    if (rejection) return rejection;

    if (new URL(request.url).pathname.startsWith("/api/")) return routeApi(request, env);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env): Promise<void> {
    const now = Math.floor(controller.scheduledTime / 1000);
    if (controller.cron === CRON_POLL) {
      await recoverCrawls(env, now);
      await recoverFeedRuns(env, now);
      const backlog = await drainBacklog(env, now);
      const editorial = await drainEditorial(env, now);
      const crawl = await startCrawl(env, now, "schedule");
      await scheduleFeeds(env, now);
      console.log(JSON.stringify({ event: "poll_tick", crawlId: crawl?.id ?? null, editorial, ...backlog }));
      return;
    }
    if (controller.cron === CRON_CLUSTER) {
      await runClusterJob(env, { now });
      return;
    }
    if (controller.cron === CRON_MAINTENANCE) {
      await runDailyMaintenance(env.DB, now);
      return;
    }
    console.error(JSON.stringify({ event: "unknown_cron", cron: controller.cron }));
  },

  async queue(batch, env): Promise<void> {
    if (batch.queue === (env.POLL_QUEUE_NAME ?? QUEUE_POLL)) {
      for (const message of (batch as MessageBatch<PollQueueMessage>).messages) {
        if ("kind" in message.body && message.body.kind === "build-feed") {
          try { await runFeedBuild(env, message.body.runId); message.ack(); }
          catch (error) {
            console.error(JSON.stringify({ event: "feed_build_failed", runId: message.body.runId, error: String(error) }));
            // The persisted failed build is visible in Jobs; redelivery is harmless.
            message.retry({ delaySeconds: 60 });
          }
        } else {
          await consumePollBatch({ ...batch, messages: [message] } as MessageBatch<PollMessage>, env);
        }
      }
      return;
    }
    if (batch.queue === (env.LLM_QUEUE_NAME ?? QUEUE_LLM)) return consumeLlmBatch(batch as MessageBatch<LlmMessage>, env);
    if (batch.queue === (env.DLQ_QUEUE_NAME ?? QUEUE_DEAD_LETTER)) return consumeDeadLetters(batch as MessageBatch<LlmMessage | PollQueueMessage>, env);
    // An unknown queue means the config and the code disagree; keep the messages.
    console.error(JSON.stringify({ event: "unknown_queue", queue: batch.queue }));
    batch.retryAll({ delaySeconds: 300 });
  },
} satisfies ExportedHandler<Env>;
