# Red Team Review: Scope & Complexity Critic + Contract Verifier

Plan: `plans/260920-0838-content-radar-v1/` (Content Radar v1)
Reviewer perspective: unrequested-scope detection, needless complexity, cross-phase interface verification.
Repo state: greenfield (no product code). All evidence is `file:line` into plan/research files.
Scope constraint honored: `--yagni` was NOT passed. Requested features are treated as fixed; only additions beyond the contract and complexity in HOW requested features are delivered are flagged as defects.

---

## Finding 1: The `READY` gate and the heaviest score component consume data that no phase ever produces

- **Severity:** Critical
- **Location:** Phase 5, "Architecture" / `countIndependentSources`; Phase 2, "Architecture" (Claim và entity); Phase 3, "Architecture" (bộ lọc rẻ)
- **Flaw:** `countIndependentSources(claims, derivations, authorAliases)` consumes two inputs whose producers are missing from every phase. (a) `claims.derived_from_claim_id` is declared in the phase-2 schema and never written by phase 3, 4, or 6 — the phase-4 extract output schema has no derivation field at all, and no cluster step derives it from `items.parent_external_id`. (b) Cross-platform author aliasing: phase 3 only "upserts author and item" per platform handle; no phase merges the same human's X handle with their blog byline, so `authors` is effectively one row per platform identity. Research explicitly specified both producers; the plan copied the consumer and dropped them.
- **Failure scenario:** Simon Willison tweets a claim and blogs the same claim; two `author_handles` rows exist under two different `authors` rows, so `countIndependentSources` returns 2 → `independent_sources = 2` → `status = ready`. Separately, three accounts quote-tweet one OpenAI announcement: the cheap filter drops reposts but explicitly keeps quotes (`phase-03:57` drops only `repost` and `reply`), so each quote becomes an item → a claim with a distinct `author_id` and `derived_from_claim_id = NULL` → 4 "independent sources" from one origin. The `READY` badge — the single product distinction the contract specifies (`contract:35`) — becomes noise, and `S_sources` (weight 0.30, the largest term) is systematically inflated, which also corrupts the whole ranking. This is precisely the failure phase 5 names as its own top risk and then does not wire up.
- **Evidence:**
  - `phase-05-graph-core-package.md:60` — "`countIndependentSources(claims, derivations, authorAliases)`: hai claim độc lập khi khác tác giả sau khi gộp alias tác giả, không cái nào là repost hay quote của cái kia"
  - `phase-05-graph-core-package.md:25` — "nếu không một bài được repost mười lần sẽ thành mười nguồn và cổng `READY` mất nghĩa"
  - `phase-02-data-model-and-config.md:41` — `claims(... derived_from_claim_id, created_at)` (only mention of the column in the entire plan; `grep -rn derived_from` returns this line and the research report only)
  - `phase-03-source-adapters-and-ingest.md:47` — "upsert tác giả và item" (no cross-platform identity merge)
  - `phase-03-source-adapters-and-ingest.md:57` — "bỏ `repost` (vẫn lưu item để giữ quan hệ), bỏ `reply` trừ khi tự trả lời chính mình" (quotes survive into `radar-llm`)
  - `phase-04-llm-extraction-and-budget.md:54-56` — extract output schema: no derivation field
- **Suggested fix:** Add an explicit producer step and name its owner phase: (1) phase 4 or a new phase-6 step resolves `derived_from_claim_id` from `items.parent_external_id` + `items.kind IN (quote, repost)` and from `canonical_url` citation matching; (2) phase 2/3 add an `author_aliases` (or reuse `author_handles` with a manual-merge path) plus a documented rule for how two handles become one `author_id`. Both belong in the phase-3/4 "Related Code Files" lists, not just in the core function signature.

---

## Finding 2: The retry budget exceeds queue retention, so the "no item is lost" acceptance criterion cannot hold under sustained quota shortage

- **Severity:** Critical
- **Location:** Phase 4, "Key Insights" + "Requirements" + "Architecture"
- **Flaw:** The plan configures `max_retries = 50` and a per-retry delay "up to 12 hours each" when the model chain is exhausted, while acknowledging Queues retains a message for only 14 days. 50 × 12h = 25 days of intended backlog life against a 14-day hard retention ceiling. Messages that expire from retention do not land in the DLQ (DLQ is fed by retry exhaustion, not by TTL expiry), so the loss is silent and the phase-4 DLQ consumer never marks those items `failed`.
- **Failure scenario:** Free-tier RPD turns out lower than the item rate — exactly the situation phase 9 lists as a live risk ("backlog tăng đều qua các ngày"). Messages queued on day 1 are retried with 12h delays; by day 14 they silently vanish from `radar-llm`. Their `items` rows stay `status = queued` forever, invisible to the DLQ counter, invisible to phase 9's success check "Sau lần hết quota, số item `extracted` + `irrelevant` + `failed` bằng số item đã `queued`" — that equation will just never balance, with no diagnostic pointing at retention. Contract acceptance criterion 1 ("không mất dữ liệu") is unprovable.
- **Evidence:**
  - `phase-04-llm-extraction-and-budget.md:24` — "Queues giữ message 14 ngày ... tối đa 100 lần retry; đủ để backlog sống qua nhiều ngày hết quota"
  - `phase-04-llm-extraction-and-budget.md:31` — "`retry` với độ trễ tới thời điểm đặt lại quota, tối đa 12 giờ mỗi lần"
  - `phase-04-llm-extraction-and-budget.md:37` — "`max_retries = 50`"
  - `phase-09-deploy-soak-and-docs.md:85` — "số item `extracted` cộng `irrelevant` cộng `failed` bằng số item đã `queued`"
  - `research/brainstorm-260920-0730-content-radar-contract.md:43` — "khi hết quota Gemini thì việc dồn vào backlog và không mất dữ liệu"
- **Suggested fix:** Make D1 the backlog of record, not the queue. Either (a) cap total in-queue lifetime below 14 days and, when the cap is hit, write the item back to `status = queued` and re-enqueue it from a scheduled drain job driven by a D1 query, or (b) drop the queue as the backlog entirely for the exhausted-quota path: on exhaustion, `ack` the message and let the 30-minute cron re-enqueue `queued` items when budget exists. Add an explicit soak check for "items in `queued` older than 14 days".

---

## Finding 3: Edges are frozen at creation time with that run's IDF, and post-adjudication entity merges never recompute them — the reproducibility criterion is false as written

- **Severity:** High
- **Location:** Phase 6, "Key Insights" + steps `resolve_entities` / `build_edges`
- **Flaw:** `build_edges` computes IDF over the current window and calls `newEdges` for new claims only, then persists the result. Edge weights therefore encode the entity-IDF distribution and the entity-resolution state *at the hour the edge was created*. Two independent mutators break this after the fact: (1) the window slides hourly so IDF drifts; (2) the adjudication path deliberately attaches an unresolved mention to a throwaway new entity so the claim can enter the graph now, then re-attaches it to the real entity when Gemini's verdict arrives — silently changing `idfOverlap` for every edge already written that touched that claim. Nothing recomputes those edges. Yet phase 6 claims "graph dựng lại được y hệt từ D1 nên kết quả lặp lại được" and the plan's success criteria promise "Chạy lại Leiden trên cùng dữ liệu với cùng seed cho cùng phân hoạch".
- **Failure scenario:** At 10:00 a mention "MCP" is ambiguous, gets temp entity #9001, and 40 edges are written using an IDF that treats #9001 as a rare entity (high overlap weight). At 11:00 Gemini adjudicates it as "Model Context Protocol" (entity #12, very common, low IDF). The mention is re-pointed; the 40 existing edges keep their inflated weights while all new edges for the same entity get low weights. The graph now contains two incompatible weight regimes for the same entity pair, Leiden glues the temp-era claims into an artificially dense community, and the "replay from D1 gives the same partition" claim holds only because the *stale* weights are replayed — a rebuild from raw claims would produce a different partition. The acceptance criterion is satisfied by a bug rather than by determinism, which is worse than failing it, because the soak report will mark it green. Also note `entity_aliases.alias_normalized` is globally `UNIQUE` (`phase-02:41`), so re-pointing a temp entity's alias to the real entity is a constraint conflict with no stated resolution.
- **Evidence:**
  - `phase-06-cluster-job-and-card-synthesis.md:24` — "Tính cosine chính xác chỉ giữa claim mới và claim trong cửa sổ, rồi lưu cạnh vào `claim_edges` ... graph dựng lại được y hệt từ D1 nên kết quả lặp lại được"
  - `phase-06-cluster-job-and-card-synthesis.md:42` — "`build_edges`: ... tính IDF, gọi `newEdges` cho claim mới, upsert `claim_edges`"
  - `phase-06-cluster-job-and-card-synthesis.md:40` — "trong lúc chờ, mention tạm gắn vào một entity mới để claim vẫn vào graph, và được gộp lại khi có phán quyết"
  - `plan.md:59` — "Chạy lại Leiden trên cùng dữ liệu với cùng seed cho cùng phân hoạch"
  - `phase-02-data-model-and-config.md:41` — "`entity_aliases(entity_id, alias_normalized UNIQUE, source, confidence)`"
- **Suggested fix:** Add an explicit edge-invalidation rule to phase 6: when an adjudication verdict re-points mentions, delete and recompute all `claim_edges` touching the affected claims; and either recompute IDF-dependent weights for the whole window each run (cheap at 3,500 nodes) or store the IDF snapshot in `cluster_runs.params_json` and state plainly that reproducibility is "replay of stored edges", not "rebuild from claims". Also define the alias-uniqueness resolution for temp-entity merges.

---

## Finding 4: Scoring and synthesis are mutually gating — stories that need a counterpoint to clear the display threshold can never be synthesized

- **Severity:** High
- **Location:** Phase 6, steps `score` / `enqueue_synthesis`; Phase 7, `GET /api/stories`
- **Flaw:** `S_counter` (weight 0.10) and the `evidence` / `context` / `counter` roles are assigned only by the Gemini `synthesize` job, but `enqueue_synthesis` only queues stories that already reach the minimum display score (default 40). So a story's score is computed from an input that scoring itself gates. `S_specificity` has the same shape: the research defines it as "fraction of **evidence** lines" containing numbers, and roles do not exist until after synthesis. Phase 6 acknowledges half the loop ("rồi tính lại điểm vì `S_counter` có thể đổi") without noticing it created a starvation condition on the other half.
- **Failure scenario:** A story scores 34 pre-synthesis, and it contains a strong HN counterpoint comment that would push it to 44 — exactly the "counterpoint" card the reference UI highlights. It never crosses 40, so it is never enqueued for synthesis, so it never gets `headline_vi`, so phase 7's inbox tab (which requires "đã có headline và đạt điểm hiển thị tối thiểu") never shows it, so the user never sees it, so it never gets a `user_action` that could recalibrate weights. The system permanently hides its most editorially valuable class of lead, and no metric in the phase-9 soak report detects it.
- **Evidence:**
  - `phase-06-cluster-job-and-card-synthesis.md:46` — "`enqueue_synthesis`: xếp hàng `synthesize` cho câu chuyện đạt điểm hiển thị tối thiểu"
  - `phase-06-cluster-job-and-card-synthesis.md:48` — "đặt `has_counter` và `synthesized_hash`, rồi tính lại điểm vì `S_counter` có thể đổi"
  - `phase-05-graph-core-package.md:61` — "`0.10*S_counter`" and "`0.15*S_specificity`"
  - `research/researcher-260920-0735-graph-leiden-and-sources.md:95` — "`S_specificity` = rule-based fraction of **evidence** lines"
  - `phase-02-data-model-and-config.md:61` — "điểm hiển thị tối thiểu 40"
  - `phase-07-api-and-web-ui.md:38` — "Tab `inbox` trả câu chuyện ... đã có headline và đạt điểm hiển thị tối thiểu"
- **Suggested fix:** Break the cycle explicitly. Compute `S_specificity` from `claims.has_numbers` / `claims.first_hand` over all story claims (role-independent — the columns already exist), and gate `enqueue_synthesis` on a pre-synthesis score that treats `S_counter` optimistically (e.g. gate on `score + 0.10*100` or on a separate, lower `synthesis_min_score` setting). Write the chosen rule into phase 6 and into `config/settings.json`.

---

## Finding 5: `S_novelty` (weight 0.15) has no producer — no story-centroid table, no step, and a window mismatch

- **Severity:** High
- **Location:** Phase 6, "Architecture" (seven hourly steps); Phase 2, "Architecture" (Claim và entity)
- **Flaw:** `scoreStory` consumes `S_novelty`, defined by the research as `1 - max cosine(this story's centroid, other active different-lineage stories in the last 30 days)`. Phase 2's schema has `claim_embeddings` and `entity_embeddings` but no story/centroid embedding. Phase 6's seven named steps contain no centroid computation and no cross-story similarity step; the `score` step's write list (`score, subscores_json, independent_sources, status, label_entity_id, last_claim_at, members_hash, search_text`) contains nothing embedding-shaped. Additionally the comparison window (30 days) exceeds the graph window (7 days), and the daily retention job deletes `claim_embeddings` for claims more than 30 days out of window — so the inputs for a 30-day centroid comparison are only incidentally present.
- **Failure scenario:** The implementer reaches phase 6 step 6, finds `scoreStory` requires a `novelty` input with no source, and takes the path of least resistance: hardcodes `S_novelty = 1` (or 0.5) "for now". Every story then receives an identical constant for 15% of its score; a story that is the fifth re-run of the same "OpenAI ships X" narrative ranks identically to a genuinely new one. The radar's core promise — surfacing what is *new* — degrades to an engagement-plus-source-count ranking, and because the sub-score is logged in `subscores_json` as a plausible number, the phase-9 calibration step will happily tune weights around a constant.
- **Evidence:**
  - `phase-05-graph-core-package.md:61` — "`+ 0.15*S_novelty`"
  - `research/researcher-260920-0735-graph-leiden-and-sources.md:97` — "`S_novelty = 1 - max_cosine_similarity` of this story's centroid embedding against other currently active, different-lineage stories in the last 30 days"
  - `phase-02-data-model-and-config.md:41` — embedding tables listed: `entity_embeddings`, `claim_embeddings` only
  - `phase-06-cluster-job-and-card-synthesis.md:38-46` — seven steps, none computing story centroids
  - `phase-06-cluster-job-and-card-synthesis.md:45` — `score` step write list, no centroid
  - `phase-06-cluster-job-and-card-synthesis.md:50` — "`claim_embeddings` của claim ra khỏi cửa sổ quá 30 ngày" (retention vs the 30-day novelty comparison)
- **Suggested fix:** Either add a `story_embeddings(story_id, run_id, model, vector)` table to a phase-6-owned migration plus a centroid step and a documented novelty window, or change the formula in `params.ts` to a producible definition and redistribute the 0.15 weight. Do not leave a scored term without a data path.

---

## Finding 6: Two independent sources of truth for every threshold and weight, authored by two phases that the plan says run in parallel

- **Severity:** High
- **Location:** Phase 2, step 3 (`config/settings.json`); Phase 5, "Requirements" + step 1 (`params.ts`); Phase 9, "Related Code Files"
- **Flaw:** The identical constant set — 7-day window, entity thresholds 0.92/0.75, Jaccard 0.5/0.3, lookback 3 runs, score weights 0.30/0.20/0.15/0.10/0.15/0.10, 48h half-life — is specified to live in both `config/settings.json` (synced into the D1 `settings` table) and `packages/core/src/params.ts` (with its own `PARAMS_VERSION`). Phase 5 then contradicts itself between its Requirements ("giá trị mặc định tập trung ở một file có số phiên bản") and its Risk Assessment ("mọi ngưỡng là tham số trong bảng `settings`"). Phase 9 codifies the duplication by listing both files as things to edit during calibration. No phase states which wins at runtime, and `plan.md:53` schedules phases 2 and 5 to be executed in parallel, so two workstreams will author the same numbers independently.
- **Failure scenario:** During phase-9 calibration the Leiden `resolution` is lowered in `config/settings.json` and synced to D1, but `params.ts` keeps the old default and `PARAMS_VERSION` is not bumped. Phase 6's `cluster` step reads the seed from `settings` but `@radar/core` applies its own default resolution for any parameter the caller forgets to pass — a partially-overridden parameter set. The partition changes for reasons not recorded in `cluster_runs.params_json`, lineage matching sees a mass re-partition, `split`/`merge` events fire across the board, saved stories detach from their `story_id`, and the user's Save state appears to randomly jump between cards. Debugging requires realizing two config systems exist.
- **Evidence:**
  - `phase-02-data-model-and-config.md:61` — "`config/settings.json` với giá trị mặc định: cửa sổ 7 ngày, ngưỡng entity 0.92 và 0.75, ngưỡng Jaccard 0.5 và 0.3, lookback 3 lần chạy, trọng số điểm 0.30/0.20/0.15/0.10/0.15/0.10, nửa đời 48 giờ"
  - `phase-05-graph-core-package.md:32` — "giá trị mặc định tập trung ở một file có số phiên bản"
  - `phase-05-graph-core-package.md:72` — "Viết `params.ts` với toàn bộ giá trị mặc định và `PARAMS_VERSION = 1`"
  - `phase-05-graph-core-package.md:104` — "mọi ngưỡng là tham số trong bảng `settings`" (contradicts :32)
  - `phase-09-deploy-soak-and-docs.md:58` — "Modify: `config/settings.json` và `packages/core/src/params.ts`"
  - `plan.md:53` — "Phase 3, 4 và 5 độc lập về file nên có thể làm song song sau phase 2"
- **Suggested fix:** Pick one owner. Recommended: `params.ts` defines the *shape* and a typed default object with `PARAMS_VERSION`; `config/settings.json` holds only overrides; the worker merges `params.defaults` ← `settings` rows at job start and writes the merged, resolved set into `cluster_runs.params_json`. Delete the duplicate literal list from phase 2 step 3 and replace it with a pointer to `params.ts`.

---

## Finding 7: The 15-day X backfill is unrequested scope that corrupts the velocity baseline, burns the scarcest resource first, and does not deliver the benefit phase 8 claims for it

- **Severity:** High
- **Location:** Phase 3, Requirements + step 7 (`admin-backfill.ts`); Phase 9, Requirements + step 3 (`backfill-kols.sh`)
- **Flaw:** Backfill appears nowhere in the contract (no mention in Outcome, Constraints, Phạm vi bản đầu, or Acceptance criteria). It is justified in phase 8 as a way to shorten the wait for momentum views. That justification is wrong: `story_daily` / `entity_daily` are written forward-only by the daily job, and `lineage_events` only exist from the first cluster run onward, so backfilled items create no historical momentum rows at all. Worse, backfill actively damages two computations: (a) `author_baselines` is specified to sample engagement "at roughly 24h after the post", but a post backfilled 15 days late has fully-matured engagement captured once — mixing mature and immature samples into the same median/MAD; (b) `S_velocity` compares a fresh post's engagement against that polluted baseline.
- **Failure scenario:** Day 1 of production: `backfill-kols.sh` walks 30–50 KOLs × 15 days. At ~20 posts per timeline page and typical KOL cadence that is several thousand items; after the cheap filter, on the order of hundreds of `radar-llm` batches. With the phase-2 safe default of 100 RPD per model × 3 models, and `extract` capped at 80% of RPD, the daily extract ceiling is ~240 requests — so the backfill alone consumes one to two full days of Gemini quota before a single live item is processed, while the 30-minute poll cron keeps enqueuing fresh items behind it. Simultaneously, every backfilled post enters `author_baselines` with 15-day-mature engagement numbers, inflating each author's median by an order of magnitude; for the next several weeks every *live* post scores `S_velocity` near zero because it is compared against matured history. The radar launches showing nothing as trending, during the exact 7-day soak window that is supposed to validate acceptance criterion 1.
- **Evidence:**
  - `research/brainstorm-260920-0730-content-radar-contract.md:27-47` — contract scope and acceptance criteria contain no backfill requirement
  - `phase-03-source-adapters-and-ingest.md:35` — "Backfill 15 ngày cho một tài khoản X chạy tay qua endpoint quản trị"
  - `phase-09-deploy-soak-and-docs.md:30` — "Backfill 15 ngày cho danh sách KOL ban đầu"
  - `phase-09-deploy-soak-and-docs.md:64` — "gọi endpoint backfill cho từng handle, cách nhau 30 giây"
  - `phase-08-analyst-layer.md:91` — "phase 9 có bước backfill để rút ngắn thời gian chờ" (benefit claim that forward-only `story_daily`/`entity_daily` cannot deliver)
  - `phase-06-cluster-job-and-card-synthesis.md:68` — "baseline dùng tối đa 50 bài gần nhất của mỗi tác giả ... số liệu lấy tại thời điểm bài được khoảng 24 giờ"
  - `phase-02-data-model-and-config.md:63` — "mức an toàn mặc định 5 RPM và 100 RPD mỗi model"
  - `phase-04-llm-extraction-and-budget.md:49` — "Loại việc `extract` chỉ được dùng tới 80% RPD"
- **Suggested fix (question to the user, since backfill may be wanted despite the cost):** If backfill stays, it must (a) mark backfilled items so `author_baselines` excludes them or weights them separately, (b) run *after* the soak week or behind a quota reservation so it cannot starve live ingest, and (c) drop the phase-8 claim that it accelerates momentum views. If the user does not specifically want historical X content, the simplest path is to delete `admin-backfill.ts` and `backfill-kols.sh` and let the system fill forward — nothing in the contract asks for history.

---

## Finding 8: The analyst layer ships a security-theater SQL guard and three copies of the same rulebook for a contract requirement of "a few queries via wrangler"

- **Severity:** Medium
- **Location:** Phase 8, "Related Code Files" + step 5 + "Risk Assessment"
- **Flaw:** The contract asks that Claude/Codex answer the original question "bằng vài query qua wrangler" and write signals back. Phase 8 delivers: 8 views, 10 parameterized query files, 2 write-back tables, a `run-query.sh` wrapper that keyword-scans SQL files and enforces table allow-listing, `docs/analyst-runbook.md`, `.claude/skills/radar-analyst/SKILL.md`, and `analyst/AGENTS.md` — with the last two explicitly specified to carry "cùng nội dung cốt lõi" as the runbook. Two distinct problems: (1) the wrapper is a textual guard against an agent that has direct `wrangler` in its own shell and can trivially bypass it (the plan itself concedes "an toàn dựa vào quy ước trong runbook"), on a single-user database whose stated recovery layer is already Time Travel — it protects nothing while implying protection; (2) three files carry the same safety rules, a DRY violation in the one artifact class guaranteed to drift.
- **Failure scenario:** Month two, the user tightens the prompt-injection rules after an incident. They edit `docs/analyst-runbook.md`. `SKILL.md` and `analyst/AGENTS.md` still carry the old rules, and those are the files actually loaded into Claude's and Codex's context — the runbook is the only copy a human reads and the only copy that is now correct. Meanwhile `run-query.sh` gives a false sense of containment: an injected instruction inside crawled text tells the agent to run `wrangler d1 execute --command "..."` directly, the wrapper is never invoked, and the guard contributes zero. The "Agent bỏ qua quy ước chỉ đọc" risk entry names this exact bypass and still keeps the wrapper as the mitigation.
- **Evidence:**
  - `research/brainstorm-260920-0730-content-radar-contract.md:47` — "Một phiên Claude trả lời được câu hỏi gốc bằng vài query qua wrangler"
  - `phase-08-analyst-layer.md:60` — ten `analyst/queries/*.sql` files
  - `phase-08-analyst-layer.md:61` — "`analyst/run-query.sh` ... từ chối file chứa từ khoá ghi nếu không có cờ `--write` và chỉ cho ghi vào bảng `analyst_*`"
  - `phase-08-analyst-layer.md:71` — "`analyst/AGENTS.md` có cùng nội dung cốt lõi cho Codex"
  - `phase-08-analyst-layer.md:25` — "`wrangler d1 execute` không có chế độ chỉ đọc, nên an toàn dựa vào quy ước trong runbook"
  - `phase-08-analyst-layer.md:92` — "Agent bỏ qua quy ước chỉ đọc. Phản ứng: script bọc chặn ở tầng lệnh" (the wrapper is not in the bypass path)
- **Suggested fix:** Keep the views, the two write-back tables, and the query files — those are the requested surface. Collapse the three rulebooks into one file (`docs/analyst-runbook.md`) and make `SKILL.md` / `AGENTS.md` one-line pointers to it. Either delete `run-query.sh` and state plainly that safety rests on the runbook convention plus Time Travel, or replace it with something that actually holds — e.g. a dedicated read-only D1 access path — but do not ship a keyword filter described as a containment layer.

---

## Finding 9: The LLM queue contract is underspecified at the phase-4/phase-6 seam: no message shape for `synthesize`/`adjudicate`, and a batch-size contradiction

- **Severity:** Medium
- **Location:** Phase 4, "Architecture" (consumer config + message shape); Phase 6, Requirements + step `enqueue_synthesis`
- **Flaw:** Phase 4 defines exactly one message shape, `{ kind: "extract", itemId }`, and pins the consumer to `max_batch_size = 10` with `max_concurrency = 1`. Phase 6 then adds two producers with no declared message shape and a batching rule that contradicts the consumer config: "`adjudicate` (gom tối đa 20 cặp entity mơ hồ mỗi call)". If one message carries one pair, a batch of 10 can never reach 20 pairs; if one message carries 20 pairs, the producer must pre-batch and the 128 KB message ceiling and the `entity_adjudications` row lifecycle become the producer's concern — neither phase says which. `synthesize` ("một câu chuyện mỗi call") interacts badly with the same config: a batch of 10 synthesize messages becomes 10 sequential Gemini calls inside one invocation, against an RPM check implemented by counting `llm_calls` rows in the trailing 60 seconds — at the phase-2 safe default of 5 RPM, half of every batch fails reservation and is retried. Related: the reservation statement is a bare `UPDATE llm_usage ... WHERE day_pt = ?1 AND model = ?2 AND requests < ?3` with no specified row-creation path; on the first call of each new Pacific day no row exists, the UPDATE affects zero rows, and the code reads that as "model exhausted".
- **Failure scenario:** At 00:00 America/Los_Angeles the `day_pt` key rolls over. No `llm_usage` row exists for the new day. Every model in the chain returns "no row → exhausted", the consumer calls `retryAll({ delaySeconds })` with a delay computed "to the quota reset time, up to 12 hours", and the entire extraction pipeline sleeps for up to 12 hours every single day — at precisely the moment the daily quota became available. The soak report shows backlog depth sawtoothing and quota consistently underused, with no error anywhere, because this is the plan's own written SQL behaving as written.
- **Evidence:**
  - `phase-04-llm-extraction-and-budget.md:37` — "`max_batch_size = 10`, `max_batch_timeout = 60` giây, `max_concurrency = 1`"
  - `phase-04-llm-extraction-and-budget.md:39` — "Message: `{ kind: \"extract\", itemId }`" (the only declared shape in the plan)
  - `phase-04-llm-extraction-and-budget.md:44-46` — `UPDATE llm_usage SET requests = requests + 1 WHERE day_pt = ?1 AND model = ?2 AND requests < ?3 RETURNING requests;`
  - `phase-04-llm-extraction-and-budget.md:48` — "Không có dòng trả về nghĩa là model hết ngân sách trong ngày"
  - `phase-06-cluster-job-and-card-synthesis.md:32` — "`adjudicate` (gom tối đa 20 cặp entity mơ hồ mỗi call) và `synthesize` (một câu chuyện mỗi call)"
  - `phase-06-cluster-job-and-card-synthesis.md:46` — `enqueue_synthesis` step, no message shape given
- **Suggested fix:** Declare all three message shapes in phase 4 (e.g. `{kind:"extract", itemId}`, `{kind:"synthesize", storyId, membersHash}`, `{kind:"adjudicate", adjudicationIds: string[]}`) and have phase 6 reference them rather than restating batching in prose; state whether adjudicate pre-batches at the producer. Change the reservation to an upsert (`INSERT ... ON CONFLICT(day_pt, model) DO UPDATE SET requests = requests + 1 WHERE requests < ?`) so day rollover creates the row, and add a soak check for "first successful call after Pacific midnight".

---

## Finding 10: Two permanent production surfaces are added beyond the requested product, and the phase that secures them does not list them as files it modifies

- **Severity:** Medium
- **Location:** Phase 1, Requirements + step 3 (`admin-probe.ts`); Phase 7, Overview + Requirements + "Related Code Files"
- **Flaw:** (a) The phase-1 spike endpoint is explicitly promoted from a throwaway probe to a permanent fixture ("Endpoint chẩn đoán cố định ... cần công cụ kiểm tra lâu dài") with 13 hardcoded targets, two of which — `leiden` and `workers-ai-embed` — are library-evaluation spikes, not source-reachability checks. That means the karate-club fixture and both Leiden libraries stay linked into the deployed production Worker forever to serve a check that phase 5 already covers with a 20-run determinism test. (b) Phase 7 adds a status page and `GET /api/status` that the contract's product spec never mentions, duplicating the queries phase 9 puts in `scripts/soak-report.sql`. (c) Phase 7 declares that admin routes from phases 1 and 3 must go through its JWT layer, but its "Related Code Files" list does not include modifying `admin-probe.ts` or `admin-backfill.ts` — the wiring is asserted in Requirements and owned by nobody.
- **Failure scenario:** Phase 7 is implemented from its file list. `router.ts` handles `/api/stories*` and `/api/status`; `admin-probe.ts` and `admin-backfill.ts` remain wired directly into `fetch` from phases 1 and 3, never passing through `access-auth.ts`. Phase 7's success criterion ("chưa đăng nhập Access thì mọi `/api/*` bị chặn") still passes, because edge-level Access blocks everything — so the gap is invisible in testing. The Worker's only defense for `POST /api/admin/backfill` (an endpoint that issues up to 15 days of outbound requests per call) is then the dashboard Access policy alone, which is exactly the single point of failure phase 7 says the JWT check exists to avoid ("không phụ thuộc hoàn toàn vào cấu hình dashboard"). Separately, the Worker bundle carries two Leiden libraries it never executes in production.
- **Evidence:**
  - `phase-01-foundation-and-spikes.md:31` — "Endpoint chẩn đoán cố định `GET /api/admin/probe?target=<tên>` ... cần công cụ kiểm tra lâu dài"
  - `phase-01-foundation-and-spikes.md:64` — target list including `workers-ai-embed`, `leiden`
  - `phase-05-graph-core-package.md:97` — "Test tất định: 20 lần chạy liên tiếp trên cùng fixture cho cùng một hash phân hoạch" (the `leiden` probe target duplicates this)
  - `phase-07-api-and-web-ui.md:18` — "Thêm một trang trạng thái hệ thống để biết pipeline còn sống" (not in `contract:32-39` product spec)
  - `phase-07-api-and-web-ui.md:23` — "Worker vẫn kiểm tra JWT của Access để không phụ thuộc hoàn toàn vào cấu hình dashboard"
  - `phase-07-api-and-web-ui.md:28` — "Mọi route `/api/*` yêu cầu JWT Access hợp lệ, kể cả các route quản trị của phase 1 và 3"
  - `phase-07-api-and-web-ui.md:59-63` — Related Code Files: no `Modify: apps/worker/src/api/admin-probe.ts` or `admin-backfill.ts`
  - `phase-03-source-adapters-and-ingest.md:63` — "Create: `apps/worker/src/api/admin-backfill.ts`"
- **Suggested fix:** Scope the probe endpoint to source-reachability targets only and move the `leiden` / `workers-ai-embed` spikes into phase-1 tests or a scratch Worker that is not deployed to production. Add `Modify: apps/worker/src/api/admin-probe.ts, admin-backfill.ts` to phase 7's file list with a success criterion that asserts a 401 from the Worker itself (bypassing edge Access) for every admin route. For the status page: it is a reasonable operability addition for a 7-day unattended run — confirm with the user that it is wanted, and if so, have `scripts/soak-report.sql` read from the same queries rather than maintaining two sets.

---

## Cross-phase contract verification summary

| Interface | Producer | Consumer | Status |
|---|---|---|---|
| `claims.derived_from_claim_id` | **none** | `phase-05:60` `countIndependentSources` | **Missing producer** (Finding 1) |
| cross-platform author identity | **none** (`phase-03:47` per-platform upsert only) | `phase-05:60` `authorAliases` | **Missing producer** (Finding 1) |
| story centroid / `S_novelty` input | **none** | `phase-05:61` `scoreStory` | **Missing producer** (Finding 5) |
| `story_claims.role` | `phase-06:48` synthesize | `phase-06:46` enqueue gate, `phase-05:61` `S_counter`/`S_specificity` | **Circular** (Finding 4) |
| thresholds/weights | `phase-02:61` settings.json **and** `phase-05:72` params.ts | `phase-06:43` cluster, `phase-05` core | **Dual source of truth** (Finding 6) |
| queue message `extract` | `phase-03:47` poll-consumer | `phase-04:39` llm-consumer | OK |
| queue message `synthesize` / `adjudicate` | `phase-06:32,46` | `phase-04:39` (shape undefined) | **Shape undeclared + batch contradiction** (Finding 9) |
| `llm_usage` day row | **none** | `phase-04:44` reservation UPDATE | **Missing producer** (Finding 9) |
| `claim_edges` after entity merge | `phase-06:42` (new claims only) | `phase-06:43` cluster | **Stale, never recomputed** (Finding 3) |
| migrations 0001-0005 | `phase-02:51` | phases 3,4,6,7 | OK |
| migrations 0006-0007 | `phase-08:59` | phase 8 | OK |
| phase-6 migration promised at `phase-02:93` | **none listed in `phase-06:54-59`** | — | Unowned; benign only if phase 6 truly adds no columns (it needs at least an embed-token counter per `phase-06:92`) |
| `apps/worker/src/index.ts` | created `phase-01:56`, modified by `phase-03:64`, `phase-04:66`, `phase-06:58`, `phase-07:60` | — | OK (creator precedes all modifiers) |
| `apps/worker/src/db/stories-repo.ts` | created `phase-02:52`, modified `phase-07:61` | — | OK |
| `admin-probe.ts` / `admin-backfill.ts` auth wiring | created `phase-01:56` / `phase-03:63` | asserted `phase-07:28`, not in `phase-07:59-63` | **Unowned modification** (Finding 10) |

Phase dependency graph (1←2←{3,4}, 1←5, {3,4,5}←6, 6←{7,8}, {7,8}←9) is acyclic and each phase's declared dependencies are sufficient for the files it lists, with one caveat: phase 5 authors threshold defaults that phase 2 also authors, and the plan schedules them in parallel (`plan.md:53`) — see Finding 6.
