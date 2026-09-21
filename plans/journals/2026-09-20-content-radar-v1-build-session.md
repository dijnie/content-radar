---
title: Content Radar v1 build session
date: 2026-09-20
summary: Dựng phase 1 đến 8 và phần local của phase 9; các phép đo đã đổi ba quyết định của plan; review độc lập tìm ra hai lỗi chặn.
---

# Content Radar v1 build session

# Content Radar v1 build session

## Bối cảnh

Chạy `ak-cook <plan.md> --auto, commit each change` trên một thư mục chưa có mã nguồn và chưa có git. Kết quả là một repo npm workspaces gồm `packages/core`, `apps/worker`, `apps/web`, `config`, `analyst`, `scripts`, `docs`, với phase 2 đến 8 hoàn tất phần code và test. Phase 1 và 9 dừng ở phần cần bản deploy thật.

## Những gì phép đo đã đổi so với plan

- `ngraph.leiden` chạy với `refine: false`. Trên karate club, pha refinement của thư viện kéo modularity từ 0,415 xuống 0,364 (tối ưu đã biết 0,4198) và khiến không gamma CPM nào tách được năm câu chuyện dính chung một entity phổ biến. Spike phase 1 chỉ đếm số cộng đồng nên đã bỏ sót; bài học là phải đo chất lượng phân hoạch, không chỉ hình dạng của nó.
- CPM cần thêm `mergeLinkedFragments`. Test tải 3.500 claim cho thấy một đợt bùng nổ 300 claim vỡ thành khoảng 59 câu chuyện, vì trần 30 láng giềng làm cụm lớn thưa đi trong khi CPM là ngưỡng mật độ. Không gamma nào giải được cả hai phía; độ mạnh liên kết thì phân biệt được.
- Quan hệ dẫn xuất chỉ xét liên kết chính của item. Lần crawl thật đầu tiên cho 854 liên kết trên 110 item, tức một bài blog có khoảng 25 liên kết; xét tất cả sẽ gộp oan các nguồn độc lập.
- R2 chỉ được ghi cho item mới hoặc đổi nội dung, vì ghi lại ở mỗi lần poll sẽ vượt mức miễn phí của thao tác Class A.

## Lỗi do test và do chạy thật bắt được

- `INSERT OR IGNORE` của SQLite nuốt cả vi phạm `CHECK`, nên claim sai định dạng biến mất trong im lặng. Đổi sang `ON CONFLICT ... DO NOTHING` trên đúng khoá.
- Khớp mờ cho `quote` chấp nhận một con số bị đổi khi quote đủ dài. Thêm quy tắc mọi token chứa chữ số phải khớp chính xác, có test thất bại trước khi sửa.
- Lineage chỉ đọc snapshot trong `lookbackHours`, nên sau một sự cố dài hơn 24 giờ các câu chuyện cũ sống mãi cạnh bản sao mới. `lookbackHours` là thời gian ân hạn, không phải bộ lọc đầu vào.
- Tham số mặc định `keySet = keySetFor(...)` của lớp xác thực được tính trước thân hàm, nên thiếu cấu hình Access thì trả 500 thay vì 503. Chỉ lộ ra khi chạy dev server thật.
- Hai trong 58 handle X nhớ theo trí nhớ là sai; việc kiểm tra từng handle qua FxTwitter trước khi ghi cấu hình đã bắt được.

## Review độc lập

Reviewer tìm ra hai lỗi chặn mà bộ test xanh đã che: bước công bố của job cluster không nguyên khối vì `chunkedBatch` là nhiều transaction rời nhau, và test "chết ở finalize" kích hook trước khi finalize chạy nên không chứng minh gì; phần 20% ngân sách cho tổng hợp và phân xử chỉ được tôn trọng ở bước lập kế hoạch. Cả hai cùng sáu lỗi mức cao đã được sửa kèm test. Bài học: một test đặt tên theo điều nó muốn chứng minh chưa chắc đã chứng minh điều đó.

## Sơ suất về quy trình

- Sửa thẳng migration `0004` sau khi nó đã được áp dụng ở D1 local, rồi che đi bằng cách dựng lại database local. Phiên tiếp nối đã chuyển hai bảng sang migration `0008`, là cách đúng.
- Dừng dev server bằng cách giết tiến trình giữ cổng. `wrangler dev` sinh nhiều `workerd` con và tự sinh lại chúng, nên để lại tiến trình mồ côi cho tới khi dừng bằng `TaskStop`.

## Còn mở

Deploy, probe nguồn và vị trí Gemini từ IP của Workers, hạn mức Gemini thật, token analyst giới hạn phạm vi, thử rollback và tuần chạy thử 7 ngày. Tài khoản Cloudflare còn chứa `crm-db` và `dijnie-blog-db`; nếu token D1 chỉ giới hạn được ở cấp tài khoản thì phiên analyst sẽ thấy cả hai, và quyết định xử lý thuộc về chủ tài khoản.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
