---
title: "Phase 2: Mô hình dữ liệu và cấu hình"
status: todo
priority: P1
effort: "1.5d"
dependencies: [1]
---

# Phase 2: Mô hình dữ liệu và cấu hình

## Context Links

- [Contract](./research/brainstorm-260920-0730-content-radar-contract.md), mục Acceptance criteria
- [Nền tảng](./research/researcher-260920-0735-cloudflare-gemini-platform.md), mục 3 (giới hạn D1) và mục 5 (R2)
- [Graph và nguồn](./research/researcher-260920-0735-graph-leiden-and-sources.md), mục Q3, Q4, Q5, Q10
- `reports/spike-results.md` từ phase 1 (cách lưu embedding)

## Overview

Định nghĩa toàn bộ schema D1 bằng migration, lớp truy cập dữ liệu dùng chung, và cấu hình trong repo (chủ đề, nguồn, KOL, feed, tác giả) được đồng bộ vào D1 bằng một lệnh. Schema này cũng mang các khoá chống trùng và cột trạng thái mà những phase sau dựa vào để không mất và không lặp việc.

## Key Insights

- D1 giới hạn 100 tham số bind và 100 KB mỗi câu lệnh, 2 MB mỗi dòng. Ghi hàng loạt phải chia khúc và gửi bằng `db.batch`. Payload thô để ở R2, D1 chỉ giữ trường đã chuẩn hoá.
- D1 là sổ cái của mọi công việc; queue chỉ là tín hiệu đánh thức. Mọi bước chuyển giữa các tiến trình vì vậy cần một cột trạng thái, một mốc thời gian và một khoá chống trùng trong D1 để job bảo trì quét lại được.
- Schema phục vụ ba người đọc: pipeline, giao diện, và Claude/Codex qua wrangler. Tên bảng và cột viết rõ nghĩa, không viết tắt.
- Vai trò `evidence`, `context`, `counter` là quan hệ giữa claim và câu chuyện, không phải thuộc tính của claim, nên nằm ở `story_claims.role`.
- Tham số của thuật toán có một chủ sở hữu duy nhất là `packages/core/src/params.ts`; bảng `settings` chỉ chứa giá trị ghi đè và thiết lập vận hành.

## Requirements

- [ ] Migration tạo đủ các nhóm bảng dưới đây, có khoá ngoại, ràng buộc `CHECK` cho cột enum và index cho mọi đường truy vấn của pipeline và giao diện.
- [ ] Lệnh `npm run config:sync` đọc `config/*.json`, kiểm tra bằng schema, rồi upsert vào D1 (local hoặc remote) mà không xoá trạng thái vận hành như `next_poll_at`, `cursor_json`.
- [ ] Cấu hình khởi đầu có ba chủ đề, danh sách feed đã được probe trong báo cáo nghiên cứu, danh sách KOL khởi đầu cho X, truy vấn HN, repo GitHub, và bảng tác giả nối các handle, feed của cùng một người. Không có nguồn Reddit trong v1 theo quyết định của người dùng.

## Architecture

Nhóm bảng (cột chính; kiểu thời gian là số nguyên epoch giây, UTC):

- **Cấu hình:** `topics(id, slug, name, keywords_json, enabled)`; `sources(id, type, key, label, topic_hint, author_key, priority, poll_interval_min, always_pass, enabled, next_poll_at, cursor_json)` với `type` thuộc `x | hn | rss | github` và `UNIQUE(type, key)`; `settings(key, value_json)`.
- **Sức khoẻ nguồn:** `source_health(source_id, last_ok_at, last_error_at, last_error, consecutive_failures, items_last_poll)`; `poll_log(id, source_id, at, status, http_status, items_new, duration_ms, error)`.
- **Tác giả:** `authors(id, author_key UNIQUE, canonical_name)`; `author_handles(author_id, platform, handle, UNIQUE(platform, handle))`, một tác giả có nhiều handle trên nhiều nền tảng và đó chính là cơ chế alias tác giả; `author_baselines(author_id, platform, metric, median, mad, sample_size, updated_at)`.
- **Nội dung:** `items(id, source_id, platform, external_id, url, canonical_url, author_id, title, text_excerpt, lang, kind, parent_external_id, published_at, fetched_at, raw_r2_key, content_hash, status, filter_reason, topic_hint, ingest_mode, queued_at, enqueue_attempts, claims_returned, claims_accepted, UNIQUE(platform, external_id))` với `kind` thuộc `post | reply | repost | quote | article | story | comment | release`, `status` thuộc `new | filtered_out | queued | extracted | irrelevant | failed`, `ingest_mode` thuộc `live | backfill`. Với X và HN, `external_id` là ID gốc của nền tảng; với RSS và GitHub, `external_id` là `<source_id>:<sha256 của guid>` để một feed không bao giờ chạm được dòng của feed khác. Cột `url` không bao giờ bị cập nhật khi upsert trúng xung đột. `item_links(item_id, canonical_url, PRIMARY KEY(item_id, canonical_url))` ghi các URL mà item trỏ tới, là đầu vào để nhận ra nhiều bài cùng thuật lại một nguồn gốc. `item_metrics(item_id, captured_at, likes, reposts, replies, views, bookmarks, quotes, points, comments, PRIMARY KEY(item_id, captured_at))`.
- **Claim và entity:** `claims(id, item_id, author_id, kind, text_vi, text_en, quote, has_numbers, first_hand, topics_json, published_at, content_hash, derived_from_claim_id, derivation_reason, model, prompt_version, llm_call_id, created_at, UNIQUE(item_id, content_hash))` với `kind` thuộc `measurement | experience | announcement | report | opinion`, `content_hash` là sha256 của `quote` đã chuẩn hoá, `quote` dài tối đa 300 ký tự; `entity_mentions(id, claim_id, surface, normalized, entity_id, resolved_by, provisional)`; `entities(id, canonical_name, type, parent_entity_id, provisional, created_at)`; `entity_aliases(entity_id, alias_normalized UNIQUE, source, confidence)`; `entity_relations(entity_id, related_entity_id, relation_type)`; `entity_adjudications(id, mention_normalized UNIQUE, provisional_entity_id, candidate_entity_id, similarity, status, decision, decided_at)`; `entity_embeddings` và `claim_embeddings` theo cách lưu mà phase 1 đã chốt (BLOB trong D1 với `(id, model, dims, vector)`, hoặc chỉ mục trỏ tới file đóng gói trong R2).
- **Graph và lineage:** `claim_edges(claim_a, claim_b, cosine, created_at, PRIMARY KEY(claim_a, claim_b), CHECK(claim_a < claim_b))` chỉ lưu phần bất biến của cạnh; `job_leases(name PRIMARY KEY, holder, expires_at)`; `cluster_runs(id, started_at, finished_at, heartbeat_at, status, stage, params_json, seed, node_count, edge_count, community_count, quality, error)` với `status` thuộc `running | done | failed`; `run_communities(run_id, community_idx, story_id, size, members_hash)`; `run_members(run_id, community_idx, claim_id)`; `lineage_events(id, run_id, type, story_id, related_story_id, jaccard, at)` với `type` thuộc `birth | continue | split | merge | death | revive`.
- **Thẻ:** `stories(id, label_entity_id, label_text, headline_vi, headline_source, status, score, subscores_json, independent_sources, questions_json, has_counter, topics_json, search_text, entity_signature_json, user_state, user_state_at, first_seen_at, last_claim_at, members_hash, synthesized_hash, synthesized_at, synthesis_attempts, alive, died_at)` với `status` thuộc `lead | ready`, `user_state` thuộc `inbox | saved | dismissed | written`, `headline_source` thuộc `fallback | llm`; `story_claims(story_id, claim_id, role, active, added_run_id, removed_run_id)` với `role` thuộc `evidence | context | counter | unassigned`; `user_actions(id, story_id, action, at, score_at_action, subscores_json)`.
- **Tổng hợp theo ngày:** `story_daily(story_id, day, claim_count, source_count, score, engagement)`; `entity_daily(entity_id, day, claim_count, author_count, engagement)` với `day` lấy theo `claims.published_at`, nhờ đó dữ liệu backfill lấp được lịch sử.
- **LLM:** `llm_models(model, priority, rpm, rpd, tpm, enabled, exhausted_until)`; `llm_usage(day_pt, model, kind, requests, tokens_in, tokens_out, PRIMARY KEY(day_pt, model, kind))` với `kind` thuộc `extract | extract_backfill | synthesize | adjudicate`, dòng được tạo bởi chính câu lệnh đặt chỗ nên ngày mới không cần seed; `llm_calls(id, at, model, kind, prompt_version, status, http_status, latency_ms, tokens_in, tokens_out, item_ids_json, claims_returned, claims_accepted, reject_reasons_json, error)`.

Lớp truy cập dữ liệu nằm ở `apps/worker/src/db/`, mỗi nhóm bảng một file, chỉ dùng prepared statement. Hàm `chunkedBatch(db, statements, size)` lo việc chia khúc.

## Related Code Files

- Create: `apps/worker/migrations/0001_config_and_sources.sql`, `0002_content.sql`, `0003_claims_and_entities.sql`, `0004_graph_and_stories.sql`, `0005_llm_budget.sql`
- Create: `apps/worker/src/db/batch.ts`, `sources-repo.ts`, `authors-repo.ts`, `items-repo.ts`, `claims-repo.ts`, `entities-repo.ts`, `graph-repo.ts`, `stories-repo.ts`, `llm-repo.ts`, `settings-repo.ts`
- Create: `config/topics.json`, `config/sources.json`, `config/authors.json`, `config/settings.json`, `config/stop-entities.json`, `config/config.schema.ts`
- Create: `scripts/sync-config.ts`
- Create: `apps/worker/test/db/*.test.ts`

## Implementation Steps

1. Viết năm file migration theo nhóm bảng ở trên. Áp dụng local bằng `wrangler d1 migrations apply content-radar --local` (xác nhận cờ bằng `--help`).
2. Viết `batch.ts` và các repo. Mọi upsert dùng `INSERT ... ON CONFLICT DO UPDATE` để pipeline idempotent; upsert `items` không đưa `url`, `source_id`, `published_at` vào mệnh đề cập nhật.
3. Soạn `config/topics.json` với ba chủ đề và từ khoá; `config/sources.json` với feed đã probe ở mục Q10 của báo cáo nghiên cứu, 30 đến 50 tài khoản X khởi đầu về AI, agent, system design, backend (người dùng sửa sau), các truy vấn HN Algolia, danh sách repo theo dõi release; `config/authors.json` nối handle X, feed blog và tài khoản HN của cùng một người vào một `author_key`; `config/stop-entities.json` với các entity quá chung như "AI", "LLM", "model".
4. Soạn `config/settings.json` chỉ gồm thiết lập vận hành: điểm hiển thị tối thiểu 40, điểm tối thiểu để tổng hợp headline 30, phần quota dành riêng cho tổng hợp 20%, phần quota tối đa cho backfill 25%, múi giờ hiển thị `Asia/Ho_Chi_Minh`, mức an toàn mặc định 5 RPM và 100 RPD khi `llm_models` chưa có số thật, và một khối `core_overrides` để trống. Tham số thuật toán không lặp lại ở đây; chúng nằm trong `params.ts` của phase 5.
5. Viết `scripts/sync-config.ts`: kiểm tra bằng schema (zod), trong đó handle X phải khớp `^[A-Za-z0-9_]{1,15}$`; sinh câu lệnh upsert; thực thi qua `wrangler d1 execute` với cờ `--local` hoặc `--remote`. Nguồn bị gỡ khỏi file thì chuyển `enabled = 0`, không xoá dòng để giữ lịch sử.
6. Seed `llm_models` với ba model theo thứ tự ưu tiên và hạn mức để trống; phase 9 yêu cầu người dùng điền số thật.
7. Viết test tích hợp chạy trong `workerd` với D1 local: upsert item hai lần không tạo bản ghi trùng và không đổi `url`; hai feed RSS có cùng `guid` tạo hai item riêng; chèn claim trùng `(item_id, content_hash)` bị bỏ qua; `chunkedBatch` chia đúng khi vượt 100 tham số; ràng buộc `CHECK` từ chối giá trị enum lạ.

## Todo

- [ ] Năm file migration áp dụng sạch trên D1 local
- [ ] Lớp repo và `chunkedBatch`
- [ ] Năm file cấu hình và schema kiểm tra
- [ ] `npm run config:sync` cho local và remote
- [ ] Seed `llm_models`
- [ ] Test tích hợp D1 gồm các ca chống trùng và chống ghi đè

## Success Criteria

- `wrangler d1 migrations apply --local` chạy sạch từ database trống; chạy lại không đổi gì.
- `npm run config:sync -- --local` hai lần liên tiếp cho cùng số dòng trong `sources`, `topics`, `authors`.
- Test D1 xanh, gồm ca hai feed trùng `guid` và ca claim trùng khoá.

## Risk Assessment

- Schema thay đổi khi phase 5 và 6 lộ ra nhu cầu mới. Phản ứng: chỉ thêm migration mới theo kiểu mở rộng trước (thêm cột, thêm bảng), deploy code, rồi mới thu hẹp ở migration sau, để `wrangler rollback` của Worker luôn an toàn mà không cần đụng dữ liệu.
- Embedding làm database phình. Tín hiệu: dung lượng D1 vượt 2 GB. Phản ứng: job bảo trì ở phase 6 xoá embedding của claim đã ra khỏi cửa sổ quá 30 ngày.

## Security Considerations

- Trước mỗi lần áp dụng migration lên remote, ghi lại bookmark Time Travel bằng `wrangler d1 time-travel info`. Time Travel là phương án cuối vì nó quay ngược cả sổ ngân sách LLM lẫn trạng thái thẻ của người dùng; đường khôi phục chính khi deploy lỗi là `wrangler rollback`.
- File cấu hình chỉ chứa handle và URL công khai, không chứa email hay token.

## Next Steps

Phase 3 và 4 dùng các repo này; phase 8 bổ sung migration riêng cho view và bảng analyst.
