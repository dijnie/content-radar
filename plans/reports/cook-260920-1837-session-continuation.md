# Tiếp tục phiên cook Content Radar

Ngày: 2026-09-20. Kế hoạch: [Content Radar v1](../260920-0838-content-radar-v1/plan.md).

## Điểm tiếp nối

Phiên Claude Code chạy `ak-cook <plan.md> --auto, commit each change`, dừng vì hạn mức phiên sau commit `22225b9`. Khi tiếp nhận, thay đổi chưa commit chỉ có `.gitignore` và `.agentkit/`; giữ nguyên các thay đổi đó.

Đã khôi phục kế hoạch hiện hành bằng `ak plan use`. Theo checkbox của các phase: 99/122 việc, bốn phase hoàn tất (3, 5, 6, 7). Các nhãn Pending/todo từ lúc lập kế hoạch chưa được đồng bộ; dùng checkbox, báo cáo này và bằng chứng thực thi để đọc tiến độ. Giữ toàn bộ plan ở `in-progress` vì chưa deploy và chưa có tuần chạy thử.

## Bản sửa bổ sung

| Commit | Nguyên nhân đã chứng minh | Kết quả |
|---|---|---|
| `e6da908` | D1 local ghi nhận đã áp dụng 0001–0007, nhưng thiếu `run_stories` và `run_retirements` vì bản sửa trước thêm bảng vào migration 0004 đã chạy | Chuyển hai bảng sang migration mới `0008_cluster_publication.sql`; hỗ trợ cả database cũ lẫn database đã có hai bảng; đã áp dụng lên local |
| `96b8946` | Hai test mất lease ở `finalize`/`publish` vẫn trả `done`, công bố câu chuyện dù khóa đã đổi chủ | Kiểm tra lại trước công bố và ràng buộc quyền sở hữu trong mọi câu lệnh của transaction công bố; không công bố hay xếp synthesis khi mất khóa |

Migration giữ nguyên nội dung của 35 bảng ứng dụng có trước, đối chiếu từng bảng với bản sao SQLite trước nâng cấp; `foreign_key_check` sạch. Có bản sao local ở thư mục tạm ngoài repo. Thử nâng cấp cả schema gốc và schema 0004 đã sửa, chạy lại migration, đều giữ nguyên story Saved.

Test tranh chấp còn kiểm tra trường hợp khóa đổi chủ **sau** lần kiểm tra TypeScript cuối nhưng **trước** transaction D1: story, membership và trạng thái Saved đã công bố giữ nguyên; khóa của job mới không bị xoá; không gửi thêm synthesis. Test chạy các câu lệnh thật trên D1 local.

## Đối chiếu review trước

Nguồn: [review các module rủi ro cao](./code-reviewer-260920-1830-high-risk-modules.md). Đây là kiểm tra tiếp nhận và bản sửa của phiên trước, không phải một lượt audit độc lập mới.

- Công bố nguyên khối, phân bổ 80/20 của ngân sách, HTML thiếu end tag, heartbeat/lease, số lần thử extraction, tham số tab/sort, giữ membership cho lineage và bọc chuỗi analyst: đã có bản sửa và các test liên quan chạy đạt. Migration nâng cấp và mất lease sát thời điểm công bố được sửa thêm trong phiên này.
- Truy vấn membership theo từng story đã đổi thành truy vấn gom lô; backfill có lease riêng theo tài khoản.
- Probe Gemini vẫn là ngoại lệ gọi trực tiếp ngoài sổ ngân sách; không coi ghi chú trong code là sửa xong phần hạch toán. Phải tính các call probe khi đối chiếu quota thật.
- Backfill vẫn trả kết quả trong request HTTP; lease ngăn chạy trùng nhưng chưa chuyển thành job nền. Khả năng chạy thật và thời gian phản hồi còn chờ deploy.
- Ghi claim/mention vẫn dùng một transaction mỗi item; không thay bằng các transaction rời. Chú thích đã giải thích phụ thuộc vào thứ tự câu lệnh.

## Kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| `npm test` | 408 test: core 98, web 10, worker 300; 47 file đạt |
| `npm run typecheck` | Đạt: scripts và ba workspace |
| `npm run build` | Build web production đạt |
| `wrangler deploy --dry-run` | Bundle Worker đạt, nhận đủ binding và 74 static asset; không deploy |
| `bash analyst/test/run-query.test.sh` | 18 kiểm tra đạt |
| Nâng cấp D1 local có dữ liệu | Đạt, 35 bảng cũ giữ nguyên |
| Migration từ hai biến thể schema và chạy lại | Đạt |
| Test lease bị lấy trong finalize/publish | Hai ca thất bại trước sửa, đạt sau sửa |
| Test lấy lease giữa kiểm tra và transaction | Đạt, giữ nguyên dữ liệu đã công bố |

Wrangler in cảnh báo chuẩn về binding AI; bộ test dùng embedder/fetcher trong test và `remoteBindings: false`. Kết quả local không chứng minh Gemini, FxTwitter hay Workers AI hoạt động trên production.

## Việc còn lại / thông tin cần có

Người dùng đã chọn hoàn tất local trước. Các mục dưới thuộc đợt tích hợp dịch vụ thật/triển khai sau, không còn là điều kiện chặn bàn giao local.

1. Hostname Cloudflare, Access team domain, AUD, email chủ sở hữu và các secret được cấu hình qua đường bảo mật. Cấu hình production hiện chưa có route; không deploy trong phiên này.
2. Áp migration và đồng bộ config remote; xác minh Access với mọi hostname; probe nguồn và vị trí Gemini trước/sau placement.
3. Hạn mức Gemini thật, fixture ghi từ phản hồi thật và kiểm chứng quota reset.
4. Token analyst chỉ có quyền D1, kiểm chứng phạm vi bằng tài khoản thật; chạy phiên analyst hai vòng và payload canary.
5. Rollback, tuần chạy thử 7 ngày, backfill từ ngày 3, quét gamma và kiểm tra chất lượng/lineage bằng dữ liệu thật.

Không đánh dấu những việc này hoàn tất bằng kết quả test local. Chưa push hoặc tạo PR.

## Chốt phạm vi local

Ngày 2026-09-20, sau khi người dùng xác nhận chưa có hostname/Access:

- Chạy đồng bộ cấu hình local hai lần; mỗi lần thành công, giữ nguyên 3 topic, 119 source và 13 author.
- Khởi động bằng lệnh dev của workspace Worker, gắn `127.0.0.1:8787`, dùng D1 local hiện có và bundle web đã build.
- Trang gốc cùng hai asset JS/CSS trả HTTP 200; `/api/stories` và `/api/status` trả HTTP 200; status đọc được cấu hình local.
- `sort=constructor` trả HTTP 400. POST khác origin và POST thiếu origin đều trả HTTP 403; không thay đổi trạng thái thẻ.
- API danh sách trả 0 thẻ. Không thêm dữ liệu giả hoặc kích pipeline gọi Gemini/Workers AI/nguồn ngoài để lấp giao diện.
- Dừng dev server bằng Ctrl+C; cổng 8787 đã giải phóng và không còn tiến trình Wrangler/workerd của lượt kiểm tra.
- Không thay đổi source sau các gate 408 test, typecheck, build và Worker dry-run đã đạt ở trên; không chạy lặp lại các gate đó chỉ để đổi thời điểm báo cáo.

Phần bàn giao local hoàn tất trong phạm vi đã chốt. Có thể mở lại bằng `npm run dev` theo [README](../../README.md#phát-triển-local). Tích hợp dịch vụ thật và tiêu chí chạy 7 ngày vẫn chưa được chứng minh.
