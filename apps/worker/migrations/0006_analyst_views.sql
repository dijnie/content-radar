-- Read-only views for analyst sessions. Story views use only active memberships
-- and only events of finished cluster runs. Every row carries keys that lead
-- back to evidence URLs through v_story_evidence.

CREATE VIEW v_story_cards AS
SELECT s.id AS story_id, s.label_text, s.headline_vi, s.headline_source, s.status, s.score, s.subscores_json,
       s.independent_sources, s.has_counter, s.topics_json, s.user_state, s.first_seen_at, s.last_claim_at,
       (SELECT COUNT(*) FROM story_claims sc WHERE sc.story_id = s.id AND sc.active = 1) AS active_claims
FROM stories s
WHERE s.alive = 1;

CREATE VIEW v_story_evidence AS
SELECT sc.story_id, c.id AS claim_id, sc.role, c.kind, c.text_vi, c.quote, c.has_numbers, c.first_hand,
       a.canonical_name AS author, i.platform, i.url, c.published_at,
       c.derived_from_claim_id, c.derivation_reason, c.model, c.prompt_version, i.id AS item_id
FROM story_claims sc
JOIN claims c ON c.id = sc.claim_id
JOIN items i ON i.id = c.item_id
LEFT JOIN authors a ON a.id = c.author_id
WHERE sc.active = 1;

-- Last 7 days against the weekly average of the 21 days before. Entities with
-- fewer than 5 claims in the 28 days are left out: a ratio on 1 or 2 claims is noise.
CREATE VIEW v_entity_momentum AS
WITH clock AS (SELECT CAST(strftime('%s', 'now') AS INTEGER) AS now),
counts AS (
  SELECT em.entity_id,
         COUNT(DISTINCT CASE WHEN c.published_at >= clock.now - 7 * 86400 THEN c.id END) AS claims_7d,
         COUNT(DISTINCT CASE WHEN c.published_at >= clock.now - 7 * 86400 THEN c.author_id END) AS authors_7d,
         COUNT(DISTINCT CASE WHEN c.published_at < clock.now - 7 * 86400 THEN c.id END) AS claims_prev_21d
  FROM entity_mentions em JOIN claims c ON c.id = em.claim_id, clock
  WHERE em.entity_id IS NOT NULL AND c.published_at >= clock.now - 28 * 86400
  GROUP BY em.entity_id
)
SELECT e.id AS entity_id, e.canonical_name, e.type, counts.claims_7d, counts.authors_7d, counts.claims_prev_21d,
       ROUND(counts.claims_prev_21d / 3.0, 2) AS weekly_baseline,
       ROUND(counts.claims_7d / MAX(counts.claims_prev_21d / 3.0, 1.0), 2) AS ratio
FROM counts JOIN entities e ON e.id = counts.entity_id
WHERE e.provisional = 0 AND counts.claims_7d + counts.claims_prev_21d >= 5;

CREATE VIEW v_story_momentum AS
WITH counts AS (
  SELECT story_id,
         SUM(CASE WHEN day >= DATE('now', '-6 days') THEN claim_count ELSE 0 END) AS claims_7d,
         SUM(CASE WHEN day >= DATE('now', '-6 days') THEN source_count ELSE 0 END) AS source_days_7d,
         SUM(CASE WHEN day < DATE('now', '-6 days') THEN claim_count ELSE 0 END) AS claims_prev_21d
  FROM story_daily WHERE day >= DATE('now', '-27 days') GROUP BY story_id
)
SELECT s.id AS story_id, s.label_text, s.headline_vi, s.status, s.score, counts.claims_7d, counts.source_days_7d, counts.claims_prev_21d,
       ROUND(counts.claims_7d / MAX(counts.claims_prev_21d / 3.0, 1.0), 2) AS ratio
FROM counts JOIN stories s ON s.id = counts.story_id
WHERE s.alive = 1 AND counts.claims_7d + counts.claims_prev_21d >= 3;

CREATE VIEW v_lineage_recent AS
SELECT e.id AS event_id, e.at, e.type, e.story_id, s.label_text, s.headline_vi,
       e.related_story_id, r.label_text AS related_label_text, e.jaccard, e.run_id
FROM lineage_events e
JOIN cluster_runs run ON run.id = e.run_id AND run.status = 'done'
JOIN stories s ON s.id = e.story_id
LEFT JOIN stories r ON r.id = e.related_story_id
WHERE e.type != 'continue' AND e.at >= CAST(strftime('%s', 'now') AS INTEGER) - 14 * 86400;

-- Three deterministic rules. `subject_kind` and `subject_id` say where to look next.
CREATE VIEW v_anomaly_candidates AS
WITH clock AS (SELECT CAST(strftime('%s', 'now') AS INTEGER) AS now),
latest AS (
  SELECT i.id AS item_id, i.author_id, i.platform, i.url, i.published_at,
         (COALESCE(m.likes, 0) + 2 * COALESCE(m.reposts, 0) + COALESCE(m.replies, 0) + 2 * COALESCE(m.quotes, 0) + COALESCE(m.points, 0) + COALESCE(m.comments, 0)) AS engagement
  FROM items i JOIN item_metrics m ON m.item_id = i.id, clock
  WHERE i.kind != 'repost' AND i.published_at >= clock.now - 7 * 86400
    AND m.captured_at = (SELECT MAX(captured_at) FROM item_metrics WHERE item_id = i.id)
)
SELECT 'engagement_spike' AS rule, 'item' AS subject_kind, latest.item_id AS subject_id, a.canonical_name AS label, latest.url AS url,
       ROUND((latest.engagement / MAX(0.25, MIN(1.0, (clock.now - latest.published_at) / 86400.0)) - b.median)
             / MAX(1.4826 * b.mad, MAX(1.0, b.median * 0.1)), 2) AS strength,
       latest.published_at AS at
FROM latest JOIN author_baselines b ON b.author_id = latest.author_id AND b.platform = latest.platform AND b.metric = 'engagement'
JOIN authors a ON a.id = latest.author_id, clock
WHERE b.sample_size >= 10 AND clock.now - latest.published_at >= 3 * 3600
  AND (latest.engagement / MAX(0.25, MIN(1.0, (clock.now - latest.published_at) / 86400.0)) - b.median)
      / MAX(1.4826 * b.mad, MAX(1.0, b.median * 0.1)) > 3
UNION ALL
SELECT 'new_entity_many_authors', 'entity', e.id, e.canonical_name, NULL, COUNT(DISTINCT c.author_id), e.created_at
FROM entities e JOIN entity_mentions em ON em.entity_id = e.id JOIN claims c ON c.id = em.claim_id, clock
WHERE e.provisional = 0 AND e.created_at >= clock.now - 72 * 3600
GROUP BY e.id HAVING COUNT(DISTINCT c.author_id) >= 3
UNION ALL
SELECT 'counter_on_ready_story', 'story', s.id, s.label_text, NULL, COUNT(*), MAX(c.published_at)
FROM stories s JOIN story_claims sc ON sc.story_id = s.id AND sc.active = 1 AND sc.role = 'counter' JOIN claims c ON c.id = sc.claim_id, clock
WHERE s.alive = 1 AND s.status = 'ready' AND c.published_at >= clock.now - 72 * 3600
GROUP BY s.id;

-- Tells a broken source apart from a topic that went quiet.
CREATE VIEW v_source_health AS
SELECT s.id AS source_id, s.type, s.key, s.label, h.consecutive_failures, h.last_error, h.last_ok_at, h.last_error_at,
       ROUND((CAST(strftime('%s', 'now') AS INTEGER) - COALESCE(h.last_ok_at, 0)) / 3600.0, 1) AS hours_since_ok
FROM sources s LEFT JOIN source_health h ON h.source_id = s.id
WHERE s.enabled = 1
  AND (COALESCE(h.consecutive_failures, 0) > 0
       OR h.last_ok_at IS NULL
       OR CAST(strftime('%s', 'now') AS INTEGER) - h.last_ok_at > 3 * s.poll_interval_min * 60);
