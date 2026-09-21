---
title: Content Radar quota recovery and public access diagnosis
date: 2026-09-21
summary: Fix queue retry exhaustion during model cooldowns; recover 67 local items; verify the deployed Worker lacks Access bindings.
---

# Content Radar quota recovery and public access diagnosis

## Tiếp nối

Khôi phục đúng điểm dừng của phiên Claude Code sau probe Gemini lúc 07:09 UTC. Dùng dev server có sẵn của người dùng; không tạo hoặc dừng tiến trình dev. Pipeline tự mở sổ ngày Pacific mới và xử lý tiếp backlog.

## Lỗi và sửa

Chờ model nghỉ vẫn tiêu hao lượt retry của queue, đẩy 67 item chưa từng được bóc claim sang failed. Hai test tái hiện trước sửa. Commit 26330b3 giới hạn retry do quota/model quá tải để trả công việc về D1 trước trần queue; kiểm chứng cả extraction, synthesis và adjudication. 312 test Worker và typecheck đạt. Sau sao lưu local, khôi phục có điều kiện đúng 67 ID; 10 item đã được xử lý lại tại mốc 07:48:45 UTC.

## Trạng thái online

URL workers.dev do người dùng cung cấp trả 503 access_not_configured. Bản deploy dashboard lúc 07:35 UTC có secret Gemini/GitHub nhưng thiếu Access và APP_ORIGIN. Người dùng hỏi về public; đã giải thích hai mức public chỉ đọc hoặc gồm cả thao tác ghi/quản trị, đang chờ chốt. Chưa sửa auth hoặc deploy trong lượt này.

## Tiếp theo

Chi tiết và giới hạn nằm ở [báo cáo tiếp tục](../reports/cook-260921-0729-quota-reset-continuation.md). Backlog còn chờ dịch vụ; tuần chạy production chưa bắt đầu. Giữ plan in-progress. Cấu hình route online và quyền truy cập cần theo lựa chọn mới của người dùng.

## Cập nhật sau lựa chọn lúc 08:04 UTC

Người dùng chốt giữ Cloudflare Access. Dùng tổ chức Zero Trust, mã email và policy một chủ sở hữu có sẵn để bảo vệ hostname Content Radar; bổ sung bốn binding còn thiếu, giữ route workers.dev và tắt preview. Không đổi sang đăng nhập mật khẩu riêng. API secret tạo một version mới trên code đang chạy; không deploy source HEAD.

Sau khi tạo ứng dụng, redirect đã hoạt động nhưng trang Access tạm trả 404; người dùng xác nhận cùng lỗi. Kiểm tra tiếp mà không sửa thêm ứng dụng/policy, trang đăng nhập trả 200 và hiện form gửi mã cho Content Radar. Không coi 302 là kiểm chứng đủ. 33 test Access/CSRF và dry-run deploy qua; đăng nhập hoàn chỉnh vẫn chờ chủ sở hữu. [Báo cáo Access](../reports/cook-260921-0804-cloudflare-access.md) và [vận hành](../../docs/operations.md) ghi lại cấu hình, bằng chứng và giới hạn.

## Làm rõ cách đăng nhập lúc 08:16 UTC

Người dùng muốn dùng phiên tài khoản Cloudflare, không nhập email/gửi mã riêng tại Access. Tra tài liệu và API hiện hành xác nhận provider `cloudflare` hỗ trợ điều này. Đã thêm provider giới hạn thành viên account, chọn riêng provider này cho Content Radar và bật tự chuyển. Giữ nguyên policy một chủ sở hữu và kiểm tra JWT trong Worker. HTTP/HTML xác nhận hết form mã email, tự chuyển tới `/oauth2/auth` của dashboard; bước đăng nhập hoàn chỉnh cần trình duyệt chủ sở hữu. Hướng dẫn vận hành đã sửa theo lựa chọn mới nhất.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
