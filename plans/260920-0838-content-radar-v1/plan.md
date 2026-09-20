---
title: "Content Radar v1 trên Cloudflare"
description: "Radar cá nhân crawl nguồn public, dùng Gemini free tier bóc claim, gom thành câu chuyện bằng graph và Leiden, chấm điểm, hiển thị thẻ lead và mở D1 cho Claude/Codex phân tích."
status: pending
priority: P1
effort: 25d
tags: [feature, backend, frontend, database, infra]
blockedBy: []
blocks: []
created: 2026-09-20
---

# Content Radar v1 trên Cloudflare

## Overview

Xây một radar cá nhân trả lời câu hỏi "Giới nghiên cứu và ứng dụng AI/Agent đang có gì thú vị, và đang dịch chuyển về hướng nào?", mở rộng sang System Design và Backend. Contract đã chốt nằm ở [brainstorm report](./research/brainstorm-260920-0730-content-radar-contract.md). Hai báo cáo nghiên cứu làm nền cho mọi quyết định kỹ thuật: [nền tảng Cloudflare và Gemini](./research/researcher-260920-0735-cloudflare-gemini-platform.md), [graph, Leiden và nguồn dữ liệu](./research/researcher-260920-0735-graph-leiden-and-sources.md). Ảnh chụp hệ thống tham chiếu nằm ở [`assets/reference-ui.jpg`](./assets/reference-ui.jpg).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Pipeline tự chạy: crawl, lọc, bóc claim bằng Gemini free tier, không mất việc khi hết quota | P1 |
| 2 | Lõi tất định bằng TypeScript: graph claim, Leiden, danh tính câu chuyện ổn định qua thời gian, chấm điểm 0–100 | P1 |
| 3 | Giao diện thẻ lead theo ảnh chụp hệ thống tham chiếu, một người dùng, có Save, Dismiss, Written | P1 |
| 4 | Tầng analyst: Claude/Codex truy vấn D1 qua wrangler và ghi ngược signal, giả thuyết | P2 |

## Kiến trúc đã chốt

- Một repo npm workspaces: `packages/core` (TypeScript thuần, không phụ thuộc runtime), `apps/worker` (một Worker duy nhất xử lý `fetch`, `scheduled`, `queue` và phục vụ static assets), `apps/web` (Vite, React, TypeScript), `config/` (chủ đề, nguồn, KOL, feed, tác giả), `analyst/` (truy vấn mẫu và script bọc), `docs/`.
- Binding: D1 `DB`, R2 `RAW` (payload thô), Queues `radar-poll` và `radar-llm` cùng dead-letter `radar-dlq`, Workers AI `AI` (embedding `@cf/baai/bge-m3`), `ASSETS`. Secret: `GEMINI_API_KEY`, `GITHUB_TOKEN` (PAT chỉ đọc), `OWNER_EMAIL`.
- Nguồn của v1: X theo KOL qua FxTwitter, Hacker News kèm bình luận, feed RSS của các lab và blog kỹ thuật, GitHub. Reddit bị loại khỏi v1 theo quyết định của người dùng.
- Ba cron: mỗi 30 phút chia việc poll nguồn và rút backlog LLM, mỗi giờ chạy job cluster, mỗi ngày chạy bảo trì.
- D1 là sổ cái của mọi công việc; queue chỉ là tín hiệu đánh thức. Mỗi bước chuyển giữa các tiến trình có cột trạng thái, khoá chống trùng và được job định kỳ quét lại, nên message mất hay hết hạn không làm mất việc.
- Luồng dữ liệu: adapter nguồn ghi `items`, `item_links`, `item_metrics`; lọc rẻ; consumer `radar-llm` gom lô 10 item cho một lần gọi Gemini để bóc `claims` và `entity_mentions`. Job theo giờ gộp entity, embed claim, xác định quan hệ dẫn xuất, lưu láng giềng cosine top-k, dựng cạnh có trọng số tại chỗ, chạy Leiden, khớp lineage, chấm điểm, công bố kết quả ở một bước kết thúc duy nhất, rồi xếp hàng tổng hợp headline tiếng Việt cho các câu chuyện thay đổi đáng kể.
- Đơn vị: node của graph là claim; cụm cần tối thiểu 2 claim, bài lẻ chỉ thành lead khi engagement bất thường so với chính tác giả (robust z từ 3); `stories` là lineage ổn định và cũng là thẻ hiển thị. `LEAD` khi có 1 nguồn độc lập, `READY` khi có từ 2. Mọi thẻ luôn có headline: bản dự phòng tất định cho tới khi Gemini tổng hợp.
- Tham số thuật toán có một chủ sở hữu là `packages/core/src/params.ts`; bảng `settings` chỉ ghi đè; bộ tham số đã hợp nhất được ghi vào `cluster_runs.params_json` ở mỗi lần chạy.
- Gemini: chuỗi model `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`; hạn mức là cấu hình trong D1 do người dùng đọc từ AI Studio; sổ ngân sách theo model, loại việc và ngày Pacific có đặt chỗ, xác nhận và hoàn chỗ; 20% dành riêng cho tổng hợp và phân xử, backfill tối đa 25%.
- Xác thực: Cloudflare Access trên custom domain, `workers_dev` và preview URL tắt, Worker tự kiểm tra JWT của Access (gồm `iss`, `aud`, `exp`, email chủ sở hữu) và chống CSRF cho mọi request, kể cả static assets, ngay từ lần deploy đầu tiên.
- Phiên analyst chạy bằng API token chỉ có quyền D1; văn bản crawl trong đầu ra truy vấn được bọc trong thẻ dữ liệu không tin cậy.
- Tìm kiếm dùng `LIKE` trên cột `search_text` đã chuẩn hoá, không dùng FTS5 để `wrangler d1 export` không bị vướng bảng ảo.

## Phases

| # | Phase | Effort | Depends on | Status |
|---|-------|--------|------------|--------|
| 1 | [Nền móng và kiểm chứng rủi ro](./phase-01-foundation-and-spikes.md) | 2d | — | Pending |
| 2 | [Mô hình dữ liệu và cấu hình](./phase-02-data-model-and-config.md) | 1.5d | 1 | Pending |
| 3 | [Adapter nguồn và pipeline ingest](./phase-03-source-adapters-and-ingest.md) | 3d | 2 | Pending |
| 4 | [Bóc claim bằng Gemini và sổ ngân sách](./phase-04-llm-extraction-and-budget.md) | 3d | 2 | Pending |
| 5 | [Gói lõi graph](./phase-05-graph-core-package.md) | 4d | 1 | Pending |
| 6 | [Job cluster và tổng hợp thẻ](./phase-06-cluster-job-and-card-synthesis.md) | 4d | 3, 4, 5 | Pending |
| 7 | [API và giao diện web](./phase-07-api-and-web-ui.md) | 2.5d | 6 | Pending |
| 8 | [Tầng analyst](./phase-08-analyst-layer.md) | 1.5d | 6 | Pending |
| 9 | [Triển khai, chạy thử 7 ngày và tài liệu](./phase-09-deploy-soak-and-docs.md) | 3d | 7, 8 | Pending |

Phase 3, 4 và 5 độc lập về file nên có thể làm song song sau phase 2. Ước tính 25 ngày chưa gồm phương án dự phòng tự viết Leiden (thêm 2 đến 4 ngày) và 7 ngày chờ của tuần chạy thử.

## Success Criteria

- [ ] Pipeline chạy không người trông 7 ngày liên tục; khi hết quota Gemini thì việc nằm lại trong D1 và được xử lý sau, không item nào kẹt hay mất; sổ ngân sách tự mở lại mỗi ngày Pacific mới.
- [ ] D1 có đủ items, claims kèm URL và đoạn trích, entities cùng alias, cạnh, snapshot, lineage, stories, `source_health`, sổ ngân sách LLM.
- [ ] Trên cùng tập claim, embedding và tham số đã lưu, chạy lại với cùng seed cho cùng phân hoạch. Việc bóc claim bằng LLM không tất định; model và phiên bản prompt của từng claim được ghi lại để truy vết.
- [ ] Danh tính câu chuyện ổn định: trong tuần chạy thử, từ 85% số khớp là `continue` và dưới 20% câu chuyện sống đổi `story_id` trong một lần chạy; trạng thái Saved, Dismissed, Written sống qua split, merge, revive và qua lần chạy bị chết giữa chừng.
- [ ] Giao diện hiển thị đúng spec thẻ lead và bốn thao tác ghi được trạng thái vào D1; không hostname nào của Worker truy cập được khi chưa xác thực.
- [ ] Một phiên Claude chạy bằng token giới hạn phạm vi trả lời được câu hỏi gốc bằng các view dựng sẵn, mọi nhận định dẫn về evidence URL, và ghi ngược được signal vào D1.

## Dependencies

- Tài khoản Cloudflare với Workers Paid và một custom domain trên Cloudflare, Wrangler mới nhất, Node 22 trở lên.
- API key Gemini free tier của người dùng và con số hạn mức đọc từ `aistudio.google.com/rate-limit`.
- Một GitHub PAT fine-grained chỉ đọc dữ liệu public.
- Các dịch vụ bên thứ ba không có SLA: FxTwitter, HN Algolia và Firebase, feed RSS công khai, GitHub.

## Red Team Review

### Session — 2026-09-20
**Findings:** 39 thô từ 4 reviewer, gộp còn 15 nhóm (15 accepted, 0 rejected; 5 đề xuất con bị bác)
**Severity breakdown:** 8 Critical, 6 High, 1 Medium
**Báo cáo gốc:** [security](./reports/red-team-security-adversary.md), [failure modes](./reports/red-team-failure-mode-analyst.md), [assumptions](./reports/red-team-assumption-destroyer.md), [scope](./reports/red-team-scope-complexity-critic.md)

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Sổ ngân sách kẹt khi sang ngày mới, không hoàn chỗ, lẫn RPM với RPD | Critical | Accept | Phase 2, 4 |
| 2 | Queue: thiếu ack từng message, claim không có khoá chống trùng, item kẹt `queued`, retry vượt 14 ngày lưu giữ | Critical | Accept | Phase 2, 3, 4 |
| 3 | Lần chạy cluster ghi dở làm hỏng lineage và mất trạng thái thẻ; khoá chống chạy chồng vô tác dụng | Critical | Accept | Phase 2, 6 |
| 4 | `derived_from_claim_id` và alias tác giả không có bên ghi, cổng READY vô nghĩa | Critical | Accept | Phase 2, 3, 5, 6 |
| 5 | Không có cỡ cụm tối thiểu, mỗi claim lẻ thành một thẻ | Critical | Accept (theo lựa chọn của người dùng: bài lẻ chỉ khi bất thường) | Phase 5, 6 |
| 6 | Quota tổng hợp không đủ, điểm và tổng hợp khoá vòng, thiếu headline thì ẩn thẻ, headline cũ so với thành viên | Critical | Accept | Phase 2, 5, 6, 7 |
| 7 | Access bật muộn, `workers.dev` hở, cờ tắt xác thực lách được, thiếu chống CSRF | Critical | Accept | Phase 1, 7 |
| 8 | Đường prompt injection tới phiên analyst có quyền wrangler đầy đủ; script chặn chỉ mang tính khuyến nghị; ba bản quy tắc | Critical | Accept (giữ `SELECT` tự do, chặn bằng token giới hạn phạm vi) | Phase 3, 4, 8, 9 |
| 9 | Cạnh đóng băng theo IDF và entity cũ, không giới hạn bậc, ước tính bộ nhớ sai | High | Accept | Phase 1, 2, 5, 6 |
| 10 | Vách cửa sổ 7 ngày giết câu chuyện dài; chuyện đã Dismiss quay lại; `story_claims` chỉ thêm | High | Accept | Phase 2, 5, 6 |
| 11 | Tham số khai hai nơi, thiếu gamma và seed, không có ngưỡng ổn định | High | Accept | Phase 2, 5, 9 |
| 12 | `S_novelty` không có nguồn; `S_specificity` phụ thuộc vai trò LLM | High | Accept | Phase 5, 6 |
| 13 | SSRF và bom nén khi tải bài; handle, R2 key, `guid` RSS do bên ngoài kiểm soát; chuỗi cung ứng npm | High | Accept (khoá phiên bản thay vì chép mã nguồn) | Phase 1, 2, 3 |
| 14 | `text_en` không tất định và không có truy vết; kiểm tra `quote` loại oan; không đếm được claim bị loại | High | Accept (không ghim một model vì chuỗi model là quyết định của người dùng) | Phase 2, 4 |
| 15 | Không có đường rollback; backfill lệch baseline và ăn quota; effort thiếu khoảng đệm | Medium | Accept (giữ backfill vì người dùng yêu cầu; giữ trang trạng thái vì cần cho vận hành) | Phase 3, 4, 6, 8, 9 |

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01 đến phase-09
- Decision deltas checked: 19 (Reddit, cờ tắt xác thực, retry dài ngày, `retryAll`, khoá 20 phút, lookback theo số lần chạy, cạnh lưu trọng số entity, hàm `edgeWeight` và `newEdges`, bước `build_edges`, `vector-codec`, khoá `llm_usage` cũ, bình luận HN theo độ dài, FTS5, tham số trong `settings.json`, effort 18 ngày, `story_claims` chỉ thêm, headline bắt buộc từ LLM, bước quét `queued` thuộc phase nào, ba bản quy tắc analyst)
- Reconciled stale references: 2 (phase 3 trỏ nhầm bước quét backlog sang phase 6; todo trùng ở phase 7)
- Unresolved contradictions: 0

## Validation Log

### Session 1 — 2026-09-20
**Trigger:** kiểm chứng sau red-team của `/ak:plan --hard`
**Questions asked:** 4

#### Questions & Answers

1. **[Risks]** Bạn muốn xử lý 15 nhóm phát hiện red-team như thế nào?
   - Options: Áp dụng hết (Recommended) | Để tôi duyệt từng cái | Bác hết, plan ổn rồi
   - **Answer:** Áp dụng hết
   - **Rationale:** nhóm 1 đến 3 làm hỏng tuần chạy thử ngay ngày đầu nếu không sửa.
2. **[Scope]** Reddit đã đóng truy cập không cần tài khoản từ 2026. Xử lý nguồn Reddit ra sao?
   - Options: Probe rồi quyết (Recommended) | Bỏ Reddit khỏi v1 luôn | Xin OAuth chính thức
   - **Answer:** Bỏ Reddit khỏi v1 luôn
   - **Rationale:** gỡ adapter, probe và cấu hình Reddit khỏi phase 1, 2, 3; bình luận HN gánh phần counterpoint.
3. **[Assumptions]** Adapter GitHub có được dùng một Personal Access Token miễn phí không?
   - Options: Dùng PAT chỉ đọc (Recommended) | Không dùng token
   - **Answer:** Dùng PAT chỉ đọc
   - **Rationale:** nâng hạn mức REST từ 60 lên 5.000 request mỗi giờ; token là secret của Worker.
4. **[Architecture]** Một bài đăng đơn lẻ có được lên thành thẻ LEAD không?
   - Options: Chỉ khi bất thường (Recommended) | Luôn cần từ 2 claim | Mọi claim đạt điểm
   - **Answer:** Chỉ khi bất thường
   - **Rationale:** quyết định `minCommunitySize = 2` và `singletonMinVelocityZ = 3` ở phase 5, 6.

#### Confirmed Decisions
- Áp dụng toàn bộ 15 nhóm sửa của red-team; effort tăng từ 18 lên 25 ngày.
- V1 không có Reddit.
- GitHub dùng PAT fine-grained chỉ đọc.
- Bài lẻ chỉ thành lead khi robust z engagement từ 3 trở lên.

#### Action Items
- [x] Viết lại phase 1 đến 9 và plan.md theo các quyết định trên.
- [ ] Người dùng đọc hạn mức Gemini thật trên AI Studio trước phase 9.
- [ ] Người dùng chuẩn bị custom domain trên Cloudflare và GitHub PAT trước phase 1 và 3.

#### Impact on Phases
- Phase 1: xác thực và chống CSRF trước lần deploy đầu; thêm test Leiden có trọng số và test bộ nhớ BLOB; bỏ probe Reddit.
- Phase 2: thêm khoá chống trùng, cột trạng thái, `item_links`, `job_leases`, `story_claims.active`, sổ ngân sách theo loại việc; bỏ nguồn `reddit`.
- Phase 3: sổ cái trước rồi mới gửi message; chống SSRF; bình luận HN theo thứ hạng; backfill có cờ.
- Phase 4: sổ ngân sách ba thao tác, ack từng message, rút backlog từ D1, khớp `quote` có chuẩn hoá Unicode.
- Phase 5: `params.ts` là chủ sở hữu, cạnh tính tại chỗ, cỡ cụm tối thiểu, lineage trên phần còn trong cửa sổ, hồi sinh, quan hệ dẫn xuất.
- Phase 6: lease nguyên tử, công bố nguyên khối, `story_claims` là phép chiếu, headline dự phòng, quy tắc chọn câu chuyện để tổng hợp.
- Phase 7: dùng lại lớp xác thực của phase 1, nhãn headline dự phòng, trang trạng thái dùng chung truy vấn.
- Phase 8: API token giới hạn phạm vi, một bộ quy tắc, thẻ dữ liệu không tin cậy.
- Phase 9: ngưỡng ổn định lineage, thử rollback, backfill từ ngày thứ 3, payload canary.

## Unresolved Questions

1. Hạn mức free tier thực tế của từng model Gemini và giờ đặt lại quota thật chỉ xác định được khi người dùng đọc AI Studio và khi tuần chạy thử quan sát.
2. Quyền D1 của Cloudflare API token có giới hạn được tới từng database hay không, kiểm tra ở phase 8.
3. Cú pháp chính xác của Placement region hint, kiểm tra ở phase 1.

<!-- slug: content-radar-v1 -->
