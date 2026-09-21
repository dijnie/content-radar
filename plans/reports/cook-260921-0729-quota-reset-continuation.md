# Tiếp tục cook sau khi Gemini mở lại quota

Ngày: 2026-09-21 (UTC). Kế hoạch: [Content Radar v1](../260920-0838-content-radar-v1/plan.md).

## Điểm tiếp nối và phạm vi

- HEAD lúc tiếp nhận: `92130c9`; worktree sạch. Đọc đoạn cuối phiên Claude Code thay vì chỉ dựa vào handoff ngày 20.
- Phiên trước đã áp migration/config lên D1 remote theo xác nhận của người dùng, rồi chạy pipeline local với nguồn, Gemini và Workers AI thật. Handoff lúc tiếp nhận chưa ghi nhận deployment; trong lượt này phát hiện thêm bản deploy từ dashboard lúc 07:35 UTC, xem phần Access bên dưới.
- Lúc 07:09:39 UTC, probe trực tiếp của phiên trước nhận được câu trả lời từ `gemini-3.6-flash`, sau mốc mở lại quota dự kiến 07:00 UTC. Phiên dừng vì hạn mức Claude Code trước khi tiếp tục backlog. Probe này nằm ngoài sổ ngân sách pipeline.
- Lượt tiếp tục dùng dev server của người dùng đang chạy tại `127.0.0.1:8787` từ 07:08:46 UTC. Không khởi động server khác, không dừng hoặc gửi signal tới tiến trình của người dùng.
- Mục tiêu: kiểm chứng backlog tự tiếp tục qua ngày Pacific mới, chạy phân cụm/tổng hợp bằng dịch vụ thật, giữ nguyên hạn mức, tham số graph và trạng thái thẻ. Không triển khai hoặc bắt đầu tuần chạy production.

## Bằng chứng đầu lượt

Chụp trạng thái lúc 07:31:58 UTC, giữ danh sách ID của 103 item đang chờ để đối chiếu riêng với item crawl mới:

| Mục | Trước khi kích tick |
|---|---|
| Items | 260: 45 extracted, 41 irrelevant, 71 filtered_out, 103 queued |
| Claims | 50 |
| Stories | 2, cả hai headline dự phòng; trạng thái người dùng là inbox |
| Models | Cả ba có RPD 20, `exhausted_until` là 07:00 UTC |
| Sổ ngày Pacific 2026-09-21 | Chưa có dòng |
| LLM circuit | Đóng |

## Thực thi

Kích đúng một tick poll/rút backlog theo README:

```bash
curl --fail --max-time 30 'http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/30+*+*+*+*'
```

Kích job phân cụm sau đó:

```bash
curl --fail --max-time 45 'http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=5+*+*+*+*'
```

Cả hai trả `ok`. Đọc kết quả qua `/api/status`, `/api/stories` và kết nối SQLite chỉ đọc vào D1 local. Không sửa quota hoặc lịch poll. Sau khi sửa lỗi bên dưới, khôi phục riêng các item bị đánh dấu sai và kích thêm một tick poll/rút backlog để kiểm chứng hồi phục.

## Lỗi được chứng minh và sửa

- Sau hai lô thành công, 503 tiếp tục khiến các model nghỉ. Consumer vẫn dùng `message.retry` mỗi khi tìm thấy model đang nghỉ hoặc hết RPM; các lần không gọi Gemini cũng tiêu hao trần năm retry của queue.
- Đến 07:40:17 UTC, 67 item bị đưa qua dead-letter và thành `failed`, dù cả 67 có `enqueue_attempts = 0`. Đây là lỗi điều phối, không phải bài đầu vào hỏng.
- Hai test mới thất bại trước sửa: chờ RPM kéo dài làm item thành `failed`; 503 trên lần giao cuối vẫn yêu cầu retry thay vì giữ việc trong D1.
- Commit `26330b3` giới hạn chờ do quota/model quá tải ở bốn retry ngắn. Nếu vẫn không có model dùng được, trả `park`: item giữ `queued`, headline không mất quyền tổng hợp, phân xử entity trở về `pending`. Lỗi xử lý thực sự vẫn theo đường dead-letter cũ. Không đổi quota, chuỗi model hay ngưỡng graph.
- Sao lưu D1 local bằng SQLite backup ra thư mục tạm riêng, quyền hạn chế; chọn đúng ID có log `dead_letter` sau lúc bắt đầu. Khôi phục có điều kiện `status = 'failed' AND filter_reason = 'dead_letter' AND enqueue_attempts = 0`: cả 67 trở lại `queued`, xoá lý do lỗi và `queued_at`, không xoá log hoặc giảm ngân sách đã dùng.
- `foreign_key_check` sạch. Bundle dev đang chạy chứa bản sửa; không khởi động lại hoặc dừng server của người dùng.

## Kết quả tại 07:48:45 UTC

| Mục | Kết quả |
|---|---|
| 103 item chờ từ đầu lượt | 20 extracted, 20 irrelevant, 63 queued; không item failed |
| Toàn bộ items | 261: 65 extracted, 61 irrelevant, 71 filtered_out, 64 queued |
| 67 item vừa khôi phục | 9 extracted, 1 irrelevant, 57 queued; đã kiểm chứng xử lý lại qua pipeline thật |
| Claims | 71 |
| Sổ ngày mới | Tự tạo dòng `day_pt = 2026-09-21`, có call thành công; không reset thủ công |
| Cluster run 3 | Done: 26 claim trong cửa sổ, 2 cạnh, 2 câu chuyện |
| Phân xử entity | 15 trường hợp decided |
| Thẻ 1 | Headline LLM và 3 câu hỏi kiểm chứng xuất hiện qua API |
| Thẻ 2 | Còn headline dự phòng do các lần tổng hợp gặp 503 |
| Trạng thái người dùng | Hai thẻ giữ nguyên ID 1, 2 và inbox |

Đây là mốc chụp trạng thái, không phải cam kết toàn bộ backlog đã hết. Sau khi trả việc về D1, cron 30 phút hoặc job cluster mới có thể đánh thức lại; ở local phải kích cron theo README. Không gửi thêm probe ngoài sổ ngân sách.

## Chẩn đoán `access_not_configured`

Người dùng cung cấp URL production `workers.dev`; GET `/` và `/api/status` đều trả HTTP 503 với `{"error":"access_not_configured"}`. Hai origin local `localhost:8787` và `127.0.0.1:8787` đều trả HTTP 200.

Kiểm tra chỉ đọc bằng Wrangler 4.135.0:

- Deployment mới nhất lúc 07:35:31 UTC, source `dash`, version `5bd8a99e-1dda-4241-9b3c-5143db503226`.
- Có binding DB, R2, AI, assets và hai queue; có secret `GEMINI_API_KEY`, `GITHUB_TOKEN`.
- Thiếu cả bốn binding `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`, `APP_ORIGIN`. Ba biến đầu là điều kiện trả lỗi trong `apps/worker/src/api/access-auth.ts`; biến origin cần cho các thao tác ghi.
- Repo vẫn đặt `workers_dev: false`; route live đang bật khác cấu hình repo. Chưa xác minh source của version remote trùng HEAD, và chưa deploy bản sửa queue trong lượt này.
- [Cloudflare hỗ trợ Access trên workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev); custom domain là lựa chọn của plan cũ, không phải điều kiện bắt buộc của nền tảng. Người dùng đang cân nhắc public: cần chốt public chỉ đọc hay cả thao tác ghi/quản trị trước khi thay lớp xác thực.

## Kiểm chứng và giới hạn

- Sau sửa: 57 test liên quan đạt; toàn bộ Worker 312 test/37 file đạt; `npm run typecheck` đạt cho scripts và cả ba workspace. Không đổi schema, cấu hình runtime hoặc source web/core, nên không chạy lại build web hay suite core/web.
- Review trực tiếp theo `ak-code-review`: đối chiếu cả ba consumer, trần queue trong hai config, đường phục hồi D1 và các lỗi thực sự còn vào dead-letter. Không có phát hiện chặn còn mở; đây không phải review độc lập bởi subagent. Bản sửa có phạm vi nhỏ, không thêm abstraction hoặc thư viện.
- Sửa ghi chú cũ đang nói remote chưa sync, thiếu Gemini key, chưa đo lô 10 item và chưa có fixture 429 thật. `rate-limited-429-recorded.json` đã chứa phản hồi thật, quota ngày 20 request.
- Plan giữ `in-progress`, checklist 101/122 (82%), 6/9 phase hoàn tất theo `ak plan status`. Các tiêu chí production không được đánh dấu hoàn tất bằng lần chạy local này.
- Lịch local vẫn giới hạn nhóm nguồn thử của phiên trước: nhiều nguồn có `next_poll_at` ở năm 2100. Việc này không chứng minh cả 119 nguồn được poll, và `config:sync` giữ nguyên lịch vận hành đó.

## Việc còn mở

- Backlog và headline còn chờ model hết quá tải; không tuyên bố pipeline đã xử lý hết.
- Chốt phạm vi public hoặc Access, đồng bộ cấu hình production; kiểm chứng từ IP Workers, rollback và 7 ngày chạy không người trông.
- Token analyst chỉ có quyền D1 và phiên analyst hai vòng; backfill và hiệu chỉnh graph theo dữ liệu đủ dài.
