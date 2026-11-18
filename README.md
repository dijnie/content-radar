# Content Radar

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dijnie/content-radar)

Để tạo Radar mới, chọn tài khoản Cloudflare, đặt `OWNER_TOKEN` trong form rồi bấm **Deploy**. Lần triển khai đầu khởi tạo schema và danh sách nguồn trong D1. Sau đó mở **Settings** trên web để cấu hình LLM và embedding.

Radar cá nhân trả lời một câu hỏi: **giới nghiên cứu và ứng dụng AI/Agent (cùng System Design, Backend) đang có gì thú vị, và đang dịch chuyển về hướng nào?**

Hệ thống crawl nguồn công khai (X qua FxTwitter, Hacker News, RSS, GitHub), dùng LLM qua endpoint tùy chỉnh bóc từng bài thành các claim có trích dẫn nguyên văn, gom claim thành câu chuyện bằng graph và phân cụm, chấm điểm 0–100, rồi hiển thị thành các thẻ lead. D1 đồng thời là kho dữ liệu để Claude hoặc Codex phân tích sâu hơn. Toàn bộ chạy trên một Cloudflare Worker; chi phí AI phụ thuộc nhà cung cấp, với trần mặc định cho chat là 100 request/ngày và 5 request/phút.

Giao diện gồm **Stories**, **News**, **Hands-on**, **Deep dives** và **Jobs**. Jobs ghi lịch sử crawl, lỗi từng nguồn và lịch dựng riêng từng feed. Hands-on có Community toolbox, Field tests, Playbooks; Deep dives có bộ lọc thời gian/chủ đề, tìm kiếm và trạng thái đã đọc lưu trong D1. Mọi thẻ lấy từ nguồn thật và bản công bố đã hoàn tất.

- Kiến trúc và các quyết định thiết kế: [`docs/architecture.md`](docs/architecture.md)
- Vận hành, deploy, sự cố: [`docs/operations.md`](docs/operations.md)
- Setup tài khoản và Cloudflare Builds từ template: [`docs/setup.md`](docs/setup.md)
- Phiên phân tích bằng agent: [`docs/analyst-runbook.md`](docs/analyst-runbook.md)

## Yêu cầu

- Node 22 trở lên và npm.
- Để deploy: tài khoản Cloudflare có Workers Paid, endpoint hỗ trợ OpenAI Chat Completions và Embeddings, API key và tên model, và một GitHub PAT fine-grained chỉ đọc dữ liệu public.

Không cần gì trong số đó để chạy test.

## Cài đặt và kiểm tra

```bash
npm ci --ignore-scripts     # script cài đặt của mọi gói đều bị tắt, xem .npmrc
npm run typecheck
npm test                    # core (Node), web (jsdom), worker (chạy trong workerd với D1 local)
bash analyst/test/run-query.test.sh
```

Test của Worker không chạm mạng và không chạm tài nguyên Cloudflare thật.

## Setup để deploy

Ứng dụng mở công khai để mọi người xem và tương tác, không cần đăng nhập. Trạng thái lưu/ẩn/đã đọc và lịch chạy được dùng chung. Nếu hostname đang có Cloudflare Access, tắt Access cho hostname đó theo [hướng dẫn setup](docs/setup.md).

Trên Cloudflare: **Workers & Pages → content-radar → Bindings → Add binding → D1 database**, đặt variable name là **`DB`**, rồi chọn database của ứng dụng.

Với **Cloudflare Builds**, đặt root directory ở gốc repo và deploy command là `npm run deploy`, rồi chọn build của commit mới nhất. **Không cần terminal, file `.env.setup` hay biến `D1_DATABASE_ID`**. Wrangler dùng lại binding `DB` đã chọn; gắn database trước khi deploy để dùng đúng dữ liệu hiện có. Xem [hướng dẫn setup](docs/setup.md).

## Cấu hình AI trên web

Trong **Settings → Variables and Secrets** của Worker, thêm `OWNER_TOKEN` với loại **Secret** và đặt một giá trị ngẫu nhiên. Khi chạy local, đặt biến này trong `apps/worker/.dev.vars`. Sau khi sao lưu D1 và áp các migration, mở **Settings** trong Radar.

Dùng mã để mở khóa Settings, nhập endpoint tương thích OpenAI, model chat và API key. Chọn model embedding trả vector 1.024 chiều. Embedding có thể dùng chung endpoint và key với chat hoặc dùng một provider riêng. Bấm **Save settings** để áp dụng cho các tác vụ tiếp theo. Bỏ chọn **Enable AI processing** để tạm dừng.

Worker lưu cấu hình và key trong D1. API quản trị chỉ trả trạng thái đã có key. Khi nâng cấp từ bản dùng biến môi trường, nhập lại cấu hình trên web sau migration `0012`. Mỗi lần đổi endpoint hoặc model embedding, lần phân cụm kế tiếp sẽ làm mới các vector đang dùng. [Hướng dẫn vận hành](docs/operations.md#ai-qua-endpoint-tùy-chỉnh)

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `packages/core` | Lõi thuần TypeScript, tất định, không I/O: cạnh có trọng số, phân cụm, lineage, quan hệ dẫn xuất, chấm điểm. Mọi tham số thuật toán nằm ở `src/params.ts`. |
| `apps/worker` | Worker duy nhất: `fetch` (API và static assets sau lớp xác thực), `scheduled` (ba cron), `queue` (ba consumer). Migration D1 ở `migrations/`. |
| `apps/web` | Giao diện React, build ra thư mục tĩnh mà Worker phục vụ. |
| `config` | Chủ đề, nguồn, tác giả, thiết lập. Đồng bộ vào D1 bằng `npm run config:sync`. |
| `analyst` | Truy vấn mẫu và script bọc cho phiên phân tích. |
| `scripts` | Đồng bộ cấu hình, báo cáo chạy thử, quét gamma, sao lưu, backfill. |

## Phát triển local

```bash
cp .dev.vars.example apps/worker/.dev.vars
cd apps/worker && npx wrangler d1 migrations apply content-radar --local --config wrangler.dev.jsonc && cd ../..
npm run config:sync -- --local
npm run build --workspace @radar/web
npm run dev                                    # http://127.0.0.1:8787
```

`npm run dev` dùng `wrangler.dev.jsonc`. Local và production cùng cho phép truy cập công khai. Các thao tác ghi kiểm tra `Origin` theo URL request thực tế, nên không phải điền `APP_ORIGIN` để bấm nút trên giao diện.

Kích cron bằng tay khi đang chạy dev server:

```bash
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/30+*+*+*+*"   # khôi phục job, rút backlog, crawl nguồn đến hạn và lên lịch feed
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=5+*+*+*+*"      # job phân cụm
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=20+8+*+*+*"     # bảo trì theo ngày
```

Sau khi đồng bộ cấu hình, mở **Jobs → Run** để crawl; khi crawl có trạng thái `ok` hoặc `partial`, chọn crawl và bấm Build cho từng feed. News cần claim đã được phân cụm; Deep dives và Field tests/Playbooks cần phân tích nội dung. Crawl hoàn tất không có nghĩa mọi feed đã có đủ dữ liệu. Xem [luồng editorial và công thức điểm](docs/architecture.md#crawl-và-các-feed-editorial).

Lưu ý: `wrangler dev` sinh nhiều tiến trình `workerd` con. Dừng nó bằng Ctrl+C ở chính terminal đang chạy; dừng riêng tiến trình giữ cổng sẽ để lại tiến trình mồ côi.

## Lệnh thường dùng

| Lệnh | Việc |
|---|---|
| `npm run setup` | Kiểm tra `.env.setup`/build variables và sinh cấu hình deploy từ template. |
| `npm run config:sync -- --local` hoặc `--remote` | Kiểm tra `config/*.json` rồi upsert vào D1; không đụng trạng thái vận hành; mục bị gỡ khỏi file thì bị tắt chứ không bị xoá. |
| `npm run deploy` | Build web, chạy setup rồi `wrangler deploy`. Hoàn tất `docs/setup.md` trước lần đầu. |
| `npm run sweep -- --remote` | Quét lại gamma của CPM trên dữ liệu thật. |
| `npm run soak-report -- --remote` | In báo cáo chạy thử: mọi truy vấn của `scripts/soak-report.sql` kèm kết quả. |
| `npm run test:coverage --workspace @radar/core` | Độ phủ của gói lõi. |
