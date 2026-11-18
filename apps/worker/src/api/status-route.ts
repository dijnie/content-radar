import { getSetting } from "../db/settings-repo";
import { listEnabledModels } from "../db/llm-repo";
import { nowSeconds } from "../db/batch";
import type { Env } from "../env";
import { limitsOf } from "../llm/budget-ledger";
import { circuitOpenUntil } from "../llm/circuit-breaker";
import { loadBudgetSettings } from "../llm/model-chain";
import { pacificDay } from "../llm/pacific-day";

/** Named queries behind the status page; the soak report runs the very same SQL. */
export const STATUS_QUERIES = {
  sources: `SELECT s.id, s.type, s.key, s.label, s.collection, s.enabled, s.next_poll_at AS nextPollAt, h.last_ok_at AS lastOkAt, h.last_error_at AS lastErrorAt,
                   h.last_error AS lastError, COALESCE(h.consecutive_failures, 0) AS consecutiveFailures, COALESCE(h.items_last_poll, 0) AS itemsLastPoll
            FROM sources s LEFT JOIN source_health h ON h.source_id = s.id
            ORDER BY COALESCE(h.consecutive_failures, 0) DESC, s.type, s.key`,
  backlog: `SELECT ingest_mode AS ingestMode, COUNT(*) AS queued, MIN(queued_at) AS oldestQueuedAt, MAX(enqueue_attempts) AS maxAttempts
            FROM items WHERE status = 'queued' GROUP BY ingest_mode`,
  itemsByStatus: "SELECT status, COUNT(*) AS n FROM items GROUP BY status ORDER BY status",
  usageToday: "SELECT model, kind, requests, tokens_in AS tokensIn, tokens_out AS tokensOut FROM llm_usage WHERE day_pt = ?1 ORDER BY model, kind",
  lastRuns: `SELECT id, started_at AS startedAt, finished_at AS finishedAt, status, stage, node_count AS claims, edge_count AS edges, community_count AS communities, error
             FROM cluster_runs ORDER BY id DESC LIMIT 5`,
  cards: `SELECT COUNT(*) AS alive, SUM(headline_source = 'fallback') AS fallbackHeadlines, SUM(status = 'ready') AS ready, SUM(status = 'lead') AS lead
          FROM stories WHERE alive = 1`,
  pendingAdjudications: "SELECT status, COUNT(*) AS n FROM entity_adjudications WHERE status != 'decided' GROUP BY status",
} as const;

export async function handleStatus(env: Pick<Env, "DB">, now = nowSeconds()): Promise<Response> {
  const db = env.DB;
  const day = pacificDay(now);
  const all = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).all<T>()).results;
  const settings = await loadBudgetSettings(db);
  const models = (await listEnabledModels(db)).map((model) => ({
    model: model.model, priority: model.priority, ...(settings.unlimited ? { rpm: null, rpd: null } : limitsOf(model, settings)), limitsAreDefaults: model.rpd === null, exhaustedUntil: model.exhausted_until,
  }));

  return Response.json({
    now, pacificDay: day,
    sources: await all(STATUS_QUERIES.sources),
    backlog: await all(STATUS_QUERIES.backlog),
    itemsByStatus: await all(STATUS_QUERIES.itemsByStatus),
    llm: { models, paused: (await getSetting<boolean>(db, "ai_processing_paused")) === true, unlimited: settings.unlimited, usageToday: await all(STATUS_QUERIES.usageToday, day), circuitOpenUntil: await circuitOpenUntil(db, now), reservedShare: settings.synthesisReservedShare },
    clusterRuns: await all(STATUS_QUERIES.lastRuns),
    cards: await db.prepare(STATUS_QUERIES.cards).first(),
    pendingAdjudications: await all(STATUS_QUERIES.pendingAdjudications),
  });
}
