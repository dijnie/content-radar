# Vận hành

Setup tài khoản mới hoặc chuyển sang Cloudflare Builds: làm theo [template setup](setup.md) trước. Các ghi chép production bên dưới là lịch sử triển khai, không phải tài nguyên có sẵn cho mọi tài khoản. `apps/worker/wrangler.jsonc` nay được sinh từ `.env.setup`/build variables và `wrangler.json`; không sửa trực tiếp file sinh ra.

Cập nhật ngày 2026-10-05: ứng dụng mở công khai theo yêu cầu người dùng. Mọi người được xem và tương tác; trạng thái thẻ, trạng thái đọc, Jobs và lịch chạy dùng chung. Worker không còn xác thực Cloudflare Access hay giới hạn email chủ sở hữu. Ghi chép Access ngày 2026-09-21 trong `plans/reports` chỉ còn là lịch sử. Nếu Access vẫn đang bảo vệ hostname ở dashboard, tắt riêng lớp đó để URL thực sự công khai.

Tài nguyên Cloudflare đã tạo (D1 `content-radar`, R2 `content-radar-raw`, queue `radar-poll`, `radar-llm`, `radar-dlq`). Ngày 2026-09-21 migration `0001` đến `0010` đã được áp lên D1 remote; cấu hình remote đang có 3 chủ đề, 119 nguồn, 13 tác giả. **Không sửa các file migration đã áp**, mọi thay đổi schema phải là một migration mới. Những quy trình dưới đây có đánh dấu **chưa thử trên production** là viết theo tài liệu của Cloudflare và theo hành vi đã kiểm chứng ở local; hãy cập nhật chúng khi chạy thật lần đầu.

## Jobs và feed editorial

Bản bổ sung ngày 2026-09-21 đã có trên Worker production nhưng thiếu migration D1, khiến Jobs trả 500 `no such table: crawl_runs`. Đã ghi bookmark và áp `0010_editorial_feeds.sql` lúc 12:41 UTC; log xác nhận Jobs trả 200 trên cùng version Worker. Lịch sử Jobs bắt đầu từ các crawl mới, không nhập lịch sử local. Local có 121 nguồn; remote vẫn có 119 nguồn và chưa sync cấu hình editorial mới trong lần khắc phục này. Kiểm chứng crawl/build theo lịch và các feed có dữ liệu thật trên production vẫn còn riêng. [Bằng chứng khắc phục](../plans/reports/debug-260921-1239-jobs-missing-migration.md).

Mỗi lần phát hành có thay đổi schema: ghi bookmark D1, áp migration mới và sync cấu hình rồi deploy theo quy trình bên dưới. `npm run deploy` chỉ build và upload Worker, **không tự áp migration**. Không sửa lại migration đã áp. Không cần queue, secret hay dịch vụ trả phí mới.

- **Jobs → Run** crawl mọi nguồn đang bật; bấm lần nữa trong khi chạy trả lại cùng crawl. Mở một dòng để xem lỗi nguồn. `partial` nghĩa là một số nguồn lỗi, các nguồn thành công vẫn dùng được.
- **From crawl → Build News/Hands-on/Deep dives** tạo bản riêng từ crawl hoàn tất. Build thất bại giữ bản công bố trước; Rerun thử lại từ cùng crawl. Lịch bật/tắt và khoảng phút được lưu riêng từng feed (30 đến 10.080 phút); cron 30 phút là độ phân giải thực tế của lịch.
- News cần claim và Stories từ job cluster; Deep dives, Field tests và Playbooks cần extraction đã trả phân loại hợp lệ. Chỉ toolbox repository có thể xuất hiện ngay sau crawl mà chưa cần LLM. Phần chờ phân tích hiển thị ngay trên feed. Giữ trần AI hiện tại, chờ backlog xử lý; không nhập thẻ giả hoặc reset quota để làm đầy giao diện.
- Cấu hình `editorial_scoring` đặt ngưỡng News và trọng số/trần repository; công thức ở [kiến trúc](architecture.md#điểm-repository). Sync cấu hình rồi dựng feed mới để áp dụng, bản đã công bố giữ điểm cũ. Mặc định lab leader chưa gắn; điền các `authorKey` thật vào `labLeaderAuthorKeys` khi có danh sách xác nhận.
- GitHub `trending:daily` lấy hạng/ngày thật; `search:` không có hạng Trending. Hugging Face Papers lấy abstract từ API công khai. Website đổi cấu trúc hoặc chặn truy cập sẽ hiện lỗi trong Jobs; metadata thiếu giữ trạng thái không có số liệu.

Các API công khai, thao tác ghi đi qua kiểm tra cùng origin và JSON: `GET /api/jobs`, `GET /api/jobs/:kind/:id`, `POST /api/jobs/crawls`, `POST /api/jobs/feeds/:feed`, `POST /api/jobs/schedules/:feed`, `GET /api/feeds/:feed`, `GET /api/feeds/:feed/detail?key=...`, `POST /api/feeds/deep-dives/read`. `feed` là `news`, `hands-on` hoặc `deep-dives`; payload build là `{ "crawlId": null }` (mới nhất) hoặc một ID hoàn tất. Payload lịch là `{ "enabled": true, "intervalMinutes": 60 }`; thao tác đọc là `{ "key": "item:123", "read": true }`.

Cron khôi phục intent crawl/build bị mất queue và lease quá hạn. Khi kiểm tra local, sửa code có thể khởi động lại Worker giữa một poll; chờ lease 15 phút rồi gọi tick poll để kiểm chứng recovery. Không cần sửa trạng thái D1 bằng tay. Lịch sử crawl/feed hiện được giữ; theo dõi dung lượng bảng snapshot khi chạy dài ngày. Rollback code giữ nguyên schema mở rộng và dữ liệu, gồm trạng thái đọc.

## Deploy lần đầu

1. Gắn D1 binding `DB` trên Worker theo [hướng dẫn setup](setup.md). Cloudflare Builds không cần `.env.setup`, D1 ID hoặc biến Access. Giữ `workers_dev: true` và `preview_urls: false` trong `wrangler.json`.

   Nếu đã bật Access, vào Worker → Settings → Domains & Routes (hoặc tab Domains), chọn **Disable Cloudflare Access** cho URL Content Radar. Giữ route `workers.dev` bật. Với Access self-hosted được tạo riêng, gỡ đúng hostname Content Radar khỏi ứng dụng đó, giữ cấu hình cho các ứng dụng khác. [Access trên workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev).

   Khi chuyển sang custom domain, thêm route vào template và đổi `workers_dev: false` nếu chỉ muốn dùng domain mới. Thao tác ghi tự so sánh Origin với URL request thực tế.

2. Với CLI bảo trì, đặt `D1_DATABASE_NAME` trong `.env.setup` bằng đúng tên database gắn ở binding `DB`. Ghi lại bookmark Time Travel, áp dụng migration và đồng bộ cấu hình trước khi deploy code phụ thuộc schema mới:

   ```bash
   npm run setup -- --database
   cd apps/worker
   npx wrangler d1 time-travel info DB
   npx wrangler d1 migrations apply DB --remote
   cd ../.. && npm run config:sync -- --remote
   ```

   Migration đã áp sẽ được bỏ qua và `config:sync` là idempotent. Dùng `npx wrangler d1 migrations list DB --remote` từ `apps/worker` để kiểm tra migration chờ. Trên remote, `wrangler d1 execute --file` chỉ trả bản tóm tắt import; dùng `--command` hoặc `npm run soak-report -- --remote` để đọc kết quả truy vấn.

3. Đặt GitHub PAT trong Worker secret `GITHUB_TOKEN` nếu dùng các nguồn GitHub. `APP_ORIGIN` là tùy chọn để loại hostname của ứng dụng khỏi nội dung crawl nền.

4. Deploy **commit mới nhất** qua Cloudflare Builds (`npm run deploy`), rồi mở trang bằng cửa sổ riêng tư để kiểm tra truy cập không đăng nhập. Trang gốc và `/api/status` phải trả 200; thử lưu/khôi phục một thẻ hoặc đổi lịch feed để xác nhận thao tác ghi hoạt động. Kiểm tra frontend, API và dữ liệu cùng một deployment.

5. Có thể dùng `GET /api/admin/probe?target=llm` để kiểm tra key và kết nối. Các target nguồn: `fxtwitter-timeline`, `fxtwitter-status`, `syndication`, `hn-algolia`, `hn-firebase`, `github-api`, `github-atom`, `rss-uber`, `rss-medium`, `embeddings`.

   Probe AI gọi API thật ngoài sổ ngân sách tự động; không chạy lặp để đo quota. 401/403/404 cần kiểm tra key/model/endpoint, 402 cần kiểm tra số dư.

## AI qua endpoint tùy chỉnh

Cấu hình AI trong **Settings** của Radar. Đặt hoặc đổi mã mở khóa bằng secret `OWNER_TOKEN` trong **Settings → Variables and Secrets** của Worker. Khi secret chưa được đặt, Settings bị khóa. Migration `0013` bỏ cột mã cũ và giữ cấu hình provider. D1 và bản sao lưu D1 vẫn chứa API key của provider.

Chat cần API tương thích OpenAI Chat Completions với JSON mode. Embeddings cần API `/embeddings` trả vector 1.024 chiều. Có thể dùng chung endpoint và key, hoặc cấu hình provider embedding riêng. Nhập key mới khi đổi endpoint. Khi chỉ đổi model, để trống ô key để giữ key đã lưu. Bỏ chọn **Enable AI processing** và lưu để tạm dừng.

Migration `0012` khởi tạo cấu hình ở trạng thái tắt. Sau khi nâng cấp, nhập lại các giá trị trước đây đặt trong biến môi trường vào **Settings**. Các tác vụ mới dùng giá trị đã lưu. Cấu hình mới giữ lịch sử usage, các giới hạn và cooldown theo model. Vector cũ được làm mới ở lượt phân cụm kế tiếp để tránh dùng lẫn dữ liệu của hai provider.

Sau khi lưu, có thể kiểm tra chat và embedding qua `/api/admin/probe?target=llm` và `/api/admin/probe?target=embeddings`, rồi theo dõi backlog trong **System status**.

## Đọc trang trạng thái

| Mục | Bình thường | Cần xem |
|---|---|---|
| Backlog | Trống, hoặc item cũ nhất dưới vài giờ | Tuổi item cũ nhất tăng đều qua các ngày: quota không đủ cho lượng item |
| LLM circuit | `closed` | `open`: năm lỗi liên tiếp cùng loại, hoặc lỗi key/số dư mở ngay; xem `llm_calls` |
| AI app budget | Dưới trần 100/ngày và 5/phút; usage theo ngày Pacific | `parked`: 429/5xx nghỉ vài phút; hết trần ngày chờ ngày Pacific mới |
| Cards | Số thẻ "on fallback headline" nhỏ | Tăng đều: nhu cầu tổng hợp vượt 20% dành riêng; nâng `synthesis_min_score` |
| Cluster runs | `done` mỗi giờ | `failed` quá hai lần liên tiếp: đọc cột Note |
| Sources | 0 failing | Xem mục "Khi một nguồn bị chặn" |

Khi quota không đủ, chỉnh theo thứ tự: siết bộ lọc rẻ (`filter_min_text_length`, từ khoá trong `config/topics.json`), tắt nguồn ưu tiên thấp, rồi mới cân nhắc tăng `max_batch_size` của consumer `content-radar-llm` nếu tỉ lệ `quote_not_found` còn dưới 15%. Khi áp lực quota và chất lượng kéo ngược nhau, chất lượng thắng.

### Có giao diện nhưng chưa có thẻ

Đối chiếu `items`, `claims.published_at` và `cluster_runs.node_count` trên **D1 remote**. Có bài đã crawl hoặc có claim không đồng nghĩa có dữ liệu trong cửa sổ 7 ngày để gom nhóm. Sự cố ngày 2026-09-21 có 16 claim nhưng tất cả từ bài cũ, nên job cluster hoàn tất với 0 node và 0 thẻ; ba model cũng trả 429. [Bằng chứng và bản sửa](../plans/journals/2026-09-21-content-radar-empty-production-feed-diagnosis.md).

Theo quyết định cùng ngày, bài trong cửa sổ gom nhóm được ưu tiên trước; bài cũ giữ trong D1/R2 và xử lý sau khi không còn bài mới đang chờ. Quy tắc áp dụng cả lúc poll, rút backlog và nhận message đã nằm trong queue. Không cần sửa ngày xuất bản, reset quota hoặc nhập thẻ từ database local. Khi model đang nghỉ, kiểm tra `exhausted_until`; hết thời gian này vẫn cần một lượt bóc claim thành công và job cluster tạo cụm đủ điều kiện mới có thẻ.

## Cấu hình

Với database local, cập nhật code rồi chạy migration trước khi khởi động Worker:

```bash
cd apps/worker
npx wrangler d1 migrations apply DB --local --config wrangler.dev.jsonc
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
- GitHub 403 hoặc 429: kiểm tra PAT còn hạn. Feed `releases.atom` không tính vào hạn mức REST; các nguồn `search:` và phần metadata bổ sung của `trending:daily` dùng API.

## Rollback và khôi phục

**Chưa thử trên production.**

Thứ tự an toàn cho mọi thay đổi schema: migration chỉ **mở rộng** (thêm cột, thêm bảng), deploy code, và chỉ thu hẹp schema ở lần phát hành kế tiếp. Nhờ vậy phiên bản Worker trước luôn chạy được trên schema hiện tại.

- **Deploy lỗi:** `cd apps/worker && npx wrangler rollback`. Lệnh đưa Worker về phiên bản trước và không đụng dữ liệu. Đây là đường khôi phục chính.
- **Dữ liệu hỏng:** Time Travel khôi phục D1 về một thời điểm trong 30 ngày: `npx wrangler d1 time-travel restore DB --timestamp=<unix>`. Đây là phương án cuối, vì nó quay ngược **mọi thứ**: sổ ngân sách LLM (hệ thống sẽ tưởng còn lượt đã dùng), trạng thái Saved, Dismissed, Written và `user_actions`. Ghi bookmark trước mỗi lần áp dụng migration để có điểm quay về chính xác.
- **Sao lưu:** `scripts/backup-d1.sh [thư-mục]` xuất toàn bộ database ra một file SQL có ngày, mặc định ở `~/backups/content-radar`, quyền 600. Script từ chối ghi vào trong repo. File chứa toàn bộ dữ liệu: giữ ngoài git, ngoài thư mục mà phiên analyst đọc được, và không tải lên dịch vụ bên ngoài.

## Dead-letter queue

Message hỏng sau 5 lần retry vào `content-radar-dlq`, và Worker tự tiêu thụ queue này. Riêng chờ quota theo phút hoặc model quá tải được trả về D1 sau tối đa bốn retry ngắn, trước trần queue: item vẫn `queued`, headline vẫn đủ điều kiện tổng hợp và phân xử entity trở về `pending`. Cron rút backlog hoặc job cluster sẽ thử lại khi có ngân sách; không phải sửa trạng thái bằng tay cho các lần chờ này.

Một message `extract` thực sự chết thì item tương ứng thành `failed` với `filter_reason = 'dead_letter'` kèm một dòng trong `llm_calls`, để không item nào biến mất trong im lặng. Message crawl hoặc build chết vẫn có intent trong D1; cron khôi phục theo lease và số lần xử lý. Poll cũ không có crawl ID dùng `next_poll_at` để thử lại. Message editorial bổ sung không làm item đã extracted thành failed; giới hạn lần phân tích và cron quản lý việc thử lại. Tìm item hỏng:

```sql
SELECT id, platform, url, filter_reason FROM items WHERE status = 'failed' ORDER BY id DESC LIMIT 50;
```

Cho một item thử lại: `UPDATE items SET status = 'queued', enqueue_attempts = 0, queued_at = NULL WHERE id = <id>;` rồi chờ tick 30 phút kế tiếp.

## Job bảo trì theo ngày (08:20 UTC)

Cập nhật baseline tác giả; dựng lại `story_daily` và `entity_daily` cho 16 ngày theo ngày xuất bản; sửa trạng thái dở dang (lần chạy cluster còn `running` mà lease đã hết, phân xử entity bị mất message); áp chính sách lưu giữ: `run_members`, `poll_log`, `llm_calls` 14 ngày, riêng membership của lần chạy hoàn tất gần nhất của mỗi câu chuyện còn sống được giữ để khớp lineage sau gián đoạn dài. Các bảng dàn dựng `run_stories` và `run_retirements` được dọn sau 14 ngày, hoặc sau một ngày với run thất bại. Embedding và `claim_edges` của claim đã ra khỏi cửa sổ quá 30 ngày được dọn; `item_metrics` cũ hơn 14 ngày gộp còn một snapshot mỗi ngày. `items`, `claims`, `stories`, `lineage_events` và hai chuỗi theo ngày được giữ vĩnh viễn; câu chuyện có thao tác của người dùng không bao giờ bị xoá. Mỗi phần chạy độc lập, một phần lỗi không chặn phần khác.

## Nâng phiên bản phụ thuộc

`.npmrc` đặt `ignore-scripts=true` và `save-exact=true`; luôn cài bằng `npm ci --ignore-scripts`. `ngraph.leiden` là gói trẻ và ít người dùng mà cả lineage dựa vào: chỉ nâng khi có lý do, đọc diff trước, và chạy `npm test --workspace @radar/core` sau đó. Bộ test đó gồm mạng tham chiếu karate club và college football cùng ba fixture có trọng số, và đã từng bắt được việc pha refinement của chính thư viện này làm giảm chất lượng. Test trong `workerd` cần `@cloudflare/vitest-plugin` và Vitest 4.1.x đi cùng nhau.

## Chi phí dự kiến

Ước tính từ bảng giá của Cloudflare, **chưa được đo**; tuần chạy thử là lúc kiểm chứng. Workers Paid là 5 USD mỗi tháng và gồm 10 triệu request cùng 30 triệu CPU-ms. D1 (5 GB, 25 tỉ dòng đọc, 50 triệu dòng ghi), R2 (10 GB, 1 triệu thao tác Class A), Queues (1 triệu thao tác) và Access (50 người dùng) đều có mức miễn phí mà quy mô một người dùng nằm gọn bên trong. Điểm dễ vượt nhất là thao tác Class A của R2; vì vậy consumer chỉ ghi R2 cho item mới hoặc có nội dung đổi, thay vì ghi lại mọi item ở mỗi lần poll. Chi phí AI phụ thuộc endpoint và model đã cấu hình. Trần 100 request/ngày và tối đa 8.192 token đầu ra/request giúp giới hạn mức dùng nhưng không phải trần tiền. Đối chiếu usage với dashboard nhà cung cấp. Hệ thống chỉ gửi nội dung công khai.
