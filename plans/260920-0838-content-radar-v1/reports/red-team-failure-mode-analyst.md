# Red Team Review — Failure Mode Analyst (Flow Tracer)

Plan: `plans/260920-0838-content-radar-v1/`
Date: 2026-09-20. Perspective: Murphy's Law / failure-mode analysis. Verification role: flow tracer
(behavioural claims end to end across phases — who writes which status when, what triggers what,
where an item is lost, double-processed, or stuck).
Repo is greenfield; all evidence is `file:line` into plan and research documents.

---

## Finding 1: The budget ledger can never reserve on a fresh Pacific day — the whole LLM pipeline stalls every 24h

- **Severity:** Critical
- **Location:** Phase 4, "Architecture" (đặt chỗ ngân sách) and "Implementation Steps" step 1
- **Flaw:** The atomic reservation is a bare `UPDATE ... WHERE day_pt = ?1 AND model = ?2 AND requests < ?3`,
  and "no row returned" is defined as "model is out of budget for the day". `llm_usage` has
  `PRIMARY KEY(day_pt, model)` and nothing in phase 2 or phase 4 ever inserts the row for a new
  `day_pt`. `budget-ledger.ts` is specified with exactly three functions — `reserve`, `recordCall`,
  `markExhausted` — none of which creates the day's row.
- **Failure scenario:** At 00:00 America/Los_Angeles the Pacific day rolls over. `reserve()` targets
  `(2026-09-21, gemini-3.8-flash)`, which does not exist. The UPDATE matches zero rows. The consumer
  interprets this as "exhausted", walks the whole model chain (all three rows missing), and calls
  `retryAll({ delaySeconds })` with a delay computed as "time until quota reset" — a reset that has
  already happened, so the delay is either clamped to a small value (hot retry loop burning the
  50-retry budget) or to 12 hours (backlog idles half a day). Either way the pipeline goes from
  "quota exhausted" straight into "permanently exhausted" and never recovers without a manual
  `INSERT`. This fires on day one of the soak, not in some rare corner.
  Compounding: the reset boundary itself is an unverified assumption. The platform research states
  Google's own docs defer all quota facts to the per-account AI Studio dashboard and documents no
  reset timezone at all; the plan nonetheless bakes "Pacific day" into a primary key and schedules
  the daily cron at a fixed `20 8 * * *`, which is 00:20 PST but 01:20 PDT — a boundary that moves
  one hour twice a year and makes the Pacific day 23 or 25 hours long on DST days.
- **Evidence:**
  - `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:44` — `UPDATE llm_usage SET requests = requests + 1`
  - `phase-04-llm-extraction-and-budget.md:45` — `WHERE day_pt = ?1 AND model = ?2 AND requests < ?3`
  - `phase-04-llm-extraction-and-budget.md:49` — "Không có dòng trả về nghĩa là model hết ngân sách trong ngày."
  - `phase-04-llm-extraction-and-budget.md:71` — "`budget-ledger.ts` với `reserve(model, kind)`, `recordCall(...)`, `markExhausted(model, until)`" (no seeding, no upsert)
  - `phase-02-data-model-and-config.md:45` — "`llm_usage(day_pt, model, requests, tokens_in, tokens_out, PRIMARY KEY(day_pt, model))`"
  - `phase-01-foundation-and-spikes.md:50` — "`20 8 * * *` (08:20 UTC, sau thời điểm Gemini đặt lại quota theo giờ Pacific)"
  - `research/researcher-260920-0735-cloudflare-gemini-platform.md:102` — "do not hardcode any specific RPM/RPD number into the design; treat free-tier quota as configuration read from the user's own AI Studio dashboard"
- **Suggested fix:** Make the reservation a single atomic upsert
  (`INSERT INTO llm_usage(day_pt, model, requests) VALUES(?,?,1) ON CONFLICT(day_pt, model) DO UPDATE SET requests = requests + 1 WHERE requests < ?3 RETURNING requests`)
  so a missing row means "budget available", not "exhausted". Distinguish "no row" from "limit hit"
  explicitly in `reserve()`'s return type. Add a phase 9 task to empirically determine the real reset
  boundary (log the first 429 and the first post-reset success across a day boundary) before trusting
  `day_pt`; compute "time until reset" from `Intl` in `America/Los_Angeles`, never from a fixed UTC offset.

---

## Finding 2: Reservations are consumed before the call and never released — one flapping error destroys the entire daily free-tier quota

- **Severity:** Critical
- **Location:** Phase 4, "Requirements" / "Architecture" / "Implementation Steps" step 6
- **Flaw:** `requests` is incremented *before* the Gemini call, and the ledger API has no
  `release`/`refund`/compensating operation. Every failure path — transient network error,
  `location_blocked`, worker eviction mid-batch, D1 write failure after a successful Gemini
  response — leaves the reservation permanently consumed. This is combined with `max_retries = 50`
  and at-least-once queue delivery.
- **Failure scenario:** The phase 1 spike concludes that Placement Hints reduce but do not eliminate
  "User location is not supported" (phase 1 explicitly plans for that outcome: "phase 4 coi lỗi vị
  trí là lỗi tạm và retry"). A cron-triggered consumer lands on a non-supported PoP for a stretch of
  the day. Each retry of each message: reserve (+1 on model A), call, `location_blocked`, fall to
  model B, reserve (+1), call, fail, model C, reserve (+1), fail, `retryAll`. That is 3 reservations
  burned per attempt, 150 per message across the retry budget, with zero successful extractions. On a
  free tier whose RPD is realistically in the low hundreds, **a single sustained error class consumes
  100% of the day's ledgered quota without ever producing a claim**, and the ledger will keep
  reporting "exhausted" to `/api/status` while Google's real counter is untouched. The system is now
  self-denial-of-service, and the operator sees "quota exhausted" — the exact symptom the design says
  is benign and self-healing.
- **Evidence:**
  - `phase-04-llm-extraction-and-budget.md:30` — "Sổ ngân sách đặt chỗ nguyên tử trước mỗi call"
  - `phase-04-llm-extraction-and-budget.md:37` — "`max_retries = 50`, dead-letter `radar-dlq`"
  - `phase-04-llm-extraction-and-budget.md:71` — ledger API is `reserve` / `recordCall` / `markExhausted` only
  - `phase-04-llm-extraction-and-budget.md:76` — "lỗi tạm thì retry với độ trễ tăng dần; ... `location_blocked` xử lý theo quyết định của phase 1"
  - `phase-01-foundation-and-spikes.md:93` — "Nếu vẫn lỗi thì phase 4 coi lỗi vị trí là lỗi tạm và retry"
- **Suggested fix:** Make the reservation a two-phase lease: `reserve()` writes a pending row keyed by
  a call id; `recordCall()` commits it; any terminal non-consumed outcome (connection error,
  `location_blocked`, 4xx that Google does not count) releases it. Only count outcomes that Google
  actually charges (HTTP 200 and 429). Add a circuit breaker: after N consecutive failures of the
  same error class across the whole chain, stop reserving entirely and retry with a long delay
  instead of grinding the ledger down.

---

## Finding 3: No per-message ack and no extraction idempotency key — a mid-batch crash re-calls Gemini and inserts duplicate claims

- **Severity:** Critical
- **Location:** Phase 4, "Implementation Steps" steps 5–6; Phase 2, "Architecture" (Claim và entity)
- **Flaw:** The plan never mentions `message.ack()` anywhere (grep across all nine phase files returns
  no ack/explicit-acknowledgement handling). It writes per-item results in separate `db.batch` calls
  — "tất cả trong một `db.batch` cho mỗi item" — and then relies on implicit batch-level
  acknowledgement. `claims` has no uniqueness constraint and no natural key: `claims(id, item_id,
  author_id, kind, text_vi, ...)`. The "upsert everything" idempotency rule from phase 2 cannot apply
  to LLM-generated claims because there is nothing to conflict on. Nothing in the extract path filters
  the loaded items by `status`.
- **Failure scenario:** A batch of 10 items is processed. The Gemini call succeeds (quota consumed),
  items 1–7 are written and marked `extracted`, and the worker hits an exception or is evicted while
  writing item 8. Cloudflare Queues redelivers the *entire* batch (at-least-once). The consumer reloads
  all 10 items from D1 without a status filter, spends another reservation on a second Gemini call for
  content that was already extracted, and inserts a second, textually near-identical set of `claims`
  rows for items 1–7 with fresh ids. Downstream: duplicate claim nodes get duplicate embeddings, form
  mutually high-cosine edges (they are paraphrases of each other), and inflate community size and
  `members_hash` — which then triggers a `synthesize` call (more quota) for a story whose only change
  was duplication. The "test consumer chứng minh poll hai lần cùng payload cho số item không đổi"
  test in phase 3 does not cover this, because the duplication happens in phase 4, after the poll.
- **Evidence:**
  - `phase-04-llm-extraction-and-budget.md:39` — "Consumer nhóm message theo `kind`, nạp item từ D1" (no status filter)
  - `phase-04-llm-extraction-and-budget.md:75` — "ghi `claims` và `entity_mentions` ... tất cả trong một `db.batch` cho mỗi item để không có trạng thái nửa vời"
  - `phase-04-llm-extraction-and-budget.md:76` — only `retryAll` is specified; no `ack()` of successfully processed messages
  - `phase-02-data-model-and-config.md:41` — "`claims(id, item_id, author_id, kind, text_vi, ...)`" — no UNIQUE, no content hash
  - `phase-02-data-model-and-config.md:60` — "Mọi upsert dùng `INSERT ... ON CONFLICT DO UPDATE` để pipeline idempotent" (inapplicable to `claims`)
- **Suggested fix:** Explicitly `ack()` each message immediately after its per-item `db.batch` commits,
  and `retry()` only the messages that actually failed — never `retryAll` on partial success. Reload
  items with `WHERE status = 'queued'` and drop already-`extracted`/`irrelevant` items from the batch
  before building the prompt. Give `claims` a deterministic dedupe key
  (`UNIQUE(item_id, claim_content_hash)`) so a redelivered extraction is an idempotent upsert rather
  than a second row.

---

## Finding 4: Items can be stranded in `queued` forever, and nothing ever detects or repairs it — acceptance criterion #1 has no enforcing mechanism

- **Severity:** Critical
- **Location:** Phase 3, "Implementation Steps" step 4; Phase 4, "Key Insights"; Phase 9, "Success Criteria"
- **Flaw:** Two independent stranding paths, neither of which has a reconciliation sweeper anywhere in
  the plan (grep for `queued` across all phases returns only the schema, the write-order note, the
  status-page backlog gauge, and the two soak assertions — no repair job):
  1. **Enqueue-before-commit:** the write order is "R2 trước, D1 sau, enqueue cuối cùng; item chỉ
     chuyển `status = queued` sau khi enqueue thành công". If the worker dies between `send()` and the
     status update, the item stays `new` while a message exists — the next poll re-enqueues it
     (double extraction, see Finding 3). The inverse ordering would strand it instead. There is no
     transactional outbox, so one of the two failure modes is unavoidable as specified.
  2. **Message expiry:** the plan sizes the backlog against `max_retries = 50` at up to 12 hours per
     retry — up to 25 days of retrying — but Queues retention is 14 days. Expired messages are dropped;
     they do not route to the DLQ (the DLQ is fed by exceeding max retries, per the research table).
     The item's row stays at `status = 'queued'` with no message behind it, forever. It never becomes
     `extracted`, `irrelevant`, or `failed`.
- **Failure scenario:** The intentional quota-exhaustion test in phase 9 step 4 is run, or the free
  tier is smaller than assumed and the backlog grows for two weeks. Messages silently age out. The
  status page shows a backlog depth that never decreases (it counts `status='queued'` rows, which
  outlive their messages). The phase 9 assertion "số item `extracted` cộng `irrelevant` cộng `failed`
  bằng số item đã `queued`" fails, and there is no code path that could ever make it pass — no job
  re-enqueues an item whose message is gone.
- **Evidence:**
  - `phase-03-source-adapters-and-ingest.md:72` — "Thứ tự ghi: R2 trước, D1 sau, enqueue cuối cùng; item chỉ chuyển `status = queued` sau khi enqueue thành công"
  - `phase-04-llm-extraction-and-budget.md:24` — "Queues giữ message 14 ngày, độ trễ mỗi lần `retry` tối đa 24 giờ, tối đa 100 lần retry; đủ để backlog sống qua nhiều ngày hết quota"
  - `phase-04-llm-extraction-and-budget.md:37` — "`max_retries = 50`" (50 × 12h ≫ 14-day retention)
  - `phase-07-api-and-web-ui.md:41` — "độ sâu backlog (số item `queued`)"
  - `phase-09-deploy-soak-and-docs.md:84` — "không item nào ở trạng thái `queued` quá 48 giờ khi quota còn" (an assertion, with no mechanism)
  - `phase-09-deploy-soak-and-docs.md:85` — "không item nào biến mất"
  - `research/researcher-260920-0735-cloudflare-gemini-platform.md:25` — "Retention / durability of backlog | Configurable up to 14 days"
- **Suggested fix:** Add an explicit requeue sweeper to the daily maintenance job: re-enqueue any item
  with `status = 'queued'` and `queued_at` older than the message-retention horizon (track
  `queued_at` and an `enqueue_attempts` counter, and route to `failed` after a bounded number of
  sweeps). Change the poll consumer to mark the item `queued` in the same D1 write as the item upsert
  and enqueue afterwards (outbox semantics), so redelivery is idempotent rather than lossy. Cap the
  retry delay so that total retry time stays strictly under 14 days.

---

## Finding 5: The "every step is resumable" claim is false for the `lineage` step — a partial write poisons the next run's Jaccard baseline and destroys story identity

- **Severity:** Critical
- **Location:** Phase 6, "Requirements" and "Architecture" step 5; Phase 5, `matchCommunities` contract
- **Flaw:** The job creates a new `cluster_runs` row per hour and writes `stage` after each step, but
  the `lineage` step writes three tables plus `stories` and `story_claims` across many chunked D1
  batches with no transaction spanning them (D1 batches are individually atomic; a multi-batch step is
  not). The next run loads "K snapshot gần nhất" with **no stated filter on `cluster_runs.status`**.
  `matchCommunities` compares member sets by Jaccard, so a truncated member set is indistinguishable
  from a genuinely shrunken community.
- **Failure scenario:** Run N is killed (CPU limit, D1 error, deploy) after writing `run_communities`
  and `run_members` for 30 of 80 communities. `cluster_runs.status = 'failed'`, but the rows are in the
  table. Run N+1 loads the last K=3 snapshots, which now include run N's half-written one. For the 50
  communities missing from run N, the best previous match is the older snapshot, which may be past the
  K-run death window; for the 30 partial ones, the Jaccard against a truncated member set drops below
  0.5 and often below 0.3. Result: a wave of spurious `death` and `birth` events in a single run.
  Every reborn story gets a new `story_id`, so — per the phase 6 requirement that user state is bound
  to `story_id` — **every Saved, Dismissed and Written flag the user has ever set is silently
  orphaned**, and dismissed content floods back into the inbox. `lineage_events` is retained forever,
  so the corrupted history is permanent and feeds `v_lineage_recent` and the analyst layer's
  "đang dịch chuyển về hướng nào" answer. The plan's own integration test ("chạy job hai lần,
  khẳng định `story_id` không đổi") only exercises the clean-run path and would pass.
- **Evidence:**
  - `phase-06-cluster-job-and-card-synthesis.md:30` — "bước nào cũng idempotent để lần chạy sau tiếp tục được nếu lần trước chết giữa chừng"
  - `phase-06-cluster-job-and-card-synthesis.md:44` — "`lineage`: nạp K snapshot gần nhất, gọi `matchCommunities`, ghi `run_communities`, `run_members`, `lineage_events`; tạo hoặc cập nhật `stories` và `story_claims`"
  - `phase-06-cluster-job-and-card-synthesis.md:65` — "ghi lỗi và kết thúc `failed` khi có ngoại lệ" (the failed run's partial rows are left in place)
  - `phase-05-graph-core-package.md:59` — "cộng đồng cũ không có khớp trong quá K lần chạy thì `death`"
  - `phase-06-cluster-job-and-card-synthesis.md:33` — "Trạng thái người dùng ... gắn với `story_id`"
  - `phase-02-data-model-and-config.md:42` — `cluster_runs(id, ..., status, stage, ...)`; `run_communities(run_id, ...)`
- **Suggested fix:** Make the snapshot load explicitly `WHERE cluster_runs.status = 'done'`, and have
  the lineage step write `run_communities`/`run_members` first and flip `status` to `done` only as the
  final single-statement commit of the run — so a partial snapshot is invisible to matching. Add an
  integration test that kills the job mid-`lineage` and asserts the next run produces only `continue`
  events. Separately, decouple user state from `story_id` (a `story_user_state` table keyed by lineage
  root, or replay `user_actions` on rebirth) so identity churn cannot destroy it.

---

## Finding 6: The 20-minute overlap lock is inverted — it is a no-op in the normal case and permits concurrency exactly when a run is slow

- **Severity:** High
- **Location:** Phase 6, "Requirements" (khoá chống chạy chồng) and "Implementation Steps" step 3
- **Flaw:** The cluster cron fires hourly (`5 * * * *`), so two runs are 60 minutes apart. A lock that
  only suppresses a new run while an existing `running` row is *younger than 20 minutes* can never
  fire under normal scheduling — by the time the next cron arrives, the lock has already expired by
  40 minutes. The only situation in which the check is consulted at all is a run still executing after
  60 minutes, and in that situation the check deliberately returns "not locked" and starts a second
  concurrent job. The guard is also specified as a read-then-insert with no atomic acquisition
  (conditional UPDATE / unique lock row), so even the intended semantics are racy.
- **Failure scenario:** A run is slow — a Workers AI embedding backlog, D1 latency, or the 3,500-vector
  window the plan itself sizes as near the memory ceiling. At T+60 the second job starts. Both run
  Leiden on overlapping node sets, both write `claim_edges` upserts, both call `matchCommunities`
  against the same previous snapshots, and both write `stories.members_hash`/`score` and
  `lineage_events`. Last-writer-wins on `stories`, duplicate `birth`/`continue` rows in the permanent
  lineage table, and — because `enqueue_synthesis` compares `members_hash != synthesized_hash` — two
  `synthesize` messages for the same story, doubling the spend from the 20% reserved quota. And a run
  that dies without any exception handler running (eviction, OOM) leaves `status = 'running'`
  permanently, which after 20 minutes is treated as unlocked anyway, so the stale-lock state is never
  cleaned up and `cluster_runs` accumulates zombie `running` rows that the status page will report.
- **Evidence:**
  - `phase-06-cluster-job-and-card-synthesis.md:31` — "job mới bỏ qua nếu còn `cluster_runs` ở trạng thái `running` chưa quá 20 phút"
  - `phase-06-cluster-job-and-card-synthesis.md:65` — "khoá chống chạy chồng, tạo `cluster_runs`, chạy tuần tự"
  - `phase-01-foundation-and-spikes.md:50` — cron `5 * * * *` (hourly)
  - `phase-06-cluster-job-and-card-synthesis.md:23` — memory sizing "3.500 vector 1024 chiều, khoảng 14 MB" against a 128 MB ceiling
  - `phase-06-cluster-job-and-card-synthesis.md:91` — the plan's own slow-path signal: "bước `build_edges` quá 2 phút"
- **Suggested fix:** Acquire the lock atomically (`UPDATE lock SET holder=?, expires_at=? WHERE expires_at < now` with `RETURNING`, or a conditional insert on a unique key) with a lease longer than the
  cron interval (e.g. 55 minutes) plus explicit heartbeat renewal for long runs. Mark abandoned runs
  `failed` when their lease expires, rather than silently ignoring them — a zombie `running` row is a
  signal, not noise.

---

## Finding 7: Asynchronous `synthesize` races the member set — either the headline is permanently stale or the story enters a quota-burning re-enqueue loop

- **Severity:** High
- **Location:** Phase 6, "Architecture" step 7 and the `synthesize` contract
- **Flaw:** `enqueue_synthesis` selects stories where `members_hash != synthesized_hash` and enqueues a
  job; the job is executed later by the shared `radar-llm` consumer (possibly hours later under
  backlog). The message payload is not specified to carry the `members_hash` it was enqueued for, and
  the result handler "đặt ... `synthesized_hash`" without saying *which* hash. Meanwhile the hourly
  job keeps recomputing `members_hash` on `stories`. Validation additionally requires "mọi `claimId`
  phải thuộc câu chuyện".
- **Failure scenario A (ABA / lost update):** Story S is enqueued at hash H1. Two hourly runs later
  its membership is H3. The synthesize job completes and writes `synthesized_hash = <current
  members_hash> = H3` together with a headline generated from the H1 claim set. The next
  `enqueue_synthesis` sees `H3 == H3` and never re-synthesizes. **The card displays a headline and
  verification questions describing claims the story no longer contains, permanently**, and the plan's
  own success criterion "Câu chuyện có `synthesized_hash` bằng `members_hash` không bị xếp hàng tổng
  hợp lại" actively protects the bug.
- **Failure scenario B (livelock):** For a fast-moving story, claims present at enqueue time have left
  the community by completion time. Gemini returns roles for those `claimId`s; validation rejects the
  whole response; nothing is written; `synthesized_hash` stays stale; the next hourly run re-enqueues
  the same story, which is also the highest-scoring story so it is prioritised. Each cycle consumes one
  call from the 20% reserved quota and produces nothing. The hottest, most valuable story on the radar
  is the one that never gets a headline — and without a headline it is excluded from the inbox tab
  entirely.
- **Evidence:**
  - `phase-06-cluster-job-and-card-synthesis.md:46` — "xếp hàng `synthesize` cho câu chuyện ... có `members_hash` khác `synthesized_hash`, ưu tiên điểm cao"
  - `phase-06-cluster-job-and-card-synthesis.md:48` — "Kết quả được kiểm tra: mọi `claimId` phải thuộc câu chuyện ... đặt `has_counter` và `synthesized_hash`"
  - `phase-06-cluster-job-and-card-synthesis.md:26` — "Chỉ tổng hợp lại khi `members_hash` khác `synthesized_hash`"
  - `phase-06-cluster-job-and-card-synthesis.md:86` — success criterion that entrenches the stale state
  - `phase-07-api-and-web-ui.md:38` — inbox requires "đã có headline"
- **Suggested fix:** Carry `{ storyId, membersHash }` in the message. On completion, write
  `synthesized_hash = <hash from the message>` (never the current value) inside a conditional update,
  and accept role assignments only for claims still in the story rather than rejecting the whole
  response — drop departed claims, keep the headline, and let the next run re-synthesize if the hash
  moved. Add a `synthesis_attempts` counter and stop retrying a story that has failed validation N
  times, so a churning story cannot consume the reserved quota indefinitely.

---

## Finding 8: `story_claims` is never pruned — the card, the independent-source count, and `READY` status diverge permanently from actual cluster membership

- **Severity:** High
- **Location:** Phase 6, "Architecture" steps 5–6; Phase 7, `GET /api/stories/:id`
- **Flaw:** There are two sources of truth for story membership. `run_members(run_id, community_idx,
  claim_id)` is the per-run truth; `story_claims(story_id, claim_id, role, added_run_id)` is the
  display truth. The lineage step only ever *adds* to `story_claims` ("tạo hoặc cập nhật ... claim mới
  nhận vai trò `unassigned`"); no step in the plan deletes a `story_claims` row when a claim leaves the
  community — by moving to another cluster or by aging out of the 7-day window. `added_run_id` exists
  but is never used as a filter anywhere.
- **Failure scenario:** A story lives for three weeks of hourly runs. Its cluster membership at any
  moment is ~15 claims inside the 7-day window, but `story_claims` has accumulated ~200 rows including
  claims that migrated to sibling stories after a `split`. The API returns all of them, so the card
  renders dozens of EVIDENCE/CONTEXT/COUNTER lines including evidence that now belongs to a different
  story — a correctness failure the user can see and cannot explain. Worse, the `score` step calls
  `countIndependentSources` over the story's claims: fed from `story_claims`, it counts authors of
  claims that left, so `independent_sources` only ever ratchets upward. A story becomes `READY` (≥2
  independent sources) and can never fall back to `LEAD`, which destroys the meaning of the single most
  important product signal and of the 0.30-weighted `S_sources` sub-score. Fed from `run_members`
  instead, the card and the score disagree with each other.
- **Evidence:**
  - `phase-06-cluster-job-and-card-synthesis.md:44` — "tạo hoặc cập nhật `stories` và `story_claims` (claim mới nhận vai trò `unassigned`)" — additive only
  - `phase-06-cluster-job-and-card-synthesis.md:45` — "`score`: với mỗi câu chuyện còn sống, gọi `countIndependentSources` và `scoreStory` ... ghi ... `independent_sources`, `status`" — input set unspecified
  - `phase-02-data-model-and-config.md:43` — "`story_claims(story_id, claim_id, role, added_run_id)`"
  - `phase-07-api-and-web-ui.md:39` — "trả câu chuyện, các claim theo vai trò"
  - `phase-06-cluster-job-and-card-synthesis.md:98` — "Job không bao giờ xoá `items`, `claims` hay `stories`" — says nothing about `story_claims` membership
  - `plan.md:34` — "`LEAD` khi có 1 nguồn độc lập, `READY` khi có từ 2"
- **Suggested fix:** Define `story_claims` as a projection of the latest successful run's membership:
  in the lineage step, insert new members, delete rows whose claim is no longer in the community, and
  preserve the `role` of surviving rows. Add `last_seen_run_id` if historical evidence must be kept,
  and have both the API and `countIndependentSources` read only current members. Add a test asserting
  that a story whose second source ages out of the window reverts from `READY` to `LEAD`.

---

## Finding 9: Temporary entities freeze wrong edge weights into `claim_edges`, and adjudication never repairs them

- **Severity:** High
- **Location:** Phase 6, "Architecture" steps 1 and 3; "Implementation Steps" step 4
- **Flaw:** `build_edges` calls `newEdges` only "cho claim mới" and upserts the result into
  `claim_edges`; edge weight depends on IDF-weighted entity overlap. A mention awaiting adjudication is
  attached to a brand-new temporary entity so the claim can enter the graph. When the verdict later
  arrives, the plan re-points the mention ("gắn lại các mention tạm") but specifies **no edge
  recomputation** — and the claim is no longer "new", so no subsequent run will recompute it either.
- **Failure scenario:** "deepseek v4 flash" lands in the 0.75–0.92 ambiguous band and is parked on temp
  entity `E_tmp`. Its claims share zero entity overlap with the ten existing claims about
  `E_deepseek_v4`, so `edgeWeight` falls below the minimum and **no edge row is written at all**.
  Leiden puts the claim in its own community → a spurious `birth` event and a duplicate story card for
  the same real-world event. Hours later (or days later, since `adjudicate` competes for the same
  scarce reserved quota and the free tier is the binding constraint) Gemini rules "same". The alias is
  added, the mention is re-pointed — and the graph does not change, because the missing edges are only
  ever computed at claim-creation time. The duplicate story persists until both claims age out of the
  7-day window. Symmetrically, edges that *were* written carry stale weights and stale IDF, which
  falsifies the phase 6 claim that "graph dựng lại được y hệt từ D1 nên kết quả lặp lại được": the
  stored graph is path-dependent on the order and timing of adjudication, not a function of the data.
  Secondary: `entity_adjudications(id, mention_normalized, candidate_entity_id, ...)` has no UNIQUE
  constraint on `mention_normalized`, and nothing says a repeated identical mention reuses the existing
  temp entity or pending row — so during a multi-day quota backlog each hourly run can mint another temp
  entity and enqueue another `adjudicate` job for the same surface string, multiplying both the entity
  table and the quota drain.
- **Evidence:**
  - `phase-06-cluster-job-and-card-synthesis.md:40` — "trong lúc chờ, mention tạm gắn vào một entity mới để claim vẫn vào graph, và được gộp lại khi có phán quyết"
  - `phase-06-cluster-job-and-card-synthesis.md:42` — "`build_edges`: ... tính IDF, gọi `newEdges` cho claim mới, upsert `claim_edges`"
  - `phase-06-cluster-job-and-card-synthesis.md:66` — "áp phán quyết vào `entity_aliases`, `entity_relations` và gắn lại các mention tạm" (no edge invalidation)
  - `phase-06-cluster-job-and-card-synthesis.md:24` — "graph dựng lại được y hệt từ D1 nên kết quả lặp lại được"
  - `phase-05-graph-core-package.md:57` — "`edgeWeight(a, b, idf, params) = w_cos * max(0, cosine) + w_ent * idfOverlap(...)`, chỉ tạo cạnh khi ... trọng số đạt ngưỡng tối thiểu"
  - `phase-02-data-model-and-config.md:41` — "`entity_adjudications(id, mention_normalized, candidate_entity_id, similarity, status, decision, decided_at)`" — no UNIQUE
- **Suggested fix:** When an adjudication is applied, mark every claim touching the affected entities as
  edge-dirty and recompute their edges in the next `build_edges` pass (a `claims.edges_version` column
  compared against an entity-resolution version is enough). Make `entity_adjudications` unique on
  `(mention_normalized, candidate_entity_id)` and have `resolve_entities` reuse an existing pending
  temp entity for an identical normalized surface instead of creating a new one. Consider deferring
  ambiguous mentions out of the graph for one run instead of injecting a known-wrong node, if the
  duplicate-story cost exceeds the delay cost.

---

## Finding 10: No deploy or migration rollback path, and the only stated recovery tool rewinds the LLM ledger and the user's card state

- **Severity:** Medium
- **Location:** Phase 2, "Risk Assessment" / "Security Considerations"; Phase 9, "Architecture"
  (pre-production checklist) and step 6
- **Flaw:** The plan's entire recovery story is "record a Time Travel bookmark before applying
  migrations" plus a weekly `d1 export`. There is no rollback procedure for a bad deploy
  (`wrangler rollback` / versioned deploy appears nowhere), no forward-fix policy, and no
  acknowledgement that D1 Time Travel restore is destructive and whole-database — the research report
  states this explicitly. Migration apply and Worker deploy are two separate, non-atomic steps in the
  checklist (migration first, deploy at step 4).
- **Failure scenario:** A migration in phase 6 or 8 ships with a bad `CHECK` constraint and the
  production consumers start throwing on every write. The operator reaches for the only documented
  tool and restores D1 to the bookmark. That restore rewinds *everything*, including: `llm_usage` (the
  day's reservations are erased while Google's real counter is not, so the pipeline immediately
  over-calls into a 429 storm, and `markExhausted` state is gone too), `stories.user_state` (every
  Save/Dismiss/Written since the bookmark is lost, and `user_actions` — the calibration dataset the
  plan depends on in phase 9 step 5 — is truncated), and `cluster_runs`/`run_members` (the lineage
  baseline, re-opening Finding 5). Meanwhile the deployed Worker still runs the new code expecting the
  new schema, which the restore has just removed — the two halves are now inconsistent with no
  documented way to put them back in step. The 20-minute-window gap between migration apply and
  `wrangler deploy` also means live consumers execute old code against new schema during every
  production change.
- **Evidence:**
  - `phase-02-data-model-and-config.md:83` — "chỉ thêm migration mới, không sửa file đã áp dụng lên remote" (forward-only, no down path)
  - `phase-02-data-model-and-config.md:88` — "ghi lại bookmark Time Travel ... để có điểm khôi phục"
  - `phase-09-deploy-soak-and-docs.md:38` — "Ghi bookmark Time Travel, áp dụng migration lên remote, chạy `npm run config:sync -- --remote`"
  - `phase-09-deploy-soak-and-docs.md:41` — "`wrangler deploy`" as a separate later step
  - `phase-09-deploy-soak-and-docs.md:67` — "Time Travel 30 ngày là lớp khôi phục chính"
  - `research/researcher-260920-0735-cloudflare-gemini-platform.md:65` — "restore is destructive (overwrites in place)"
- **Suggested fix:** Require migrations to be additive and backward-compatible with the currently
  deployed Worker (expand → deploy → contract), so a deploy can be rolled back with
  `wrangler rollback` without touching data. Document that in `docs/operations.md` as the primary
  rollback path and demote Time Travel to a last-resort data-corruption tool with an explicit warning
  about `llm_usage` and `user_state` loss. Export `user_actions`/`stories.user_state` and the current
  `llm_usage` row before any restore, and re-apply them afterwards.

---

## Cross-cutting note on flow tracing

Traced end to end, the item lifecycle is
`poll → R2 → items(new) → cheap filter → enqueue → items(queued) → extract → claims → resolve_entities →
embed → build_edges → cluster → lineage → stories → score → enqueue_synthesis → synthesize → card`.
Every handoff that crosses a process boundary in this chain (enqueue, queue redelivery, cron restart,
async synthesis) is specified as a status flag write with no ack discipline, no idempotency key, and no
reconciliation job. Findings 3, 4, 5 and 7 are four instances of the same missing primitive. Fixing
them piecemeal will leave the next boundary equally exposed; a single stated rule — *every cross-boundary
handoff carries an idempotency key, commits state before signalling, and is swept by the daily
maintenance job* — would close all four and should be added to the plan's architecture section before
phase 3 starts.
