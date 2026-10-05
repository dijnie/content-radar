# Setup từ template

Repo không chứa ID database production. Mỗi tài khoản điền cấu hình riêng từ [`.env.setup.example`](../.env.setup.example); `npm run setup` dùng [`wrangler.template.json`](../apps/worker/wrangler.template.json) để sinh `apps/worker/wrangler.jsonc`. File đã điền và file sinh ra đều được Git bỏ qua. Mọi chỉnh sửa lâu dài về bindings, routes, cron hoặc giới hạn queue phải đặt trong template, vì setup sẽ ghi lại file sinh ra.

## 1. Chuẩn bị tài nguyên

Trong **cùng một tài khoản Cloudflare**, chọn tài nguyên đang dùng hoặc tạo nếu chưa có:

| Tài nguyên | Tên mặc định | Giá trị cần lấy |
|---|---|---|
| Tài khoản Cloudflare | — | Account ID |
| D1 | `content-radar` | Database ID (UUID) và tên database |
| R2 | `content-radar-raw` | Tên bucket |
| Queue crawl | `radar-poll` | Tên queue |
| Queue LLM | `radar-llm` | Tên queue |
| Queue lỗi | `radar-dlq` | Tên queue |
| Worker | `content-radar` | Tên Worker, khớp với Worker liên kết Git nếu dùng Builds |

Tạo/chọn các tài nguyên trong Cloudflare Dashboard: **Storage & databases → D1 / R2**, **Queues**, **Workers & Pages**. Lấy UUID từ phần Settings của database; tên `content-radar` không thay thế được UUID. [Tài liệu D1](https://developers.cloudflare.com/d1/get-started/#3-bind-your-worker-to-your-d1-database).

`npm run setup` chỉ kiểm tra định dạng và sinh file, không gọi Cloudflare, tạo tài nguyên, áp migration hoặc deploy. Vì vậy Account ID và D1 ID đúng định dạng vẫn cần thuộc tài khoản thực tế có quyền deploy.

## 2. Điền template

Từ thư mục gốc repo:

```bash
cp .env.setup.example .env.setup
# Mở .env.setup, điền Account ID và D1 ID; sửa tên tài nguyên nếu cần.
npm run setup
```

| Biến | Cách điền |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Bắt buộc: Account ID 32 ký tự hex chứa Worker và database. |
| `D1_DATABASE_ID` | Bắt buộc: UUID database đã tạo, không dùng UUID mẫu toàn số 0. |
| `WORKER_NAME`, `D1_DATABASE_NAME`, `R2_BUCKET_NAME` | Tên thực tế; có thể giữ mặc định trong template. |
| `POLL_QUEUE_NAME`, `LLM_QUEUE_NAME`, `DLQ_QUEUE_NAME` | Ba queue khác nhau; setup cập nhật cả producer, consumer và router trong Worker. |
| `LLM_ENDPOINT` | URL HTTP(S) gốc API hoặc đầy đủ `/chat/completions`; query string được giữ. API key điền riêng ở secret `LLM_API_KEY`. |
| `LLM_MODEL` | Tên model đúng theo provider. Điền cùng endpoint, hoặc để cả hai trống để tạm dừng LLM. |

Biến môi trường của process được ưu tiên hơn `.env.setup`, kể cả giá trị rỗng. Setup báo rõ trường thiếu/sai và giữ nguyên file đã sinh nếu dữ liệu không hợp lệ. `npm run deploy` luôn chạy lại setup nên không dùng nhầm ID cũ đã sinh từ lần trước.

## 3. Điền secrets của Worker

Trong **Worker → Settings → Variables and Secrets**, thêm các giá trị dưới đây với loại **Secret**. Secrets đã có thì giữ lại; chỉ điền những giá trị thiếu hoặc cần đổi.

| Secret | Giá trị |
|---|---|
| `LLM_API_KEY` | API key của endpoint; cần khi bật LLM. |
| `GITHUB_TOKEN` | GitHub PAT có quyền đọc dữ liệu public. |
| `OWNER_EMAIL` | Email chủ sở hữu được cho phép truy cập. |
| `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com`, không có `/` cuối. |
| `ACCESS_AUD` | Application Audience của ứng dụng Cloudflare Access. |
| `APP_ORIGIN` | Origin thực tế của ứng dụng, ví dụ `https://content-radar.<subdomain>.workers.dev`. |

Cấu hình Cloudflare Access bảo vệ hostname trước khi đưa ứng dụng vào sử dụng; xem [hướng dẫn Access](operations.md#deploy-lần-đầu). Worker thiếu cấu hình Access sẽ trả 503. Secrets không được chép vào file Wrangler hoặc `.env.setup`; xem [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Nếu dùng CLI, chạy `npx wrangler secret put <TÊN_SECRET> --config wrangler.jsonc` từ `apps/worker` sau setup; Wrangler hỏi giá trị trực tiếp. Lệnh này tạo version và deploy ngay, nên thực hiện với đúng Worker đã cấu hình.

## 4. Migration và deploy

Sau khi đăng nhập Wrangler hoặc cấu hình API token cho đúng tài khoản, từ gốc repo:

```bash
npm run setup
cd apps/worker
# Database đã có dữ liệu: ghi bookmark Time Travel trước khi áp migration.
npx wrangler d1 time-travel info DB --config wrangler.jsonc
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
cd ../..
npm run config:sync -- --remote
npm run deploy
```

`DB` là binding ổn định nên các lệnh vẫn hoạt động khi đổi tên database trong template. `npm run deploy` build web rồi sinh cấu hình và upload Worker; không tự áp migration. Tài nguyên, dữ liệu và secrets hiện có không được sao chép từ tài khoản khác.

## Cloudflare Builds từ Git

Trong Worker đã liên kết Git, đặt:

- **Root directory:** gốc repo.
- **Build command:** để trống, vì deploy command bên dưới đã build web.
- **Deploy command:** `npm run deploy`.
- **Build variables and secrets:** điền các biến ở `.env.setup.example`, ít nhất `CLOUDFLARE_ACCOUNT_ID` và `D1_DATABASE_ID`; thêm endpoint/model khi bật LLM. `WORKER_NAME` phải trùng tên Worker đã liên kết.

Build không cần `.env.setup` trong Git. Script setup đọc trực tiếp biến môi trường và tạo file Wrangler trong máy build. `LLM_ENDPOINT`/`LLM_MODEL` và tên queue được chuyển vào runtime vars bằng script này. Các secrets như `LLM_API_KEY` phải đặt tại **Worker → Settings → Variables and Secrets** ở bước 3; chỉ thêm chúng vào build secrets sẽ không làm Worker nhận được chúng. [Cấu hình Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

Hoàn tất tài nguyên, Access, secrets và migration một lần trước khi retry deployment. Nếu vẫn gặp lỗi D1 `10181`, kiểm tra UUID có thuộc đúng Account ID và tài khoản/token của Builds có quyền với database đó.

## Test và local

`npm test` dùng template với D1 giả lập, không cần `.env.setup` hoặc tài khoản Cloudflare. `npm run dev` dùng `wrangler.dev.jsonc` và `.dev.vars`; [các bước local](../README.md#phát-triển-local) vẫn riêng với deploy.

ID D1 local nay là UUID mẫu toàn số 0, nên lần đầu chuyển từ cấu hình cũ cần chạy lại migration và `config:sync -- --local` như README. Dữ liệu local cũ vẫn nằm trong `.wrangler`; database production không bị thay đổi bởi bước này.
