# Vận hành

Trạng thái tại thời điểm viết (2026-09-20): hệ thống **chưa được deploy**. Tài nguyên Cloudflare đã tạo (D1 `content-radar`, R2 `content-radar-raw`, queue `radar-poll`, `radar-llm`, `radar-dlq`), nhưng migration chưa áp dụng lên remote và chưa có route. Những quy trình dưới đây có đánh dấu **chưa thử trên production** là viết theo tài liệu của Cloudflare và theo hành vi đã kiểm chứng ở local; hãy cập nhật chúng khi chạy thật lần đầu.

## Deploy lần đầu

Cần có trước: một custom domain trên Cloudflare, và một ứng dụng Access kiểu self-hosted cho hostname đó với policy cho đúng một email. Lấy **Application Audience (AUD) tag** của ứng dụng và miền team dạng `https://<team>.cloudflareaccess.com`.

1. Thêm route vào `apps/worker/wrangler.jsonc` (thay hostname thật):

   ```jsonc
   "routes": [{ "pattern": "radar.example.com", "custom_domain": true }]
   ```

   Giữ nguyên `workers_dev: false` và `preview_urls: false`.

2. Ghi lại bookmark Time Travel, áp dụng migration, đồng bộ cấu hình:

   ```bash
   cd apps/worker
   npx wrangler d1 time-travel info content-radar
   npx wrangler d1 migrations apply content-radar --remote
   cd ../.. && npm run config:sync -- --remote
   ```

3. Đặt secret (mỗi lệnh hỏi giá trị, không ghi vào file hay lịch sử shell):

   ```bash
   cd apps/worker
   for name in GEMINI_API_KEY GITHUB_TOKEN OWNER_EMAIL ACCESS_TEAM_DOMAIN ACCESS_AUD APP_ORIGIN; do npx wrangler secret put "$name"; done
   ```

   `ACCESS_TEAM_DOMAIN` không có dấu gạch chéo cuối. `APP_ORIGIN` là origin chính xác, ví dụ `https://radar.example.com`. Thiếu một trong ba biến Access thì mọi request nhận 503 `access_not_configured`: Worker từ chối thay vì mở.

4. Điền hạn mức Gemini thật vào [`scripts/set-llm-limits.sql`](../scripts/set-llm-limits.sql) rồi chạy nó. Khi còn để `NULL`, hệ thống dùng mức an toàn 5 RPM và 100 RPD mỗi model.

5. `npm run deploy`, rồi kiểm tra không hostname nào hở:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://radar.example.com/                               # 302 về trang đăng nhập Access, hoặc 401
   curl -s -o /dev/null -w '%{http_code}\n' https://radar.example.com/api/status                     # như trên, không bao giờ 200
   curl -s -o /dev/null -w '%{http_code}\n' https://content-radar.<subdomain>.workers.dev/ || true   # không phân giải hoặc 404
   ```

   Sau đó đăng nhập qua Access và mở trang, bấm "System status".

6. Chạy các probe để biết nguồn nào chặn IP của Workers và Gemini có lỗi vị trí không (việc còn nợ của phase 1). Đo `gemini` 10 lần; nếu có `locationBlocked: true` thì thêm `"placement": { "region": "aws:us-east-1" }` vào `wrangler.jsonc`, deploy lại và đo lại. Ghi kết quả vào [`spike-results.md`](../plans/260920-0838-content-radar-v1/reports/spike-results.md).

   ```
   /api/admin/probe?target=gemini | fxtwitter-timeline | fxtwitter-status | syndication | hn-algolia
                                  | hn-firebase | github-api | github-atom | rss-uber | rss-medium | workers-ai-embed
   ```

   Nếu vẫn lỗi vị trí sau khi đặt placement, đặt secret `GEMINI_BASE_URL` thành URL AI Gateway của nhà cung cấp Google AI Studio.

   Probe Gemini gọi API thật nhưng chưa đi qua sổ ngân sách của pipeline. Khi đối chiếu hạn mức ngày, tính cả số call probe đã chạy; `llm_usage` không chứa các call này.

## Đọc trang trạng thái

| Mục | Bình thường | Cần xem |
|---|---|---|
| Backlog | Trống, hoặc item cũ nhất dưới vài giờ | Tuổi item cũ nhất tăng đều qua các ngày: quota không đủ cho lượng item |
| LLM circuit | `closed` | `open`: năm lỗi liên tiếp cùng loại, thường là lỗi vị trí hoặc mạng; xem `llm_calls` |
| Gemini budget | Dưới hạn mức; ghi chú "safe default" nghĩa là chưa điền số thật | `parked`: model vừa gặp 429, tự mở lại sau nửa đêm Pacific |
| Cards | Số thẻ "on fallback headline" nhỏ | Tăng đều: nhu cầu tổng hợp vượt 20% dành riêng; nâng `synthesis_min_score` |
| Cluster runs | `done` mỗi giờ | `failed` quá hai lần liên tiếp: đọc cột Note |
| Sources | 0 failing | Xem mục "Khi một nguồn bị chặn" |

Khi quota không đủ, chỉnh theo thứ tự: siết bộ lọc rẻ (`filter_min_text_length`, từ khoá trong `config/topics.json`), tắt nguồn ưu tiên thấp, rồi mới cân nhắc tăng `max_batch_size` của consumer `radar-llm` nếu tỉ lệ `quote_not_found` còn dưới 15%. Khi áp lực quota và chất lượng kéo ngược nhau, chất lượng thắng.

## Cấu hình

Sau khi cập nhật code, chạy migration trước khi khởi động Worker. Với local:

```bash
cd apps/worker
npx wrangler d1 migrations apply content-radar --local --config wrangler.dev.jsonc
```

Migration `0008_cluster_publication.sql` bổ sung hai bảng dàn dựng để công bố cluster nguyên khối cho database đã chạy migration graph cũ. Nó cũng chạy được khi hai bảng đã tồn tại, không xoá dữ liệu. Với remote, áp dụng migration theo quy trình deploy ở trên.

Sửa file trong `config/` rồi chạy `npm run config:sync -- --remote`. Lệnh kiểm tra bằng schema trước khi ghi, không đụng `next_poll_at` hay `cursor_json`, và mục bị gỡ khỏi file thì bị tắt (`enabled = 0`) chứ không bị xoá, để lịch sử còn nguyên.

- **Thêm tài khoản X:** thêm một dòng `type: "x"` vào `sources.json`. Handle phải khớp `^[A-Za-z0-9_]{1,15}$`. Kiểm tra handle tồn tại trước (`curl https://api.fxtwitter.com/<handle>`); lúc soạn danh sách ban đầu, 2 trong 58 handle nhớ theo trí nhớ là sai.
- **Nối một người trên nhiều nền tảng:** thêm vào `authors.json` với các handle, rồi đặt `authorKey` ở các nguồn tương ứng. Thiếu bước này, cùng một người trên X và trên blog sẽ bị đếm thành hai nguồn độc lập.
- **Tham số thuật toán:** không sửa code. Đặt giá trị ghi đè vào `core_overrides` trong `settings.json`; khoá lạ hoặc giá trị ngoài khoảng sẽ làm job cluster từ chối chạy thay vì âm thầm bỏ qua. Bộ tham số đã hợp nhất được ghi vào `cluster_runs.params_json` ở mỗi lần chạy. Chỉ sửa mặc định trong `params.ts` khi muốn đổi hẳn, kèm tăng `PARAMS_VERSION`.
- **Quét lại gamma:** `npm run sweep -- --remote`. Vùng ổn định là gợi ý; trước khi đổi, mở 20 câu chuyện ở giá trị ứng viên và kiểm tra từng cụm có đúng là một câu chuyện không.
- **Backfill X 15 ngày:** `scripts/backfill-kols.sh`, chạy từ ngày thứ 3 sau khi ingest trực tiếp đã ổn. Item backfill dùng phần ngân sách riêng, tối đa 25% RPD.

## Khi một nguồn bị chặn

Lỗi của một nguồn không ảnh hưởng nguồn khác. Từ lần lỗi thứ năm liên tiếp, khoảng poll của nguồn đó giãn gấp đôi mỗi lần, tối đa 24 giờ, và tự co lại khi thành công. `source_health.last_error` cho biết loại lỗi: `blocked` (403, 406), `rate_limited` (429), `not_found`, `transient`.

- Một feed RSS: thường do site chặn bot. Tắt nguồn trong `sources.json` hoặc đổi URL feed.
- **Mọi** nguồn `x` cùng lỗi: FxTwitter đổi schema hoặc siết truy cập. Adapter tự lùi về RSS của FxTwitter cộng API theo từng status, rồi Syndication cho like và reply. Nếu kéo dài quá 48 giờ thì lối thoát là tự host FxEmbed trên một Worker riêng; X là trục nguồn chính nên đây là việc phải quyết, không phải việc chờ.
- GitHub 403 hoặc 429: kiểm tra PAT còn hạn. Feed `releases.atom` không tính vào hạn mức REST; chỉ các nguồn `search:` dùng API.

## Rollback và khôi phục

**Chưa thử trên production.**

Thứ tự an toàn cho mọi thay đổi schema: migration chỉ **mở rộng** (thêm cột, thêm bảng), deploy code, và chỉ thu hẹp schema ở lần phát hành kế tiếp. Nhờ vậy phiên bản Worker trước luôn chạy được trên schema hiện tại.

- **Deploy lỗi:** `cd apps/worker && npx wrangler rollback`. Lệnh đưa Worker về phiên bản trước và không đụng dữ liệu. Đây là đường khôi phục chính.
- **Dữ liệu hỏng:** Time Travel khôi phục D1 về một thời điểm trong 30 ngày: `npx wrangler d1 time-travel restore content-radar --timestamp=<unix>`. Đây là phương án cuối, vì nó quay ngược **mọi thứ**: sổ ngân sách Gemini (hệ thống sẽ tưởng còn quota đã dùng), trạng thái Saved, Dismissed, Written và `user_actions`. Ghi bookmark trước mỗi lần áp dụng migration để có điểm quay về chính xác.
- **Sao lưu:** `scripts/backup-d1.sh [thư-mục]` xuất toàn bộ database ra một file SQL có ngày, mặc định ở `~/backups/content-radar`, quyền 600. Script từ chối ghi vào trong repo. File chứa toàn bộ dữ liệu: giữ ngoài git, ngoài thư mục mà phiên analyst đọc được, và không tải lên dịch vụ bên ngoài.

## Dead-letter queue

Message hỏng sau 5 lần retry vào `radar-dlq`, và Worker tự tiêu thụ queue này. Một message `extract` chết thì item tương ứng thành `failed` với `filter_reason = 'dead_letter'` kèm một dòng trong `llm_calls`, để không item nào biến mất trong im lặng. Message poll chết thì không cần làm gì: `next_poll_at` của nguồn đã tự lo việc thử lại. Tìm item hỏng:

```sql
SELECT id, platform, url, filter_reason FROM items WHERE status = 'failed' ORDER BY id DESC LIMIT 50;
```

Cho một item thử lại: `UPDATE items SET status = 'queued', enqueue_attempts = 0, queued_at = NULL WHERE id = <id>;` rồi chờ tick 30 phút kế tiếp.

## Job bảo trì theo ngày (08:20 UTC)

Cập nhật baseline tác giả; dựng lại `story_daily` và `entity_daily` cho 16 ngày theo ngày xuất bản; sửa trạng thái dở dang (lần chạy cluster còn `running` mà lease đã hết, phân xử entity bị mất message); áp chính sách lưu giữ: `run_members`, `poll_log`, `llm_calls` 14 ngày, riêng membership của lần chạy hoàn tất gần nhất của mỗi câu chuyện còn sống được giữ để khớp lineage sau gián đoạn dài. Các bảng dàn dựng `run_stories` và `run_retirements` được dọn sau 14 ngày, hoặc sau một ngày với run thất bại. Embedding và `claim_edges` của claim đã ra khỏi cửa sổ quá 30 ngày được dọn; `item_metrics` cũ hơn 14 ngày gộp còn một snapshot mỗi ngày. `items`, `claims`, `stories`, `lineage_events` và hai chuỗi theo ngày được giữ vĩnh viễn; câu chuyện có thao tác của người dùng không bao giờ bị xoá. Mỗi phần chạy độc lập, một phần lỗi không chặn phần khác.

## Nâng phiên bản phụ thuộc

`.npmrc` đặt `ignore-scripts=true` và `save-exact=true`; luôn cài bằng `npm ci --ignore-scripts`. `ngraph.leiden` là gói trẻ và ít người dùng mà cả lineage dựa vào: chỉ nâng khi có lý do, đọc diff trước, và chạy `npm test --workspace @radar/core` sau đó. Bộ test đó gồm mạng tham chiếu karate club và college football cùng ba fixture có trọng số, và đã từng bắt được việc pha refinement của chính thư viện này làm giảm chất lượng. Test trong `workerd` cần `@cloudflare/vitest-plugin` và Vitest 4.1.x đi cùng nhau.

## Chi phí dự kiến

Ước tính từ bảng giá của Cloudflare, **chưa được đo**; tuần chạy thử là lúc kiểm chứng. Workers Paid là 5 USD mỗi tháng và gồm 10 triệu request cùng 30 triệu CPU-ms. D1 (5 GB, 25 tỉ dòng đọc, 50 triệu dòng ghi), R2 (10 GB, 1 triệu thao tác Class A), Queues (1 triệu thao tác), Workers AI (10.000 neuron mỗi ngày) và Access (50 người dùng) đều có mức miễn phí mà quy mô một người dùng nằm gọn bên trong. Điểm dễ vượt nhất là thao tác Class A của R2; vì vậy consumer chỉ ghi R2 cho item mới hoặc có nội dung đổi, thay vì ghi lại mọi item ở mỗi lần poll. Gemini chạy ở free tier nên chi phí LLM là 0 USD, với cái giá là Google được dùng nội dung gửi lên để cải thiện sản phẩm; hệ thống chỉ gửi nội dung công khai.
