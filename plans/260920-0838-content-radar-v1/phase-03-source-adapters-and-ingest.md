---
title: "Phase 3: Adapter nguồn và pipeline ingest"
status: todo
priority: P1
effort: "3d"
dependencies: [2]
---

# Phase 3: Adapter nguồn và pipeline ingest

## Context Links

- [Contract](./research/brainstorm-260920-0730-content-radar-contract.md), mục Better approaches và Kết quả probe
- [Graph và nguồn](./research/researcher-260920-0735-graph-leiden-and-sources.md), mục Q6, Q8, Q9, Q10
- `reports/spike-results.md` từ phase 1 (trạng thái từng nguồn từ IP của Workers)

## Overview

Cron 30 phút chọn các nguồn đến hạn và đẩy vào `radar-poll`. Consumer gọi adapter tương ứng, lưu payload thô vào R2, upsert `items`, ghi snapshot `item_metrics`, cập nhật `source_health`, chạy bộ lọc rẻ và đánh thức `radar-llm` cho item đạt yêu cầu. Kèm lệnh backfill 15 ngày cho X chạy tay, theo yêu cầu của người dùng khi mô tả nguồn X.

## Key Insights

- Timeline API của FxTwitter trả 20 bài kèm đủ số liệu trong một call, nên mỗi lần poll vừa phát hiện bài mới vừa làm mới số liệu bài cũ; đó là nguồn của chuỗi thời gian engagement.
- Nitter đã chết hẳn sau thư cease-and-desist tháng 8/2026 và bị loại khỏi chuỗi fallback. Chuỗi còn lại: timeline API, RSS của FxTwitter để phát hiện bài, FxTwitter JSON theo ID để lấy số liệu, Syndication chỉ cho like và reply.
- Reddit bị loại khỏi v1 theo quyết định của người dùng; bình luận HN gánh phần counterpoint.
- FxTwitter không công bố hạn mức và là dự án cộng đồng; hệ thống tự giới hạn: User-Agent định danh, mỗi tài khoản tối đa một call mỗi 30 phút, lùi dần khi gặp lỗi.
- Bình luận HN do bất kỳ ai trên internet viết và sẽ đi tới phiên analyst có quyền wrangler. Chọn bình luận theo thứ hạng của HN, không theo độ dài, vì độ dài là bộ chọn gần như hoàn hảo cho payload prompt injection.
- Bài repost và quote không phải nội dung mới nhưng phải được giữ lại dưới dạng quan hệ, vì phase 6 cần chúng để không đếm trùng nguồn độc lập.
- URL của bài viết đến từ nội dung feed, tức là do bên ngoài kiểm soát, nên việc tải bài là bề mặt SSRF và cạn tài nguyên.

## Requirements

- [ ] Giao diện adapter thống nhất; thêm hoặc thay một nguồn chỉ chạm một file.
- [ ] Bốn adapter: `x`, `hn`, `rss`, `github`.
- [ ] Idempotent: poll lại cùng dữ liệu không tạo item trùng và không đánh thức lại việc bóc tách cho item đã xử lý.
- [ ] D1 là sổ cái: item được ghi `status = queued` kèm `queued_at` trong cùng lô ghi với chính nó, sau đó mới gửi message. Message mất hay hết hạn không làm mất việc vì bước rút backlog của phase 4 quét các item `queued` và gửi lại.
- [ ] Lỗi của một nguồn không ảnh hưởng nguồn khác; sau 5 lần lỗi liên tiếp, khoảng poll của nguồn đó giãn gấp đôi cho tới tối đa 24 giờ và tự co lại khi thành công.
- [ ] Backfill 15 ngày cho một tài khoản X chạy tay qua endpoint quản trị; item backfill mang `ingest_mode = backfill`.

## Architecture

```ts
interface SourceAdapter {
  type: SourceType;
  poll(source: SourceRow, ctx: AdapterContext): Promise<PollResult>;
}
type PollResult = { items: NormalizedItem[]; metrics: MetricSnapshot[]; cursor?: unknown };
```

`NormalizedItem` mang `platform`, `externalId`, `url`, `canonicalUrl`, `links` (các URL mà bài trỏ tới, đã chuẩn hoá bỏ tham số theo dõi; với story HN đó là URL bài gốc; consumer ghi chúng vào `item_links`), `author { platform, handle, displayName }`, `kind`, `parentExternalId`, `title`, `text`, `lang`, `publishedAt`, `raw`. Consumer `radar-poll` xử lý từng message (một nguồn) và ack riêng message đó khi xong: gọi adapter; ghi R2 tại `raw/<platform>/<yyyy>/<mm>/<dd>/<sha256 của externalId>.json`; upsert tác giả (nối vào `author_key` của nguồn nếu có) và item; ghi metrics; chạy lọc; ghi trạng thái; gửi message `{ kind: "extract", itemId }` vào `radar-llm`; cập nhật `source_health`, `poll_log`, `next_poll_at`.

Chi tiết từng adapter:

- **x:** `GET api.fxtwitter.com/2/profile/{handle}/statuses`. Handle được kiểm tra lại bằng `^[A-Za-z0-9_]{1,15}$` và URL dựng bằng `new URL()` rồi khẳng định `host === "api.fxtwitter.com"`. Ánh xạ `reposted_by` thành `kind = repost`, `replying_to` thành `reply`, có quote thành `quote` với `parentExternalId`. Khi timeline lỗi: đọc `fxtwitter.com/{handle}/feed.xml` để phát hiện bài, lấy số liệu qua `api.fxtwitter.com/{handle}/status/{id}`, cuối cùng mới tới Syndication cho like và reply.
- **hn:** Algolia `search_by_date` theo từng truy vấn cấu hình với `numericFilters=points>N`; với story đã là item và có điểm cao, lấy 10 bình luận cấp cao nhất theo thứ tự `kids` của Firebase API (thứ tự xếp hạng của HN) thành item `kind = comment` có `parentExternalId` là story.
- **rss:** parse RSS và Atom bằng parser nhẹ chạy được trong Workers; `externalId` là `<source_id>:<sha256 của guid>`. Nếu feed chỉ có tóm tắt thì tải bài và trích nội dung bằng `HTMLRewriter` theo hướng của `html-rewriter-readability`.
- **github:** `releases.atom` theo repo (không tính vào hạn mức REST); Search API sắp theo sao với `created:>` hoặc `pushed:>` làm tín hiệu trending; dùng secret `GITHUB_TOKEN` (PAT fine-grained chỉ đọc dữ liệu public, theo quyết định của người dùng) và vẫn tôn trọng hạn mức 30 request tìm kiếm mỗi phút.

Tải bài viết (`article-text.ts` qua `http-client.ts`): `redirect: "manual"`, tối đa 3 bước, mỗi bước kiểm tra lại scheme (`http`, `https`) và host theo danh sách chặn (hostname của chính Worker, `*.workers.dev`, địa chỉ loopback, RFC1918, link-local, hostname không có dấu chấm); đếm byte sau giải nén qua `TransformStream` và huỷ khi vượt 1 MB; timeout 10 giây; tối đa 5 lần tải bài cho mỗi message poll.

Bộ lọc rẻ (`ingest/cheap-filter.ts`), theo thứ tự: bỏ `repost` (vẫn lưu item để giữ quan hệ), bỏ `reply` trừ khi tự trả lời chính mình, bỏ bài quá ngắn sau khi gỡ URL, bỏ ngôn ngữ ngoài danh sách cấu hình, rồi khớp từ khoá theo chủ đề. Nguồn có `always_pass` bỏ qua bước từ khoá. Item bị loại nhận `status = filtered_out` kèm `filter_reason`; bước xác nhận chủ đề cuối cùng thuộc về Gemini ở phase 4.

## Related Code Files

- Create: `apps/worker/src/sources/source-adapter.ts`, `x-fxtwitter.ts`, `hacker-news.ts`, `rss-feed.ts`, `github.ts`, `http-client.ts`, `article-text.ts`, `url-guard.ts`
- Create: `apps/worker/src/ingest/dispatch-polls.ts`, `poll-consumer.ts`, `cheap-filter.ts`, `backoff.ts`
- Create: `apps/worker/src/api/admin-backfill.ts`
- Modify: `apps/worker/src/index.ts` (nối `scheduled` cho cron 30 phút, `queue` cho `radar-poll`, route backfill sau lớp `access-auth` và `request-guard` của phase 1)
- Create: `apps/worker/test/sources/*.test.ts`, `apps/worker/test/ingest/*.test.ts`, `apps/worker/test/fixtures/` (payload thật đã ghi lại từ mỗi nguồn, cùng fixture redirect vào địa chỉ nội bộ và bom nén)

## Implementation Steps

1. Viết `url-guard.ts` và `http-client.ts`: User-Agent định danh, timeout, redirect thủ công có kiểm tra lại từng bước, giới hạn byte sau giải nén, lỗi có phân loại (`blocked`, `rate_limited`, `not_found`, `transient`). Test bằng fixture redirect tới `127.0.0.1` và tới hostname của Worker, và fixture nén 900 KB bung ra hàng trăm MB.
2. Ghi lại payload thật của từng nguồn làm fixture (một lần, bằng curl), rồi viết adapter và test ánh xạ dựa trên fixture đó.
3. Viết `dispatch-polls.ts`: chọn nguồn `enabled` có `next_poll_at <= now`, `sendBatch` vào `radar-poll` theo khúc 100.
4. Viết `poll-consumer.ts` theo luồng ở mục Architecture. Thứ tự: R2, rồi một `db.batch` ghi item cùng `status = queued`, `queued_at`, `enqueue_attempts`, rồi gửi message, rồi `message.ack()`. Item đã ở trạng thái khác `new` không bị ghi đè trạng thái và không được gửi lại.
5. Viết `cheap-filter.ts` và test bảng quyết định cho từng quy tắc.
6. Viết `backoff.ts` cho quy tắc giãn khoảng poll và test.
7. Viết `admin-backfill.ts`: `POST /api/admin/backfill { handle, days }` kiểm tra `handle` bằng cùng biểu thức, `days` từ 1 đến 15, lần theo `cursor.bottom`, mỗi trang cách nhau ít nhất 2 giây; item tạo ra mang `ingest_mode = backfill` và message `{ kind: "extract", itemId, backfill: true }` để phase 4 áp ngân sách riêng.
8. Chạy local với `wrangler dev --test-scheduled` qua `wrangler.dev.jsonc`, kích cron, kiểm tra item và metrics xuất hiện trong D1 local.

## Todo

- [ ] `url-guard.ts`, `http-client.ts` và test SSRF, bom nén
- [ ] Fixture thật cho từng nguồn
- [ ] Adapter `x` cùng chuỗi fallback và kiểm tra handle
- [ ] Adapter `hn` kèm bình luận theo thứ hạng
- [ ] Adapter `rss` kèm trích nội dung bài
- [ ] Adapter `github` dùng PAT chỉ đọc
- [ ] Dispatcher, consumer theo thứ tự sổ cái trước, bộ lọc rẻ, backoff
- [ ] Endpoint backfill X có cờ `ingest_mode`
- [ ] Test đơn vị và test tích hợp local

## Success Criteria

- Test adapter xanh trên fixture thật; test consumer chứng minh poll hai lần cùng payload cho số item không đổi và không gửi lại message cho item đã qua trạng thái `new`.
- Test chứng minh: consumer chết sau khi ghi D1 nhưng trước khi gửi message để lại item `queued` có `queued_at`, là trạng thái mà bước rút backlog của phase 4 xử lý được.
- Trên local, một vòng cron tạo item cho ít nhất một nguồn của mỗi loại đang bật, có bản ghi R2 tương ứng và dòng `poll_log`.
- Mô phỏng nguồn trả 403 năm lần làm `next_poll_at` giãn đúng quy tắc và `source_health.consecutive_failures = 5`.
- Fixture redirect nội bộ và bom nén bị từ chối mà consumer không lỗi bộ nhớ.

## Risk Assessment

- FxTwitter đổi schema hoặc siết truy cập. Tín hiệu: `source_health` của mọi nguồn `x` cùng lỗi. Phản ứng: fallback tự động trong adapter; nếu kéo dài quá 48 giờ thì báo người dùng và cân nhắc tự host FxEmbed.
- Trích nội dung bài kém trên một số site. Phản ứng: giữ tóm tắt của feed làm nội dung, đánh dấu `filter_reason = summary_only` để biết chất lượng đầu vào.

## Security Considerations

- Không gửi secret trong request tới nguồn ngoài, trừ `GITHUB_TOKEN` chỉ gửi tới `api.github.com`.
- Nội dung crawl là dữ liệu không tin cậy: chỉ lưu và hiển thị dưới dạng văn bản, không bao giờ thực thi. Ký tự điều khiển bị gỡ khi chuẩn hoá `text`.
- Endpoint backfill nằm sau JWT Access và kiểm tra CSRF của phase 1; tham số được kiểm tra chặt để không dựng được URL ngoài `api.fxtwitter.com`.

## Next Steps

Item `queued` là đầu vào của phase 4; `item_metrics` và quan hệ repost, quote, bình luận là đầu vào của phase 5 và 6.
