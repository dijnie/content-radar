-- Daily soak report. Run once a day during the 7-day soak and paste the output into
-- plans/260920-0838-content-radar-v1/reports/soak-report.md:
--   cd apps/worker && npx wrangler d1 execute content-radar --remote --json --file ../../scripts/soak-report.sql
-- The first block is the very SQL behind GET /api/status (apps/worker/src/api/status-route.ts);
-- a test keeps the two in step.

-- status: sources
SELECT s.id, s.type, s.key, s.label, s.enabled, s.next_poll_at AS nextPollAt, h.last_ok_at AS lastOkAt, h.last_error_at AS lastErrorAt,
                   h.last_error AS lastError, COALESCE(h.consecutive_failures, 0) AS consecutiveFailures, COALESCE(h.items_last_poll, 0) AS itemsLastPoll
            FROM sources s LEFT JOIN source_health h ON h.source_id = s.id
            ORDER BY COALESCE(h.consecutive_failures, 0) DESC, s.type, s.key;
-- status: backlog
SELECT ingest_mode AS ingestMode, COUNT(*) AS queued, MIN(queued_at) AS oldestQueuedAt, MAX(enqueue_attempts) AS maxAttempts
            FROM items WHERE status = 'queued' GROUP BY ingest_mode;
-- status: itemsByStatus
SELECT status, COUNT(*) AS n FROM items GROUP BY status ORDER BY status;
-- status: lastRuns
SELECT id, started_at AS startedAt, finished_at AS finishedAt, status, stage, node_count AS claims, edge_count AS edges, community_count AS communities, error
             FROM cluster_runs ORDER BY id DESC LIMIT 5;
-- status: cards
SELECT COUNT(*) AS alive, SUM(headline_source = 'fallback') AS fallbackHeadlines, SUM(status = 'ready') AS ready, SUM(status = 'lead') AS lead
          FROM stories WHERE alive = 1;
-- status: pendingAdjudications
SELECT status, COUNT(*) AS n FROM entity_adjudications WHERE status != 'decided' GROUP BY status;

-- soak: items per source type per day, and how they ended
SELECT DATE(fetched_at, 'unixepoch') AS day, platform, ingest_mode, status, COUNT(*) AS n
FROM items WHERE fetched_at >= CAST(strftime('%s', 'now') AS INTEGER) - 8 * 86400 GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;
-- soak: live items queued for more than 48 hours (must be empty while quota remains)
SELECT id, platform, queued_at, enqueue_attempts FROM items
WHERE status = 'queued' AND ingest_mode = 'live' AND queued_at < CAST(strftime('%s', 'now') AS INTEGER) - 48 * 3600 ORDER BY queued_at LIMIT 50;
-- soak: Gemini requests per Pacific day, model and kind, against the limit
SELECT u.day_pt, u.model, u.kind, u.requests, m.rpd FROM llm_usage u JOIN llm_models m ON m.model = u.model
WHERE u.day_pt >= DATE('now', '-8 days') ORDER BY u.day_pt, u.model, u.kind;
-- soak: call outcomes per day (quota exhaustion shows as rate_limited; dead letters as dead_letter)
SELECT DATE(at, 'unixepoch') AS day_utc, kind, status, COUNT(*) AS calls, SUM(claims_returned) AS claims_returned, SUM(claims_accepted) AS claims_accepted
FROM llm_calls GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
-- soak: first successful call after each Pacific midnight (07:00 or 08:00 UTC); late first calls hint at a different reset time
SELECT DATE(at, 'unixepoch') AS day_utc, MIN(TIME(at, 'unixepoch')) AS first_ok_utc FROM llm_calls
WHERE status = 'ok' AND CAST(strftime('%H', at, 'unixepoch') AS INTEGER) >= 7 GROUP BY 1 ORDER BY 1;
-- soak: why claims were rejected (watch quote_not_found; above 15% means batches are too large)
SELECT DATE(at, 'unixepoch') AS day_utc, reject_reasons_json, claims_returned, claims_accepted FROM llm_calls
WHERE status = 'ok' AND claims_returned > 0 AND reject_reasons_json != '{}' ORDER BY at DESC LIMIT 40;
-- soak: cluster runs per day
SELECT DATE(started_at, 'unixepoch') AS day_utc, status, COUNT(*) AS runs, ROUND(AVG(finished_at - started_at), 1) AS avg_seconds,
       MAX(node_count) AS max_claims, MAX(edge_count) AS max_edges, MAX(community_count) AS max_stories
FROM cluster_runs GROUP BY 1, 2 ORDER BY 1, 2;
-- soak: lineage stability per finished run (targets: continue >= 85% of matches, under 20% of living stories changing id)
SELECT e.run_id, SUM(e.type = 'continue') AS continues, SUM(e.type IN ('split', 'merge')) AS reshapes, SUM(e.type = 'birth') AS births,
       SUM(e.type = 'death') AS deaths, SUM(e.type = 'revive') AS revives,
       ROUND(100.0 * SUM(e.type = 'continue') / MAX(1, SUM(e.type IN ('continue', 'split', 'merge'))), 1) AS continue_pct
FROM lineage_events e JOIN cluster_runs r ON r.id = e.run_id AND r.status = 'done' GROUP BY e.run_id ORDER BY e.run_id DESC LIMIT 48;
-- soak: how often entity resolution needed the LLM
SELECT resolved_by, COUNT(*) AS mentions FROM entity_mentions GROUP BY resolved_by;
-- soak: hours without a successful poll, per failing source
SELECT type, label, consecutive_failures, last_error, hours_since_ok FROM v_source_health ORDER BY hours_since_ok DESC LIMIT 30;
-- soak: 20 stories for the manual coherence check
SELECT story_id, label_text, headline_vi, status, score, independent_sources, active_claims FROM v_story_cards ORDER BY RANDOM() LIMIT 20;
