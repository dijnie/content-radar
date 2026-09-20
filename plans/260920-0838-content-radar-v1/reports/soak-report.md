# Báo cáo chạy thử 7 ngày

Trạng thái: **chưa bắt đầu.** Tuần chạy thử chỉ bắt đầu được sau lần deploy đầu tiên, và lần deploy đó đang chờ custom domain, ứng dụng Access và các secret từ chủ tài khoản (xem [`spike-results.md`](./spike-results.md), mục "Việc còn lại của phase 1"). File này chưa chứa số đo nào; mọi ô bên dưới để trống cho tới khi có dữ liệu thật.

## Cách ghi

Mỗi ngày chạy một lần rồi dán phần đáng chú ý vào mục "Nhật ký theo ngày":

```bash
cd apps/worker && npx wrangler d1 execute content-radar --remote --json --file ../../scripts/soak-report.sql
```

Hai việc phải chủ động làm trong tuần: hạ `rpd` của mọi model xuống thấp trong một ngày để tạo tình huống hết quota rồi khôi phục (`scripts/set-llm-limits.sql`), và từ ngày thứ 3 chạy `scripts/backfill-kols.sh`.

## Đối chiếu tiêu chí chấp nhận

| # | Tiêu chí | Ngưỡng | Kết quả | Bằng chứng |
|---|---|---|---|---|
| 1 | Chạy không người trông 7 ngày; hết quota thì việc nằm lại D1 và được xử lý sau | Không item `live` nào `queued` quá 48 giờ khi còn quota; sau lần hết quota mọi item kết thúc ở `extracted`, `irrelevant` hoặc `failed` | | |
| 1 | Sổ ngân sách mở lại mỗi ngày Pacific | Có call thành công trong một giờ sau nửa đêm Pacific mỗi ngày, hoặc ghi giờ đặt lại quan sát được | | |
| 2 | D1 có đủ dữ liệu | Có dòng ở items, claims kèm URL và quote, entities và alias, cạnh, snapshot, lineage, stories, `source_health`, sổ ngân sách | | |
| 3 | Tính tất định của lõi | Cùng claim, embedding, tham số và seed cho cùng phân hoạch | Đã chứng minh bằng test (20 lần chạy, mọi thứ tự đầu vào) | `packages/core/test/clustering/` |
| 4 | Ổn định lineage | `continue` từ 85% số khớp; dưới 20% câu chuyện sống đổi `story_id` trong một lần chạy | | |
| 4 | Trạng thái thẻ sống qua split, merge, revive và lần chạy chết giữa chừng | Không mất trạng thái nào | Đã chứng minh bằng test; chờ xác nhận trên dữ liệu thật | `apps/worker/test/cluster/` |
| 5 | Giao diện đúng spec, bốn thao tác ghi được vào D1 | Đặt cạnh ảnh tham chiếu đủ thành phần | Đã kiểm ở local tại 1440 và 390 px; chờ xác nhận trên bản deploy | |
| 5 | Không hostname nào truy cập được khi chưa xác thực | curl trả 401 hoặc chuyển hướng Access | | |
| 6 | Phiên analyst bằng token giới hạn phạm vi trả lời được câu hỏi gốc, mọi nhận định có URL, ghi ngược được signal | Tối đa 10 truy vấn; phiên thứ hai đọc lại được signal | | |

Các ngưỡng phụ: dead-letter dưới 1% số message; không lần chạy cluster nào `failed` quá hai lần liên tiếp; trong 20 câu chuyện kiểm tra thủ công ít nhất 16 câu chuyện là một chủ đề nhất quán; chi phí Cloudflare trong tuần không vượt gói 5 USD và chi phí Gemini bằng 0.

Tiêu chí "một người mới làm theo `README.md` dựng được môi trường local và chạy test xanh" đã được thử ngày 2026-09-20 trên một bản clone sạch: `npm ci --ignore-scripts`, `npm run typecheck`, `npm test` (98 + 10 + 285 test) và `bash analyst/test/run-query.test.sh` đều đạt, không cần build web trước.

## Việc cần đo mà ở local không đo được

- Tỉ lệ lỗi vị trí của Gemini trước và sau khi đặt placement.
- Nguồn nào chặn IP của Workers, nhất là FxTwitter.
- Bộ nhớ đỉnh của job cluster trên Worker thật (local không áp trần 128 MB). Ở local, 3.500 claim chạy trong 5,9 giây.
- Giờ Google thật sự đặt lại quota ngày.
- Gamma 0,25 có phù hợp với dữ liệu thật không: chạy `npm run sweep -- --remote` ở ngày 3 và ngày 7.
- Fixture phản hồi Gemini hiện được dựng theo hợp đồng REST đã tài liệu hoá; cần thay bằng bản ghi thật.

## Nhật ký theo ngày

Chưa có.
