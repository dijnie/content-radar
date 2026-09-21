# Vận hành

Trạng thái (cập nhật 2026-09-21): người dùng chọn giữ Cloudflare Access trên URL `workers.dev` hiện tại và đăng nhập bằng tài khoản Cloudflare, không dùng mã email của Access. Ứng dụng `Content Radar` chỉ chọn identity provider `Cloudflare`, bật `Restrict to account members` và tự chuyển sang đăng nhập Cloudflare; policy vẫn giới hạn đúng chủ sở hữu. Worker đã có `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`, `APP_ORIGIN`. Cấu hình repo và route thực tế bật `workers_dev`, tắt preview URL. Đã kiểm chứng trang Access không có form mã email, tự chuyển tới `dash.cloudflare.com/oauth2/auth`; phiên đăng nhập hoàn chỉnh vẫn cần kiểm chứng bằng trình duyệt của chủ sở hữu. Bằng chứng ở [báo cáo Access](../plans/reports/cook-260921-0804-cloudflare-access.md).

Tài nguyên Cloudflare đã tạo (D1 `content-radar`, R2 `content-radar-raw`, queue `radar-poll`, `radar-llm`, `radar-dlq`). Ngày 2026-09-21 migration `0001` đến `0009` đã được áp lên D1 remote và cấu hình đã được đồng bộ (3 chủ đề, 119 nguồn, 13 tác giả); từ thời điểm đó **không sửa các file migration này nữa**, mọi thay đổi schema phải là một migration mới. Những quy trình dưới đây có đánh dấu **chưa thử trên production** là viết theo tài liệu của Cloudflare và theo hành vi đã kiểm chứng ở local; hãy cập nhật chúng khi chạy thật lần đầu.

## Deploy lần đầu

Cần có trước: một ứng dụng Access kiểu self-hosted cho hostname của Worker với policy cho đúng một email. Hostname hiện tại là `content-radar.<subdomain>.workers.dev`; không cần custom domain. Lấy **Application Audience (AUD) tag** của ứng dụng và miền team dạng `https://<team>.cloudflareaccess.com`. Xem [Access trên Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

1. Giữ `workers_dev: true` và `preview_urls: false` trong `apps/worker/wrangler.jsonc`. Trong Zero Trust, ứng dụng `Content Radar` phải che toàn bộ hostname `workers.dev`, không giới hạn vào một path. Policy hiện tại dùng lại rule chỉ cho một email; thay đổi rule dùng chung cũng ảnh hưởng ứng dụng Access khác đang dùng nó. Worker vẫn kiểm tra email riêng bằng `OWNER_EMAIL`.

   Trong Zero Trust → Integrations → Identity providers, dùng provider loại `cloudflare` với `restrict_to_account_members: true`. Ở ứng dụng `Content Radar`, `allowed_idps` chỉ gồm provider này và `auto_redirect_to_identity: true`. Email trong policy dùng để kiểm tra danh tính do Cloudflare trả về, không yêu cầu người dùng nhập lại email ở Access. Không chọn `onetimepin` cho ứng dụng này. Xem [Cloudflare làm identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/).

   Nếu sau này chuyển sang custom domain, tạo Access cho hostname mới, cập nhật `ACCESS_AUD` và `APP_ORIGIN`, rồi thêm route (thay hostname thật):

   ```jsonc
   "routes": [{ "pattern": "radar.example.com", "custom_domain": true }]
   ```

   Khi chuyển hoàn toàn sang custom domain, đổi `workers_dev: false`; luôn giữ `preview_urls: false`.

2. Ghi lại bookmark Time Travel, áp dụng migration, đồng bộ cấu hình:

   ```bash
   cd apps/worker
   npx wrangler d1 time-travel info content-radar
   npx wrangler d1 migrations apply content-radar --remote
   cd ../.. && npm run config:sync -- --remote
   ```

   Bước này đã được thực hiện ngày 2026-09-21; chạy lại là an toàn vì migration đã áp dụng thì bị bỏ qua và `config:sync` là idempotent. Lưu ý: trên remote, `wrangler d1 execute --file` đi qua đường import hàng loạt và chỉ trả bản tóm tắt, không trả dòng kết quả. Dùng `--file` cho việc ghi, và `--command` (hoặc `npm run soak-report -- --remote`) khi cần đọc kết quả.

3. Đặt secret (mỗi lệnh hỏi giá trị, không ghi vào file hay lịch sử shell):

   ```bash
   cd apps/worker
   for name in CF_AIG_TOKEN GITHUB_TOKEN OWNER_EMAIL ACCESS_TEAM_DOMAIN ACCESS_AUD APP_ORIGIN; do npx wrangler secret put "$name"; done
   ```

   `ACCESS_TEAM_DOMAIN` không có dấu gạch chéo cuối. `APP_ORIGIN` là origin chính xác đang dùng, hiện là `https://content-radar.<subdomain>.workers.dev`. `OWNER_EMAIL` phải trùng email trong policy. Thiếu một trong ba biến Access thì mọi request nhận 503 `access_not_configured`: Worker từ chối thay vì mở. Chỉ đặt secret còn thiếu; không cần ghi lại token Gateway/GitHub khi sửa Access.

4. Migration `0009_deepseek_models.sql` bật `deepseek-flash` với trần ứng dụng đã chọn: 100 request/ngày Pacific, tối đa 5 request/phút. [`scripts/set-llm-limits.sql`](../scripts/set-llm-limits.sql) áp lại đúng các mức này khi cần. Không phải quota của DeepSeek; 429 không tự sửa các trần. Với model có giới hạn `NULL`, giá trị dự phòng lấy từ `settings` (repo mặc định 5/20).
5. `npm run deploy`, rồi kiểm tra không hostname nào hở:

   ```bash
   # Thay <subdomain> bằng subdomain thực tế; không dùng -L ở bước kiểm tra chặn.
   curl -s -A 'Mozilla/5.0' -H 'Accept: text/html' -o /dev/null -w '%{http_code}\n' 'https://content-radar.<subdomain>.workers.dev/'
   curl -s -A 'Mozilla/5.0' -H 'Accept: text/html' -o /dev/null -w '%{http_code}\n' 'https://content-radar.<subdomain>.workers.dev/api/status'
   ```

   Mong đợi 302 sang miền team Access; client không phải trình duyệt có thể nhận 403. Trang Access dùng JavaScript tự chuyển sang `dash.cloudflare.com/oauth2/auth`, không hiện form nhập email/gửi mã riêng. Không được trả nội dung ứng dụng khi chưa đăng nhập. Kiểm tra cả API, static assets và route quản trị; đối chiếu dashboard/API rằng preview URL đã tắt. Sau đó mở URL gốc trong cùng trình duyệt đã đăng nhập tài khoản Cloudflare của chủ sở hữu, mở radar và bấm "System status". Nếu phiên Cloudflare hết hạn, Cloudflare có thể yêu cầu đăng nhập hoặc xác thực lại theo bảo mật tài khoản. Chỉ có redirect chưa chứng minh phiên truy cập Worker hoàn chỉnh thành công.

6. Sau đăng nhập, có thể chạy probe `GET /api/admin/probe?target=deepseek` để kiểm tra key và kết nối. Các target nguồn vẫn là `fxtwitter-timeline`, `fxtwitter-status`, `syndication`, `hn-algolia`, `hn-firebase`, `github-api`, `github-atom`, `rss-uber`, `rss-medium`, `workers-ai-embed`.

   Probe DeepSeek gọi API thật **ngoài sổ ngân sách tự động**, vẫn tính phí; không chạy lặp để đo quota. 401/403/404 cần kiểm tra key/model/endpoint, 402 cần kiểm tra số dư. Probe dùng cùng endpoint, token và alias với pipeline; xem cấu hình Gateway bên dưới.

## DeepSeek qua AI Gateway

Cấu hình production trong `wrangler.jsonc` chọn gateway `gateway`, provider `deepseek`, alias key `deepseek`. Base URL là `https://gateway.ai.cloudflare.com/v1/67a5d5c1b4057035786e297885f16a82/gateway/deepseek`. Gateway đã bật xác thực; key DeepSeek được chủ sở hữu lưu tại Provider Keys. Client gửi `cf-aig-byok-alias: deepseek` và dùng secret **`CF_AIG_TOKEN`** (quyền AI Gateway: Run của đúng tài khoản) trong `cf-aig-authorization`. Không gửi header Authorization chứa key DeepSeek ở chế độ này.

- Tạo token tại Gateway → Settings → Create authentication token; đặt bằng `npx wrangler secret put CF_AIG_TOKEN` từ `apps/worker`. Không dùng token quản trị tài khoản để chạy ứng dụng. Quyền Run của Cloudflare áp dụng toàn tài khoản, không giới hạn một gateway.
- Nếu chủ sở hữu cung cấp key/token trong `.dev.vars` ở **gốc repo**, chỉ đọc biến được yêu cầu và đưa qua stdin vào secret tương ứng. Wrangler local đọc `apps/worker/.dev.vars`; file ở gốc không tự trở thành secret production. Cả hai file đều nằm ngoài git.
- Giữ trần 100/ngày và 5/phút của ứng dụng. Mỗi request đặt `cf-aig-max-attempts: 1` để gateway không tự nhân số lần gọi ngoài sổ; `cf-aig-skip-cache: true` để kiểm tra thực thi và usage rõ ràng. Metadata `application=content-radar` giúp lọc log.
- Thiếu token, URL gateway sai hoặc lỗi 401/403/404 thì ngừng gọi và giữ việc trong D1. Không tự quay về key trực tiếp hay model khác.
- Local vẫn có thể gọi trực tiếp bằng `DEEPSEEK_API_KEY` nếu không đặt biến Gateway. Khi chủ động quay lại direct, bỏ `CF_AIG_TOKEN` và `DEEPSEEK_BASE_URL`, dùng key DeepSeek còn hiệu lực. Không xoá usage/cooldown để làm lại lượt.

Xác minh sau deploy bằng version/tag, một lượt pipeline thật trong `llm_calls` và log cùng thời điểm trong AI Gateway (provider/model/status); binding hoặc upload thành công chưa chứng minh key upstream đúng. [BYOK và alias](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/), [xác thực](https://developers.cloudflare.com/ai-gateway/configuration/authentication/), [retry](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/).

## Chuyển Worker đang chạy Gemini sang DeepSeek

Khác deploy lần đầu, migration `0009` thay model đang hoạt động nên phải theo thứ tự:

1. Thêm secret `DEEPSEEK_API_KEY` trên Worker và kiểm tra **tên binding**, không xuất giá trị key. Ghi lại version Worker, danh sách model bật và bookmark D1.
2. Build/test và deploy code DeepSeek trước. Nếu còn model Gemini trong DB, client mới sẽ mở ngắt mạch, giữ bài chờ và không gửi tên model sai sang DeepSeek.
3. Áp migration `0009` bằng `npx wrangler d1 migrations apply content-radar --remote`. Migration tắt Gemini, bật Flash với 5/100 và xoá ngắt mạch cũ. Không reset usage hoặc xoá dữ liệu.
4. Đọc lại model, trần và version deploy; kiểm tra `llm_calls` có model mới, claim gần đây có quote hợp lệ và job cluster tạo thẻ. Key tồn tại hoặc deploy xanh chưa chứng minh API hoạt động.

Cron rút backlog mỗi 30 phút, cluster phút 05 mỗi giờ; có claim chưa đồng nghĩa có thẻ ngay. Phiên bản trước chuyển đổi là `d26e9daf-c9ee-48e3-aba8-628f65f0ca18`. Khi rollback: tắt DeepSeek trước, rollback Worker về version này, rồi khôi phục đúng các model Gemini đã bật và xoá `llm_circuit`. Giữ cooldown/usage Gemini để không giả vờ còn quota. Không rollback D1; giữ secret cũ cho tới khi không cần đường quay lại.

## Đọc trang trạng thái

| Mục | Bình thường | Cần xem |
|---|---|---|
| Backlog | Trống, hoặc item cũ nhất dưới vài giờ | Tuổi item cũ nhất tăng đều qua các ngày: quota không đủ cho lượng item |
| LLM circuit | `closed` | `open`: năm lỗi liên tiếp cùng loại, hoặc lỗi key/số dư mở ngay; xem `llm_calls` |
| DeepSeek app budget | Dưới trần 100/ngày và 5/phút; usage theo ngày Pacific | `parked`: 429/5xx nghỉ vài phút; hết trần ngày chờ ngày Pacific mới |
| Cards | Số thẻ "on fallback headline" nhỏ | Tăng đều: nhu cầu tổng hợp vượt 20% dành riêng; nâng `synthesis_min_score` |
| Cluster runs | `done` mỗi giờ | `failed` quá hai lần liên tiếp: đọc cột Note |
| Sources | 0 failing | Xem mục "Khi một nguồn bị chặn" |

Khi quota không đủ, chỉnh theo thứ tự: siết bộ lọc rẻ (`filter_min_text_length`, từ khoá trong `config/topics.json`), tắt nguồn ưu tiên thấp, rồi mới cân nhắc tăng `max_batch_size` của consumer `radar-llm` nếu tỉ lệ `quote_not_found` còn dưới 15%. Khi áp lực quota và chất lượng kéo ngược nhau, chất lượng thắng.

### Có giao diện nhưng chưa có thẻ

Đối chiếu `items`, `claims.published_at` và `cluster_runs.node_count` trên **D1 remote**. Có bài đã crawl hoặc có claim không đồng nghĩa có dữ liệu trong cửa sổ 7 ngày để gom nhóm. Sự cố ngày 2026-09-21 có 16 claim nhưng tất cả từ bài cũ, nên job cluster hoàn tất với 0 node và 0 thẻ; ba model cũng trả 429. [Bằng chứng và bản sửa](../plans/journals/2026-09-21-content-radar-empty-production-feed-diagnosis.md).

Theo quyết định cùng ngày, bài trong cửa sổ gom nhóm được ưu tiên trước; bài cũ giữ trong D1/R2 và xử lý sau khi không còn bài mới đang chờ. Quy tắc áp dụng cả lúc poll, rút backlog và nhận message đã nằm trong queue. Không cần sửa ngày xuất bản, reset quota hoặc nhập thẻ từ database local. Khi model đang nghỉ, kiểm tra `exhausted_until`; hết thời gian này vẫn cần một lượt bóc claim thành công và job cluster tạo cụm đủ điều kiện mới có thẻ.

## Cấu hình

Với database local, cập nhật code rồi chạy migration trước khi khởi động Worker:

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
- **Dữ liệu hỏng:** Time Travel khôi phục D1 về một thời điểm trong 30 ngày: `npx wrangler d1 time-travel restore content-radar --timestamp=<unix>`. Đây là phương án cuối, vì nó quay ngược **mọi thứ**: sổ ngân sách LLM (hệ thống sẽ tưởng còn lượt đã dùng), trạng thái Saved, Dismissed, Written và `user_actions`. Ghi bookmark trước mỗi lần áp dụng migration để có điểm quay về chính xác.
- **Sao lưu:** `scripts/backup-d1.sh [thư-mục]` xuất toàn bộ database ra một file SQL có ngày, mặc định ở `~/backups/content-radar`, quyền 600. Script từ chối ghi vào trong repo. File chứa toàn bộ dữ liệu: giữ ngoài git, ngoài thư mục mà phiên analyst đọc được, và không tải lên dịch vụ bên ngoài.

## Dead-letter queue

Message hỏng sau 5 lần retry vào `radar-dlq`, và Worker tự tiêu thụ queue này. Riêng chờ quota theo phút hoặc model quá tải được trả về D1 sau tối đa bốn retry ngắn, trước trần queue: item vẫn `queued`, headline vẫn đủ điều kiện tổng hợp và phân xử entity trở về `pending`. Cron rút backlog hoặc job cluster sẽ thử lại khi có ngân sách; không phải sửa trạng thái bằng tay cho các lần chờ này.

Một message `extract` thực sự chết thì item tương ứng thành `failed` với `filter_reason = 'dead_letter'` kèm một dòng trong `llm_calls`, để không item nào biến mất trong im lặng. Message poll chết thì không cần làm gì: `next_poll_at` của nguồn đã tự lo việc thử lại. Tìm item hỏng:

```sql
SELECT id, platform, url, filter_reason FROM items WHERE status = 'failed' ORDER BY id DESC LIMIT 50;
```

Cho một item thử lại: `UPDATE items SET status = 'queued', enqueue_attempts = 0, queued_at = NULL WHERE id = <id>;` rồi chờ tick 30 phút kế tiếp.

## Job bảo trì theo ngày (08:20 UTC)

Cập nhật baseline tác giả; dựng lại `story_daily` và `entity_daily` cho 16 ngày theo ngày xuất bản; sửa trạng thái dở dang (lần chạy cluster còn `running` mà lease đã hết, phân xử entity bị mất message); áp chính sách lưu giữ: `run_members`, `poll_log`, `llm_calls` 14 ngày, riêng membership của lần chạy hoàn tất gần nhất của mỗi câu chuyện còn sống được giữ để khớp lineage sau gián đoạn dài. Các bảng dàn dựng `run_stories` và `run_retirements` được dọn sau 14 ngày, hoặc sau một ngày với run thất bại. Embedding và `claim_edges` của claim đã ra khỏi cửa sổ quá 30 ngày được dọn; `item_metrics` cũ hơn 14 ngày gộp còn một snapshot mỗi ngày. `items`, `claims`, `stories`, `lineage_events` và hai chuỗi theo ngày được giữ vĩnh viễn; câu chuyện có thao tác của người dùng không bao giờ bị xoá. Mỗi phần chạy độc lập, một phần lỗi không chặn phần khác.

## Nâng phiên bản phụ thuộc

`.npmrc` đặt `ignore-scripts=true` và `save-exact=true`; luôn cài bằng `npm ci --ignore-scripts`. `ngraph.leiden` là gói trẻ và ít người dùng mà cả lineage dựa vào: chỉ nâng khi có lý do, đọc diff trước, và chạy `npm test --workspace @radar/core` sau đó. Bộ test đó gồm mạng tham chiếu karate club và college football cùng ba fixture có trọng số, và đã từng bắt được việc pha refinement của chính thư viện này làm giảm chất lượng. Test trong `workerd` cần `@cloudflare/vitest-plugin` và Vitest 4.1.x đi cùng nhau.

## Chi phí dự kiến

Ước tính từ bảng giá của Cloudflare, **chưa được đo**; tuần chạy thử là lúc kiểm chứng. Workers Paid là 5 USD mỗi tháng và gồm 10 triệu request cùng 30 triệu CPU-ms. D1 (5 GB, 25 tỉ dòng đọc, 50 triệu dòng ghi), R2 (10 GB, 1 triệu thao tác Class A), Queues (1 triệu thao tác), Workers AI (10.000 neuron mỗi ngày) và Access (50 người dùng) đều có mức miễn phí mà quy mô một người dùng nằm gọn bên trong. Điểm dễ vượt nhất là thao tác Class A của R2; vì vậy consumer chỉ ghi R2 cho item mới hoặc có nội dung đổi, thay vì ghi lại mọi item ở mỗi lần poll. DeepSeek là API trả phí theo token. Trần 100 request/ngày và tối đa 8.192 token đầu ra/request giúp giới hạn mức dùng nhưng không phải trần tiền. Đối chiếu usage với dashboard nhà cung cấp; xem [giá hiện hành](https://api-docs.deepseek.com/quick_start/pricing). Hệ thống chỉ gửi nội dung công khai.
