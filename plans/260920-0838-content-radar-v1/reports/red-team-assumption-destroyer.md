# Red Team: Assumption Destroyer — Content Radar v1

Date: 2026-09-20. Reviewer perspective: hostile skeptic / scope auditor.
Target: `plans/260920-0838-content-radar-v1/` (plan + 9 phases + 3 research documents).
Repo is greenfield; all evidence is file:line citations into the plan and research files, plus two Cloudflare docs fetches.

Scope-audit lens applied to every piece of state the plan introduces (tables, hashes, caches, settings, locks): who writes it, who reads it, whether something else already owns the same fact, and whether it survives the boundaries the plan assumes (run-to-run, window slide, split/merge, retention, quota exhaustion).

---

## Finding 1: No minimum community size — every isolated claim becomes a story card

- **Severity:** Critical
- **Location:** Phase 5, "Architecture" (`Clusterer.cluster`, `edgeWeight`); Phase 6, steps `lineage` and `score`; Phase 2, `config/settings.json` defaults

**Flaw:** Edges are created only when `edgeWeight` clears a minimum threshold, so any claim with no above-threshold neighbour is an isolated node. Leiden/CPM returns every isolated node as its own community. Phase 6 then turns *every* community into a `stories` row with no size floor anywhere in the plan. I grepped the whole plan directory for a minimum-community-size / minimum-members gate; there is none. The only display gate is a score floor of 40, and the score formula passes single-claim stories.

**Failure scenario:** Real ingest is dominated by one-off posts — a Cloudflare blog post about Durable Objects, a single KOL tweet about a benchmark, a GitHub release. Each yields 1–3 claims that match nothing else in the 7-day window. Run the arithmetic from the plan's own formula on a fresh single-claim community whose author has no baseline: `S_sources = log2(2)/log2(6) = 0.387`, `S_velocity = 0.5` (neutral, per Phase 5), `S_specificity = 1` (the claim contains a number), `S_counter = 0`, `S_novelty ≈ 0.8`, `S_recency = 1`. Score = `100 * (0.30*0.387 + 0.20*0.5 + 0.15*1 + 0 + 0.15*0.8 + 0.10*1) = 58.6`. That is above the display floor of 40, so the singleton is shown as a `LEAD` card **and** queued for a `synthesize` Gemini call. With a few hundred claims per day, the inbox becomes hundreds of one-claim cards per day — the product becomes an RSS reader with extra steps, which is the exact failure the "one community = one story" premise was supposed to prevent. Second-order damage: each singleton emits a `birth` event and, days later, a `death` event into `lineage_events`, which is kept forever and is the primary input to `v_lineage_recent` — the view that is supposed to answer "where is the field moving". That view drowns in singleton noise.

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-05-graph-core-package.md:57` — "chỉ tạo cạnh khi hai claim cách nhau không quá cửa sổ thời gian và trọng số đạt ngưỡng tối thiểu" (edges only above a minimum weight → isolated nodes exist).
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:44` — "`lineage`: ... tạo hoặc cập nhật `stories` và `story_claims`" (every community becomes a story, unconditionally).
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:46` — "`enqueue_synthesis`: xếp hàng `synthesize` cho câu chuyện đạt điểm hiển thị tối thiểu" (the only gate is the score floor).
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:61` — "điểm hiển thị tối thiểu 40" (the floor value the arithmetic above clears).
- `plans/260920-0838-content-radar-v1/phase-05-graph-core-package.md:61` — the six-term formula and "Tác giả chưa đủ mẫu baseline (dưới 10 bài) nhận `S_velocity = 0.5` trung tính".

**Suggested fix:** Add `min_community_size` (default 2 or 3) to `params.ts`/`settings` and make Phase 6's `lineage` step drop sub-threshold communities *before* creating `stories` rows (keep the claims; they can join a community in a later run). Separately, remove the neutral 0.5 velocity credit from stories whose entire member set lacks a baseline, and state explicitly in Phase 6 that a 1-member community is never a card.

---

## Finding 2: The synthesis budget cannot cover the story volume, and a missing headline makes a story invisible

- **Severity:** Critical
- **Location:** Phase 4, "Architecture" (budget reservation, 80/20 split); Phase 6, "Requirements" and step `enqueue_synthesis`; Phase 7, `GET /api/stories`

**Flaw:** `synthesize` is one Gemini call per story, `adjudicate` shares the same 20% reserve, and Phase 7's `inbox` tab only returns stories that already have a headline. The plan never does the arithmetic that connects these three facts.

**Failure scenario:** Until the user supplies real AI Studio numbers, the plan runs on 5 RPM / 100 RPD per model across three models = 300 RPD, of which 20% = **60 calls/day** are available for `synthesize` *plus* `adjudicate`. The cluster job runs hourly (24 runs/day) and re-queues synthesis whenever `members_hash != synthesized_hash`. A story that gains one claim is re-synthesized. With even 100 live stories above the display floor and each touched once per day, demand is ~100 synth calls/day against a 60-call ceiling shared with entity adjudication — and Finding 1 pushes demand into the hundreds or thousands. `enqueue_synthesis` caps itself at the remaining reserve, so the overflow simply never gets a headline; Phase 7 then filters those stories out of the inbox entirely. Concrete end state after 24 hours in production: D1 is full of scored stories, the UI shows the ~40 highest-scoring ones that won the quota lottery, and newly emerging stories (the product's entire reason to exist) are the ones starved, because they enter with lower scores and lose the priority ordering. Plan success criterion 3 ("Giao diện hiển thị đúng spec thẻ lead") is technically met by whatever survives, so the soak week can pass while the product fails. Note also that the documented mitigation for quota pressure ("tăng `max_batch_size`") directly worsens extraction quality, which the plan itself flags as the trigger for *reducing* batch size — the two mitigations are in direct conflict and the plan never resolves which wins.

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:49` — "Loại việc `extract` chỉ được dùng tới 80% RPD; 20% còn lại dành cho `synthesize` và `adjudicate`."
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:32` — "`adjudicate` (gom tối đa 20 cặp entity mơ hồ mỗi call) và `synthesize` (một câu chuyện mỗi call)".
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:63` — "pipeline dùng mức an toàn mặc định 5 RPM và 100 RPD mỗi model".
- `plans/260920-0838-content-radar-v1/phase-07-api-and-web-ui.md:38` — "Tab `inbox` trả câu chuyện còn sống, `user_state = inbox`, **đã có headline** và đạt điểm hiển thị tối thiểu."
- `plans/260920-0838-content-radar-v1/phase-09-deploy-soak-and-docs.md:93` vs `phase-04-llm-extraction-and-budget.md:100` — "tăng `max_batch_size`" vs "giảm `max_batch_size`" as responses to two symptoms that co-occur.

**Suggested fix:** Put the synthesis-demand arithmetic in Phase 6 as an explicit budget model (stories above floor × expected member-change rate × 24 runs), and add the controls it implies: synthesize at most once per story per N hours regardless of member churn; require a *material* member change (e.g. ≥20% of members or a new independent source) rather than any hash difference; render un-synthesized stories in the UI with a deterministic fallback headline (top claim's `text_vi`) so quota starvation degrades the card instead of hiding the story. Add a soak metric "stories above floor with no headline after 24h" with a pass/fail bar.

---

## Finding 3: `derived_from_claim_id` and author aliasing have no writer — the LEAD/READY gate is decorative

- **Severity:** Critical
- **Location:** Phase 2, "Claim và entity" / "Tác giả"; Phase 5, `countIndependentSources`; Phase 6, hourly job steps

**Flaw:** Scope audit of two pieces of state, both read but never written:
1. `claims.derived_from_claim_id` is declared in the schema and consumed by `countIndependentSources`, but no phase populates it. The `extract` output schema has no derivation field; Phase 6's seven job steps never compute one; Phase 3 stores `parent_external_id` on **items**, not on claims, and never maps it across.
2. `authors` / `author_handles` exist, and `countIndependentSources` takes an `authorAliases` argument, but no step ever decides that two handles belong to one author.

The research report specified exactly how to populate the first ("populated from platform metadata first, then near-duplicate/URL-citation detection") and the plan silently dropped it while keeping the column.

**Failure scenario:** `derived_from_claim_id` is always NULL and author aliases are always empty, so "independent sources" degenerates to "number of distinct `author_id` values", where `author_id` is per-handle-per-platform. OpenAI publishes a model card; within two hours simonwillison.net, Latent Space, three X KOLs and an HN submission all restate the same number. That is 1 real source. The system counts 6, flips the story to `READY` with `S_sources = min(1, log2(7)/log2(6)) = 1.0`, and ranks the echo chamber above a genuinely corroborated story. Phase 5's own Key Insight predicted this exact failure ("cổng `READY` mất nghĩa") and then the plan failed to wire the mechanism that prevents it. Worse, Phase 3's cheap filter discards reposts before extraction, so the one derivation signal the platform hands you for free (`reposted_by`) never reaches a claim at all.

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:41` — `claims(..., derived_from_claim_id, created_at)` declared.
- `plans/260920-0838-content-radar-v1/phase-05-graph-core-package.md:60` — "`countIndependentSources(claims, derivations, authorAliases)` ... Kết quả là số gốc phân biệt của chuỗi dẫn xuất" (reads derivations + author aliases).
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:38-46` — the seven steps (`resolve_entities`, `embed_claims`, `build_edges`, `cluster`, `lineage`, `score`, `enqueue_synthesis`); none derives claim lineage or author identity.
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:54-56` — the extract schema: `{ kind, text_vi, text_en, quote, has_numbers, first_hand, entities[] }`, no derivation field.
- `plans/260920-0838-content-radar-v1/research/researcher-260920-0735-graph-leiden-and-sources.md:84` — "Implement via a `claims.derived_from_claim_id` column populated from platform metadata first, then near-duplicate/URL-citation detection" (the dropped instruction).
- `plans/260920-0838-content-radar-v1/phase-05-graph-core-package.md:25` — "nếu không một bài được repost mười lần sẽ thành mười nguồn và cổng `READY` mất nghĩa" (the plan predicting its own failure).

**Suggested fix:** Add an explicit `derive_relations` step to Phase 6 between `embed_claims` and `build_edges`: map `items.parent_external_id` → parent claim ids, mark claims whose `canonical_url` matches another claim's cited URL, and mark near-duplicate `text_en` pairs above a high cosine as derived. Add an `author_aliases` table with a writer (manual config file + a handle-match heuristic) or delete the `authorAliases` parameter and document that cross-platform identity is out of scope for v1. Either way, no read-only state.

---

## Finding 4: The budget ledger cannot start a day, and conflates per-minute with per-day exhaustion

- **Severity:** Critical
- **Location:** Phase 4, "Architecture" (reservation SQL, RPM check) and "Requirements" (fallback chain)

**Flaw:** Two defects in the same specified mechanism.

(a) The reservation is an `UPDATE ... WHERE ... RETURNING`, and the plan states the contract as "no row returned = model is out of budget for the day". `llm_usage` has `PRIMARY KEY(day_pt, model)` and nothing in the plan inserts the row for a new Pacific day.

(b) RPM is checked by counting `llm_calls` in the trailing 60 seconds, but when a model is unavailable for *any* reason the chain falls through and the requirement specifies a single response: retry with a delay "tới thời điểm đặt lại quota, tối đa 12 giờ". A per-minute limit and a per-day limit get the same 12-hour punishment.

**Failure scenario (a):** At 00:00 Pacific the ledger key rolls over. The first `extract` batch reserves against `(2026-09-21, gemini-3.8-flash)`, the UPDATE matches zero rows, the consumer concludes "out of daily budget", tries the next two models with the same result, and calls `retryAll({ delaySeconds: up to 43200 })`. Twelve hours later the same thing happens. No Gemini call is ever made, no error is raised, `llm_calls` stays empty, and `/api/status` shows a growing backlog with 0 requests used — a silent total stall that looks like "quota exhausted" on every dashboard the plan builds. This exact path is also the plan's own happy-path test ("khi `rpd` đã đạt, message được trả lại hàng đợi với độ trễ dương và không có call nào tới Gemini") so the test suite goes green on the broken behaviour.

**Failure scenario (b):** After a 30-minute poll cron, ~800 items are queued = 80 batches. With 5 RPM the first 5 batches succeed within a minute; batch 6 fails the RPM check on all three models, the chain reports exhausted, and 10 messages are pushed 12 hours out. Repeat for the remaining 74 batches. Effective throughput collapses from 240 calls/day to roughly 5 calls per 12-hour window. The backlog metric in the soak report will show "backlog rising", the documented response is "increase batch size / tighten filters", and none of it addresses the actual cause. The message is never lost, so acceptance criterion 1 still passes while the pipeline delivers nothing.

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:44-49` — the `UPDATE llm_usage SET requests = requests + 1 WHERE day_pt = ?1 AND model = ?2 AND requests < ?3 RETURNING requests` and "Không có dòng trả về nghĩa là model hết ngân sách trong ngày. RPM kiểm tra bằng số dòng `llm_calls` của model trong 60 giây gần nhất."
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:45` — `llm_usage(day_pt, model, requests, tokens_in, tokens_out, PRIMARY KEY(day_pt, model))`; no seeding step anywhere.
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:31` — "hết cả chuỗi thì `retry` với độ trễ tới thời điểm đặt lại quota, tối đa 12 giờ mỗi lần" (one delay policy for all exhaustion causes).
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:92` — the test that locks in the broken semantics.

**Suggested fix:** Specify `INSERT INTO llm_usage(day_pt, model, requests) VALUES(?,?,1) ON CONFLICT(day_pt, model) DO UPDATE SET requests = requests + 1 WHERE requests < ?` as the reservation, and make `reserve()` return a typed reason (`rpd_exhausted | rpm_exhausted | tpm_exhausted | exhausted_until`) that maps to distinct delays (seconds for RPM, until Pacific midnight for RPD). Add a test that runs the ledger against an empty `llm_usage` table and a test that asserts an RPM miss produces a delay < 120 s.

---

## Finding 5: `text_en` is a non-deterministic LLM paraphrase feeding the "deterministic" graph, with no provenance

- **Severity:** High
- **Location:** Phase 4, extract schema; Phase 6, step `embed_claims`; Phase 2, `claims` and `llm_calls` schemas; plan.md Success Criteria

**Flaw:** The plan's headline property is a deterministic core ("Chạy lại Leiden trên cùng dữ liệu với cùng seed cho cùng phân hoạch"). But every node's position in the embedding space comes from `text_en`, which is generated by Gemini — and three separate plan mechanisms make that generation vary for the *same* input item: (i) the model fallback chain means the same item may be processed by `gemini-3.8-flash`, `3.7` or `3.6` depending on quota state at that minute; (ii) items are extracted in batches of 10, so the paraphrase of item X is conditioned on the 9 unrelated items that shared its batch, which depends on queue arrival order and the 60-second batch timeout; (iii) the `invalid_request` recovery path splits a batch in half and re-runs it with different neighbours. Meanwhile `claims` has no `model` or `prompt_version` column, and `llm_calls` has no `item_id`/`claim_id` foreign key — so the provenance of a claim is not recorded anywhere and the drift is not even observable.

**Failure scenario:** A quota-exhausted afternoon pushes a burst of items through `gemini-3.6-flash` with different phrasing habits than the morning's `3.8-flash`. Those claims embed into a slightly different region; `build_edges` writes weaker cross-model edges; the hourly Leiden run splits what is one story into a "morning" community and an "afternoon" community, emitting a spurious `split` event with a new `story_id` for the smaller child. The analyst layer reads `lineage_events` and reports a narrative fork that is an artefact of the Gemini quota schedule. Nothing in the soak metrics can detect this, because claims carry no model attribution. Re-running the pipeline from the same raw R2 payloads does *not* reproduce the same partition, so the acceptance criterion is only true in the trivial sense of "re-clustering stored edges is repeatable".

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:59` — "`text_en` là bản chuẩn hoá tiếng Anh dùng cho embedding".
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:41` — "`embed_claims`: embed `text_en` của claim chưa có vector".
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:31` — the model fallback chain; `:39` — "Consumer nhóm message theo `kind`, nạp item từ D1" (batch composition is queue-order dependent); `:76` — "`invalid_request` trên cả lô thì tách lô làm đôi và thử lại".
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:41` — `claims(...)` has no model/prompt-version column; `:45` — `llm_calls(id, at, model, kind, status, http_status, latency_ms, tokens_in, tokens_out, error)` has no item/claim key.
- `plans/260920-0838-content-radar-v1/plan.md:59` — the determinism success criterion this undermines.

**Suggested fix:** Add `model`, `prompt_version`, `batch_id` to `claims` and `item_id` to `llm_calls`, so drift is measurable and a re-extraction can be scoped. Restate the determinism criterion honestly: "given a fixed set of stored claims and embeddings, clustering is reproducible" — and add a soak metric comparing edge-weight distributions across models. If cross-model drift is material, pin extraction to a single model and let the fallback chain only serve `synthesize`/`adjudicate`.

---

## Finding 6: The 7-day window is a hard cliff — story identity, user state, and backfill all die at it

- **Severity:** High
- **Location:** Phase 5, `matchCommunities`; Phase 2, settings defaults; Phase 6, `build_edges` / retention; Phase 9, backfill step; Phase 8, momentum risk response

**Flaw:** Claims enter the graph only inside a sliding 7-day window, communities are re-derived from scratch every hour, and identity is recovered only by Jaccard against the last K=3 runs — i.e. a 3-hour lookback for an hourly job. Three consequences the plan does not address.

**Failure scenario A — burst ageing kills a live story.** A launch produces 100 claims in 6 hours; the story continues for two weeks at ~20 claims/week. Exactly 7 days later those 100 claims exit the window inside the same 6 hours. Run N has 120 members, run N+2 has ~30. Jaccard = 30/120 = 0.25, below the 0.3 birth threshold → the live, actively-updating story is recorded as `death` + `birth`, gets a new `story_id`, loses `user_state`, and its `story_daily` series is cut in two. The Phase 5 test suite only covers "câu chuyện vắng mặt một lần chạy rồi quay lại" — the easy case — so this passes CI.

**Failure scenario B — dismissed stories resurrect.** A story goes quiet, all its claims age out, and 3 runs later it is `death`. The user dismissed it last week. Nine days later the topic resurges; there is no dead-story matching path beyond the K-run lookback, so it is a `birth` with a fresh `story_id` and `user_state = inbox`. The card the user explicitly dismissed comes back. Phase 6 asserts the opposite guarantee. As a scope-audit note, `user_actions` rows still point at the dead `story_id`, so the weight-calibration dataset the plan wants to accumulate (50+ actions) is fragmented across duplicate identities of the same story. Also note the state-lifetime mismatch: `run_members` is retained 30 days but the matcher only ever looks back 3 runs — 99% of that retained state has no reader.

**Failure scenario C — the backfill buys nothing.** Phase 9 backfills 15 days of X history for every KOL, and Phase 8 justifies it as the way to shorten the "at least 3 weeks of data" warmup for momentum views. But backfilled items are 8–15 days old, so `build_edges` never considers them (they are outside the window), they never join a community, they never produce a `story`, and `story_daily`/`entity_daily` are written forward-only by the daily job — there is no retroactive aggregation step. Net effect: the backfill spends the scarcest resource in the system (Gemini RPD, several hundred calls) on claims that are structurally incapable of becoming cards, while starving live ingest on day 1 of production, and does not shorten the momentum warmup at all.

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:61` — "cửa sổ 7 ngày ... ngưỡng Jaccard 0.5 và 0.3, lookback 3 lần chạy".
- `plans/260920-0838-content-radar-v1/plan.md:32` — "mỗi giờ chạy job cluster" (so K=3 runs = 3 hours).
- `plans/260920-0838-content-radar-v1/phase-05-graph-core-package.md:59` — "dưới 0.3 với mọi cộng đồng cũ thì `birth`; cộng đồng cũ không có khớp trong quá K lần chạy thì `death`"; `:77` — the single-run-absence test.
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:33` — "Trạng thái người dùng (`saved`, `dismissed`, `written`) gắn với `story_id` và sống qua mọi lần chạy" (the falsified guarantee); `:42` — edges only "trong cửa sổ"; `:50` — "`run_members` 30 ngày".
- `plans/260920-0838-content-radar-v1/phase-09-deploy-soak-and-docs.md:64` — "gọi endpoint backfill cho từng handle"; `plans/260920-0838-content-radar-v1/phase-08-analyst-layer.md:91` — "cần ít nhất 3 tuần dữ liệu ... và phase 9 có bước backfill để rút ngắn thời gian chờ".

**Suggested fix:** (a) Match new communities against *dead* stories as well, using a persistent story signature (entity set + centroid embedding) rather than claim-id Jaccard, with a long revival horizon (30 days); claim-id Jaccard cannot survive window slide by construction. (b) Make K a duration (e.g. 6 hours) not a run count, and add a lineage test where 75% of members age out in one run. (c) Either drop the backfill from Phase 9 or add a retroactive aggregation step that computes `story_daily`/`entity_daily` for historical days from backfilled claims — and state which one, because as written the step is pure quota burn.

---

## Finding 7: A crashed cluster run poisons lineage, and the 20-minute lock does not prevent overlap

- **Severity:** High
- **Location:** Phase 6, "Requirements" (anti-overlap rule, per-step idempotence) and step `lineage`

**Flaw:** The anti-overlap guard is "skip if a `cluster_runs` row is `running` and younger than 20 minutes" — a time-based read, not an atomic claim, and the timer is wall-clock while the failure it guards (CPU exhaustion, isolate kill) leaves no writer to mark the row `failed`. Separately, `lineage` loads "the K most recent snapshots" with no filter on run status, while steps write `run_communities`/`run_members` incrementally.

**Failure scenario:** Run A starts at 12:05, gets through `cluster` and writes half of `run_communities`/`run_members` for the window, then exceeds CPU during `lineage` and is killed — `cluster_runs.status` stays `running` forever. At 13:05 run B starts, sees a `running` row older than 20 minutes, proceeds, and loads the K=3 most recent snapshots — one of which is A's half-written member set. Communities that exist in reality but were never written by A have no match in that snapshot; `matchCommunities` sees Jaccard 0 against a truncated snapshot and emits a wave of false `death`/`birth` events, minting new `story_id`s and dropping user state for every affected card. The damage persists for K runs. The inverse case is equally live: if run A simply takes 25 minutes (plausible — Workers AI embedding round-trips and thousands of `claim_edges` upserts are wall time, not CPU), run B starts *while A is still running*, and two jobs write `stories`, `story_claims` and `lineage_events` concurrently with no transaction boundary between them.

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:31` — "job mới bỏ qua nếu còn `cluster_runs` ở trạng thái `running` chưa quá 20 phút".
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:30` — "bước nào cũng idempotent để lần chạy sau tiếp tục được nếu lần trước chết giữa chừng" (resumption is asserted, but the next run has a new `run_id` and a new window, so what it resumes is undefined).
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:44` — "`lineage`: nạp K snapshot gần nhất" (no status filter).
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:42` — `cluster_runs(..., status, stage, ...)`, `run_communities(run_id, ...)`, `run_members(run_id, ...)`.

**Suggested fix:** Make snapshot selection read only `cluster_runs.status = 'ok'`, and make `lineage` write `run_communities`/`run_members` as one `db.batch` that also flips the run to `ok` — a snapshot is either complete or invisible. Replace the time-window lock with a conditional `UPDATE ... WHERE status != 'running'` claim plus a heartbeat column, and reap runs whose heartbeat is stale rather than whose start time is old.

---

## Finding 8: The memory estimate ignores how D1 returns BLOBs, and edge construction has no degree cap

- **Severity:** High
- **Location:** Phase 6, "Key Insights" (128 MB / 14 MB estimate), step `build_edges`, Risk Assessment; Phase 5, `new-edges.ts`

**Flaw (a):** The plan budgets 3,500 × 1024-dim vectors as "~14 MB" — the size of packed `Float32Array`s. That is not what comes out of D1. The D1 client API converts `BLOB` to a JavaScript **Array of numbers** (`ArrayBuffer` values are converted with `Array.from`), so a 4 KB vector arrives as a 4,096-element JS array, roughly 4–8× the byte cost plus per-array object overhead, before `vector-codec.ts` repacks it. The 500-row chunk size was chosen with no reference to this.

**Flaw (b):** The research model is claim-claim similarity *kNN* plus an entity boost. The plan kept the weight threshold and dropped the k: `new-edges.ts` is specified as "edges for new claims against claims in the window" with no per-node degree cap. Edge count is therefore quadratic in the size of the largest topical burst, and the plan's memory reasoning covers vectors only — never the edge set that `cluster` must hold in the same 128 MB isolate alongside the library's internal graph.

**Failure scenario:** A major release day produces 300 mutually-similar claims inside the window. `build_edges` compares 300 new claims × 3,500 window claims; with no top-k cap, tens of thousands of pairs clear the threshold, dominated by the 300×300 intra-burst block (~45,000 edges from one burst). Those rows are upserted into `claim_edges` through 100-bound-parameter chunks — with 6 columns that is ~16 rows per statement, i.e. ~2,800 statements in one job, executed sequentially inside D1's implicit transaction. The next hour's `cluster` step loads every edge in the window as a JS object graph, which together with the decoded vectors and the clusterer's own adjacency structures is where the 128 MB ceiling is actually hit. The plan's stated tripwire is "`build_edges` takes more than 2 minutes → reduce the chunk to 200 rows", which addresses neither the JS-array marshalling cost nor the quadratic edge count. Note also that `claim_edges` appears in no retention policy — every other derived table has one — so the table grows monotonically while the embeddings it was computed from are deleted at 30 days.

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:23` — "3.500 vector 1024 chiều, khoảng 14 MB, nằm trong giới hạn".
- Cloudflare D1 client API docs, type-conversion table: "ArrayBuffer | BLOB | Array" and "`ArrayBuffer` and ArrayBuffer views are converted using `Array.from`" (https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/).
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:42` — "nạp vector trong cửa sổ theo khúc 500 dòng"; `:91` — "Tín hiệu: bước `build_edges` quá 2 phút. Phản ứng: giảm khúc còn 200 dòng".
- `plans/260920-0838-content-radar-v1/phase-05-graph-core-package.md:44` — "`graph/new-edges.ts` cạnh cho claim mới so với claim trong cửa sổ" (no k); `:57` — threshold only.
- `plans/260920-0838-content-radar-v1/research/researcher-260920-0735-graph-leiden-and-sources.md:42` — the recommended model is "embedding cosine **kNN** + shared-entity boost".
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:50` — retention list; `claim_edges` absent.
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:23` — "D1 giới hạn 100 tham số bind và 100 KB mỗi câu lệnh".

**Suggested fix:** Add `max_neighbours_per_claim` (e.g. 30) to the params and make `new-edges.ts` return only the top-k above threshold; this bounds memory, edge writes, and cluster-step cost in one parameter. Store vectors as base64 `TEXT` or decode chunk-by-chunk into a pre-allocated `Float32Array` pool and never retain the D1 row arrays. Re-derive the memory budget including the edge set and state the fixture's edge count in the Phase 6 success criterion (currently only the claim count is specified). Add `claim_edges` to the retention policy with the same horizon as `claim_embeddings`.

---

## Finding 9: Clustering parameters are undefined, duplicated across two owners, and have no stability protocol or acceptance bar

- **Severity:** High
- **Location:** Phase 5, `Clusterer.cluster` and step 5; Phase 2, `config/settings.json` defaults; Phase 9, tuning step and Success Criteria

**Flaw:** Three compounding gaps around the single highest-risk mechanism in the system.

1. **The values do not exist.** The defaults list in Phase 2 enumerates window, entity thresholds, Jaccard thresholds, lookback, score weights, half-life, display floor, quota reserve, timezone — and contains no CPM gamma, no edge-weight threshold, no `w_cos`/`w_ent`, and no clustering seed. Yet Phase 6 reads "seed cố định lấy từ `settings`" and Phase 9 tunes "`resolution` của Leiden, ngưỡng trọng số cạnh".
2. **Two owners for the same state.** Graph parameters live in `packages/core/src/params.ts` (versioned, `PARAMS_VERSION`) *and* in the D1 `settings` table, and Phase 9 modifies both. Nothing says which wins at runtime, or what happens when `cluster_runs.params_json` records one and the core library compiled another.
3. **No stability protocol and no pass/fail bar.** The research explicitly advises "run Leiden at a few gamma values and check community-count stability rather than trusting a single gamma"; the plan instead derives one global gamma from a hand-built 5-story fixture and freezes it. The soak week measures lineage stability but the Phase 9 success criteria contain no threshold for it — only a manual "16 of 20 stories look coherent" check.

**Failure scenario:** CPM's gamma is a density threshold expressed in the same units as edge weights. The plan's weights are `w_cos * max(0, cosine) + w_ent * idfOverlap`, and bge-m3 cosines on short English text sit in a compressed high band (unrelated technical sentences routinely score 0.6–0.8), so the usable gamma range is narrow and data-dependent. A gamma tuned on a synthetic fixture built to separate cleanly will, on real data, land on one side of the cliff: slightly too high and nearly everything is a singleton (feeding Finding 1); slightly too low and the whole window collapses into one giant community, which then takes the entire `stories` table with it on the next run via a mass `merge`. Because the soak criteria have no lineage-stability bar, a week that produced 60% `birth`/`death` churn still passes every listed checkbox. Phase 1's Leiden spike does not close this either: it validates import, determinism and *API support* for CPM and weights on karate club — an unweighted benchmark graph — not CPM behaviour on continuous weights in [0,1].

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:61` — the complete defaults list (no gamma, no edge threshold, no weights, no seed).
- `plans/260920-0838-content-radar-v1/phase-06-cluster-job-and-card-synthesis.md:43` — "gọi `Clusterer` với seed cố định lấy từ `settings`"; `plans/260920-0838-content-radar-v1/phase-09-deploy-soak-and-docs.md:66` — "Hiệu chỉnh ... `resolution` của Leiden, ngưỡng trọng số cạnh".
- `plans/260920-0838-content-radar-v1/phase-05-graph-core-package.md:38` — "`params.ts` tham số mặc định + PARAMS_VERSION"; `plans/260920-0838-content-radar-v1/phase-09-deploy-soak-and-docs.md:58` — "Modify: `config/settings.json` **và** `packages/core/src/params.ts`" (two owners).
- `plans/260920-0838-content-radar-v1/phase-05-graph-core-package.md:76` — "ghi lại giá trị `resolution` mặc định tìm được vào `params.ts`" (one gamma from one synthetic fixture).
- `plans/260920-0838-content-radar-v1/research/researcher-260920-0735-graph-leiden-and-sources.md:45` — "run Leiden at a few gamma values and check community-count stability rather than trusting a single gamma" (advice dropped).
- `plans/260920-0838-content-radar-v1/phase-09-deploy-soak-and-docs.md:49` (metric collected) vs `:84-89` (success criteria, no lineage-stability threshold).
- `plans/260920-0838-content-radar-v1/phase-01-foundation-and-spikes.md:66` — the spike runs on "đồ thị karate club gắn cứng trong code", an unweighted fixture.

**Suggested fix:** Name every clustering parameter with a concrete default in Phase 2 (gamma, edge threshold, `w_cos`, `w_ent`, seed, max degree). Declare `params.ts` the single source of truth and make `settings` an override layer that is snapshotted into `cluster_runs.params_json` every run — one owner, one audit trail. Extend the Phase 1 spike to run CPM on a *weighted* graph with weights drawn from the real cosine distribution. Add a gamma sweep (3–5 values, community-count and size-distribution stability) as a Phase 5 deliverable, and add a hard soak bar: `continue` events ≥ 85% of all matches, and no run where >20% of live stories change `story_id`.

---

## Finding 10: Quote validation will silently discard claims, and the metric meant to detect it has nowhere to live

- **Severity:** Medium
- **Location:** Phase 4, extract schema validation and batching; Phase 2, `items` and `llm_calls` schemas; Phase 9, soak metrics

**Flaw:** Every claim must carry a `quote` that is a substring of the item content "after whitespace normalisation", or the claim is dropped. Three unstated assumptions: (i) that whitespace normalisation is sufficient normalisation; (ii) that "item content" is a single well-defined string; (iii) that dropped claims are counted somewhere.

**Failure scenario:** Sources are Vietnamese, English and CJK social text. Vietnamese arrives in both NFC and NFD (decomposed diacritics) depending on the platform; X posts contain U+2019 curly apostrophes, U+00A0 non-breaking spaces and zero-width joiners in emoji sequences; CJK text has no whitespace at all so whitespace collapsing does nothing, while full-width vs half-width punctuation differ by codepoint. An LLM asked to quote verbatim routinely normalises exactly these characters. The result is not a loud failure: the claim is discarded, the item is still marked `extracted`, and an item that produced three good claims looks identical to an item that produced none. Compounding it, the plan never says which string is the validation authority — `items.text_excerpt` (name implies truncation), the 6,000-character slice actually sent to Gemini, or the raw R2 payload — so an implementer can pick one for the prompt and another for validation and the mismatch surfaces only as a mysteriously high rejection rate. And there is no rejection rate: the discard writes no row anywhere. `claims` holds only accepted claims; `llm_calls` has no rejected-claim counters and no item key. Yet the Phase 4 risk tripwire ("rejection rate over 15% → reduce batch size") and the Phase 9 soak metric ("tỉ lệ claim bị loại vì `quote` không khớp") both require exactly that number. Both are uncomputable as specified — the plan's only defence against batching degrading extraction quality cannot be observed.

**Evidence:**
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:59` — "`quote` phải là chuỗi con của nội dung item (so khớp sau khi chuẩn hoá khoảng trắng), nếu không claim bị loại".
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:39` — "cắt mỗi item tối đa 6.000 ký tự" vs `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:40` — `items(..., text_excerpt, ..., raw_r2_key, ...)`: three candidate authorities, none designated.
- `plans/260920-0838-content-radar-v1/phase-02-data-model-and-config.md:45` — `llm_calls(id, at, model, kind, status, http_status, latency_ms, tokens_in, tokens_out, error)`: no claim-rejection counters, no item key.
- `plans/260920-0838-content-radar-v1/phase-04-llm-extraction-and-budget.md:100` and `plans/260920-0838-content-radar-v1/phase-09-deploy-soak-and-docs.md:50` — both depend on a rejection rate that is never stored.

**Suggested fix:** Normalise both sides with NFC + Unicode whitespace class + quote/dash folding + case-insensitive compare before the substring test, and fall back to a high-threshold fuzzy match (e.g. token-level containment) before discarding. Designate `items.text_excerpt` as the single validation authority and require the prompt to be fed from the same column. Add `llm_extractions(item_id, call_id, claims_returned, claims_accepted, reject_reason_json)` so the tripwire and the soak metric have a source — as written, two of the plan's own control mechanisms read state that no writer produces.

---

## Cross-cutting note on effort

The 18-day total carries no buffer for the contingencies the plan itself enumerates. Phase 5 is 3 days for twelve pure modules, a Leiden adapter, four fixtures, `fast-check` property tests and ≥90% line coverage; its own risk section then adds "+2–4 days" for an in-house Leiden without adjusting the total (`phase-05-graph-core-package.md:96-103`). Phase 9 is 2 working days for the production checklist, KOL backfill, seven daily soak reports, two tuning rounds, a backup script, three documents, an end-to-end acceptance reconciliation and a live analyst session (`phase-09-deploy-soak-and-docs.md:60-69`). Phase 1's three named risks (placement, Leiden, FxTwitter) each have a response that costs days, and none is reflected in the phase table (`plan.md:41-51`). Treat 18d as the no-surprises floor, not the estimate.

---

Status: DONE_WITH_CONCERNS
