# Content Radar

Radar cá nhân trả lời một câu hỏi: **giới nghiên cứu và ứng dụng AI/Agent (cùng System Design, Backend) đang có gì thú vị, và đang dịch chuyển về hướng nào?**

Hệ thống crawl nguồn công khai (X qua FxTwitter, Hacker News, RSS, GitHub), dùng LLM qua endpoint tùy chỉnh bóc từng bài thành các claim có trích dẫn nguyên văn, gom claim thành câu chuyện bằng graph và phân cụm, chấm điểm 0–100, rồi hiển thị thành các thẻ lead. D1 đồng thời là kho dữ liệu để Claude hoặc Codex phân tích sâu hơn. Toàn bộ chạy trên một Cloudflare Worker; chi phí AI phụ thuộc nhà cung cấp, với trần mặc định 100 request/ngày và 5 request/phút.

Giao diện gồm **Stories**, **News**, **Hands-on**, **Deep dives** và **Jobs**. Jobs ghi lịch sử crawl, lỗi từng nguồn và lịch dựng riêng từng feed. Hands-on có Community toolbox, Field tests, Playbooks; Deep dives có bộ lọc thời gian/chủ đề, tìm kiếm và trạng thái đã đọc lưu trong D1. Mọi thẻ lấy từ nguồn thật và bản công bố đã hoàn tất.

- Kiến trúc và các quyết định thiết kế: [`docs/architecture.md`](docs/architecture.md)
- Vận hành, deploy, sự cố: [`docs/operations.md`](docs/operations.md)
- Setup tài khoản và Cloudflare Builds từ template: [`docs/setup.md`](docs/setup.md)
- Phiên phân tích bằng agent: [`docs/analyst-runbook.md`](docs/analyst-runbook.md)

## Yêu cầu

- Node 22 trở lên và npm.
- Để deploy: tài khoản Cloudflare có Workers Paid, một ứng dụng Cloudflare Access cho hostname Worker (`workers.dev` hiện tại), endpoint tương thích OpenAI Chat Completions, API key và tên model, và một GitHub PAT fine-grained chỉ đọc dữ liệu public.

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

Trên Cloudflare: **Workers & Pages → content-radar → Bindings → Add binding → D1 database**, đặt variable name là **`DB`**, rồi chọn database của ứng dụng.

Với **Cloudflare Builds**, đặt root directory ở gốc repo và deploy command là `npm run deploy`, rồi retry build. **Không cần terminal, file `.env.setup` hay biến `D1_DATABASE_ID`**. Wrangler dùng lại binding `DB` đã chọn; gắn database trước khi retry để dùng đúng dữ liệu hiện có. Xem [hướng dẫn setup](docs/setup.md).

Đặt endpoint/model và các secrets của ứng dụng ở **Worker → Settings → Variables and Secrets**. Các tên R2/Queue mặc định có trong hướng dẫn; chỉ dùng **Build variables and secrets** nếu muốn ghi đè tên tài nguyên. Với CLI, `.env.setup.example` là file tùy chọn; `npm run setup` sinh cấu hình deploy từ template.

## Cấu hình AI

Điền ba biến trong `apps/worker/.dev.vars` khi chạy local:

```dotenv
LLM_ENDPOINT=https://your-provider.example/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model-id
```

`LLM_ENDPOINT` nhận URL gốc API hoặc URL đầy đủ kết thúc bằng `/chat/completions`. Provider cần hỗ trợ Chat Completions và JSON mode (`response_format: { "type": "json_object" }`). Model được gửi nguyên tên, không giới hạn hãng.

Production: đặt `LLM_ENDPOINT`, `LLM_MODEL` và secret `LLM_API_KEY` trong **Worker → Settings → Variables and Secrets**. Deploy giữ các giá trị trên dashboard; chỉ ghi đè endpoint/model khi bạn truyền cả hai qua build variables hoặc `.env.setup`. Binding `AI` vẫn phục vụ embedding; các lượt LLM gọi endpoint trực tiếp. Xem [hướng dẫn vận hành](docs/operations.md#ai-qua-endpoint-tùy-chỉnh).

Model mới tự có trần 5 request/phút, 100 request/ngày Pacific; model đã tồn tại giữ nguyên giới hạn, cooldown và lịch sử. Bỏ cả endpoint/model khỏi build variables để giữ cấu hình dashboard; đặt cả hai thành chuỗi rỗng để chủ động tạm dừng LLM.

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
cp .dev.vars.example apps/worker/.dev.vars     # đặt APP_ORIGIN=http://127.0.0.1:8787
cd apps/worker && npx wrangler d1 migrations apply content-radar --local --config wrangler.dev.jsonc && cd ../..
npm run config:sync -- --local
npm run build --workspace @radar/web
npm run dev                                    # http://127.0.0.1:8787
```

`npm run dev` dùng `wrangler.dev.jsonc`, file duy nhất đặt hằng số build `__DEV_AUTH_BYPASS__` thành `true`. Bundle production không chứa đường bỏ qua này. Lớp chống CSRF vẫn hoạt động ở local, nên `APP_ORIGIN` phải đúng bằng origin đang mở trên trình duyệt.

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
