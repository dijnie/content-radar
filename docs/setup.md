# Setup bằng binding trên Cloudflare

Cloudflare Builds deploy từ Git không cần terminal, file `.env.setup` hoặc biến `D1_DATABASE_ID`. Database được chọn trực tiếp trên Worker qua binding **`DB`**. Code truy cập database bằng `env.DB`.

Ứng dụng mở công khai: mọi người đều xem nội dung và tương tác, không cần đăng nhập. Các thao tác lưu/ẩn/đã đọc và lịch chạy được dùng chung.

## 1. Gắn D1 database

1. Vào **Workers & Pages → content-radar → Bindings → Add binding**.
2. Chọn **D1 database**.
3. Đặt **Variable name = `DB`** (đúng chữ hoa).
4. Chọn database hiện có trong dropdown và lưu binding.

Tên thực tế của database có thể khác `content-radar`; không phải sao chép UUID. Chọn database chứa dữ liệu/schema của ứng dụng. [Hướng dẫn binding D1](https://developers.cloudflare.com/d1/get-started/#3-bind-your-worker-to-your-d1-database).

Cấu hình deploy khai báo:

```json
{
  "d1_databases": [{ "binding": "DB", "migrations_dir": "migrations" }]
}
```

Wrangler 4.135.0 dùng lại binding `DB` trên Worker khi không chỉ định `database_name` hoặc `database_id`. Các giá trị `D1_DATABASE_ID` cũ không được chép vào cấu hình deploy. **Gắn database trước khi retry build**: nếu chưa có binding, cơ chế automatic provisioning của Wrangler có thể tạo database mới; nó chưa có schema hay dữ liệu của ứng dụng. [Automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).

## 2. Tài nguyên còn lại

Giữ các tài nguyên sau trong cùng tài khoản với Worker:

| Binding / vai trò | Tài nguyên mặc định |
|---|---|
| `RAW` | R2 bucket `content-radar-raw` |
| `POLL_QUEUE` | Queue `radar-poll` |
| `LLM_QUEUE` | Queue `radar-llm` |
| Queue lỗi | `radar-dlq` |
| `ASSETS` | Web assets được upload khi build |

Nếu dùng tên khác, đặt `R2_BUCKET_NAME`, `POLL_QUEUE_NAME`, `LLM_QUEUE_NAME`, `DLQ_QUEUE_NAME` trong **Settings → Build → Build Variables and Secrets**. `WORKER_NAME` mặc định là `content-radar`, cần khớp Worker liên kết Git. Account ID được Cloudflare Builds cung cấp; không phải thêm lại trong setup.

## 3. Biến và secrets của ứng dụng

Tại **Worker → Settings → Variables and Secrets**, điền:

| Tên | Loại | Giá trị |
|---|---|---|
| `LLM_ENDPOINT` | Text | URL API tương thích OpenAI, ví dụ `https://your-provider.example/v1`. |
| `LLM_MODEL` | Text | Tên model provider hỗ trợ. |
| `EMBEDDING_MODEL` | Text | ID model embedding trả được vector 1.024 chiều, ví dụ `text-embedding-3-small`. |
| `LLM_API_KEY` | Secret | API key dùng chung cho chat và embeddings. |
| `GITHUB_TOKEN` | Secret | GitHub PAT đọc dữ liệu public. |
| `APP_ORIGIN` | Text, tùy chọn | Origin ứng dụng để loại hostname của chính ứng dụng khỏi nội dung crawl nền. Không cần cho việc xem hay tương tác. |

Deploy giữ các runtime vars đã đặt trên dashboard (`keep_vars: true`). Khi không truyền endpoint/model vào build, setup không sinh giá trị rỗng để ghi đè chúng. Có thể truyền cả `LLM_ENDPOINT` và `LLM_MODEL` vào build để chủ động thay giá trị; đặt cả hai rỗng để tạm dừng LLM. Secrets được giữ lại và không ghi vào file Wrangler. [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#top-level-only-keys), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

`OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN` và `ACCESS_AUD` không còn được code sử dụng. Nếu trước đây đã bật Access cho hostname này, vào **Worker → Settings → Domains & Routes** (hoặc tab **Domains**) và chọn **Disable Cloudflare Access** cho URL ứng dụng; giữ route `workers.dev` bật. Nếu dùng ứng dụng Access self-hosted riêng, gỡ hostname của Content Radar khỏi ứng dụng Access đó; giữ các hostname và policy dùng cho ứng dụng khác. [Access trên workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev).

## 4. Retry deployment

Trong **Settings → Build**, giữ root directory ở gốc repo, production branch là `main` và deploy command là **`npm run deploy`**. Build command có thể để trống vì deploy command đã build web. Sau khi lưu binding và các biến, chọn build của **commit mới nhất** trong **Deployments**; chỉ retry build mang đúng commit cần triển khai. Không cần tạo `.env.setup` trên máy build. [Cấu hình Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## CLI và bảo trì database (tùy chọn)

CLI deploy cũng dùng binding `DB` đã gắn trên Worker. File [`.env.setup.example`](../.env.setup.example) chỉ dành cho các giá trị muốn ghi đè. `npm run setup` sinh `apps/worker/wrangler.jsonc` từ [`wrangler.template.json`](../apps/worker/wrangler.template.json); cả `.env.setup` và file sinh ra đều được Git bỏ qua.

Các lệnh D1 trực tiếp như migrations, `config:sync -- --remote`, `soak-report -- --remote`, `sweep -- --remote` và backup không tự tra binding của Worker. Trước khi chạy chúng, điền **`D1_DATABASE_NAME`** bằng đúng tên database đã chọn ở bước 1 trong `.env.setup`, rồi dùng `npm run setup -- --database`. Các script remote sẽ từ chối chạy nếu thiếu tên này để tránh chọn nhầm database. Không cần UUID.

```bash
npm run setup -- --database
cd apps/worker
npx wrangler d1 time-travel info DB --config wrangler.jsonc
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
cd ../..
npm run config:sync -- --remote
```

Deploy kế tiếp tự sinh lại cấu hình chỉ có binding `DB`, nên tên dùng cho bảo trì không ghi đè binding trên dashboard. Deploy không tự áp migration hoặc đồng bộ `config/*.json`; database mới cần thực hiện hai bước này trước khi phục vụ ứng dụng.

`npm test` dùng D1 giả lập, không cần tài khoản Cloudflare. `npm run dev` dùng `wrangler.dev.jsonc` và `.dev.vars`; xem [hướng dẫn local](../README.md#phát-triển-local).
