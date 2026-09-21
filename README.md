# Content Radar

Radar cá nhân trả lời một câu hỏi: **giới nghiên cứu và ứng dụng AI/Agent (cùng System Design, Backend) đang có gì thú vị, và đang dịch chuyển về hướng nào?**

Hệ thống crawl nguồn công khai (X qua FxTwitter, Hacker News, RSS, GitHub), dùng DeepSeek bóc từng bài thành các claim có trích dẫn nguyên văn, gom claim thành câu chuyện bằng graph và phân cụm, chấm điểm 0–100, rồi hiển thị thành các thẻ lead. D1 đồng thời là kho dữ liệu để Claude hoặc Codex phân tích sâu hơn. Toàn bộ chạy trên một Cloudflare Worker; DeepSeek tính phí theo token, với trần tự động 100 request/ngày và 5 request/phút.

- Kiến trúc và các quyết định thiết kế: [`docs/architecture.md`](docs/architecture.md)
- Vận hành, deploy, sự cố: [`docs/operations.md`](docs/operations.md)
- Phiên phân tích bằng agent: [`docs/analyst-runbook.md`](docs/analyst-runbook.md)

## Yêu cầu

- Node 22 trở lên và npm.
- Để deploy: tài khoản Cloudflare có Workers Paid, một ứng dụng Cloudflare Access cho hostname Worker (`workers.dev` hiện tại), key DeepSeek có số dư lưu trên AI Gateway (alias `default`, Worker dùng binding `AI`), và một GitHub PAT fine-grained chỉ đọc dữ liệu public.

Không cần gì trong số đó để chạy test.

## Cài đặt và kiểm tra

```bash
npm ci --ignore-scripts     # script cài đặt của mọi gói đều bị tắt, xem .npmrc
npm run typecheck
npm test                    # core (Node), web (jsdom), worker (chạy trong workerd với D1 local)
bash analyst/test/run-query.test.sh
```

Test của Worker không chạm mạng và không chạm tài nguyên Cloudflare thật.

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
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/30+*+*+*+*"   # poll nguồn và rút backlog LLM
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=5+*+*+*+*"      # job phân cụm
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=20+8+*+*+*"     # bảo trì theo ngày
```

Lưu ý: `wrangler dev` sinh nhiều tiến trình `workerd` con. Dừng nó bằng Ctrl+C ở chính terminal đang chạy; dừng riêng tiến trình giữ cổng sẽ để lại tiến trình mồ côi.

## Lệnh thường dùng

| Lệnh | Việc |
|---|---|
| `npm run config:sync -- --local` hoặc `--remote` | Kiểm tra `config/*.json` rồi upsert vào D1; không đụng trạng thái vận hành; mục bị gỡ khỏi file thì bị tắt chứ không bị xoá. |
| `npm run deploy` | Build web rồi `wrangler deploy`. Đọc danh mục kiểm tra trong `docs/operations.md` trước lần đầu. |
| `npm run sweep -- --remote` | Quét lại gamma của CPM trên dữ liệu thật. |
| `npm run soak-report -- --remote` | In báo cáo chạy thử: mọi truy vấn của `scripts/soak-report.sql` kèm kết quả. |
| `npm run test:coverage --workspace @radar/core` | Độ phủ của gói lõi. |
