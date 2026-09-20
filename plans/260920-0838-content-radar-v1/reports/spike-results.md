# Kết quả spike phase 1

Ngày đo: 2026-09-20. Môi trường local: Node 24.18, Wrangler 4.135.0, `workerd` qua `@cloudflare/vitest-plugin` 1.1.13, Vitest 4.1.11.

Trạng thái: các mục chạy local đã có kết quả dứt khoát. Các mục cần bản deploy thật **chưa đo được**, vì thiếu custom domain, ứng dụng Access và `GEMINI_API_KEY` do người dùng cung cấp. Không con số nào dưới đây là ước đoán thay cho phép đo còn thiếu.

## Bảng quyết định

| Câu hỏi | Trạng thái | Quyết định |
|---|---|---|
| Thư viện Leiden chính và dự phòng | Đã đo | Chính: `ngraph.leiden` 0.3.0 với CPM. Dự phòng: `leiden-ts` 0.1.0 (modularity). |
| CPM có tôn trọng trọng số cạnh không | Đã đo | Có. Phase 5 dùng CPM, không cần nhánh modularity hay tự viết Leiden. |
| Cách lưu embedding | Đã đo local | BLOB trong D1, nạp theo khúc 500 dòng. Không cần nhánh R2. |
| Tỉ lệ lỗi vị trí Gemini trước và sau placement | Chưa đo | Chờ deploy. |
| Có dùng AI Gateway không | Chưa đo | Chờ kết quả placement. |
| Trạng thái từng nguồn từ IP của Workers | Chưa đo | Chờ deploy. |

## Leiden trong `workerd`

Bằng chứng: `apps/worker/test/spike/leiden-in-workerd.test.ts`, 9 test xanh, chạy trong `workerd` (test kiểm tra `navigator.userAgent` bằng `Cloudflare-Workers`).

| Phép thử | `ngraph.leiden` | `leiden-ts` |
|---|---|---|
| Import và chạy được trong `workerd` | Có | Có |
| Karate club (34 node, 78 cạnh) | 4 cộng đồng | 4 cộng đồng, Q = 0,4188 (tối ưu đã biết khoảng 0,4198) |
| Hai lần chạy cùng seed cho cùng phân hoạch | Có, cả modularity lẫn CPM | Có |
| Khôi phục 5 cụm gieo sẵn chỉ nhờ trọng số | Có (CPM, gamma 0,3) | Có (modularity) |
| Hàm chất lượng | Modularity và CPM | Chỉ modularity |

Graph có trọng số dùng để thử là graph đầy đủ 50 node chia 5 cụm, trọng số trong cụm quanh 0,9 và ngoài cụm quanh 0,05. Vì mọi cặp node đều có cạnh, cấu trúc liên kết không mang thông tin nào; chỉ thuật toán đọc trọng số mới tìm lại được cụm. Phép đối chứng xác nhận điều đó: cùng graph nhưng mọi trọng số bằng 1 thì không tìm lại được 5 cụm.

Quét gamma của CPM trên `ngraph.leiden`:

| gamma | Số cộng đồng | Diễn giải |
|---|---|---|
| 0,02 | 1 | Dưới trọng số ngoài cụm, mọi thứ gộp làm một |
| 0,3 | 5 | Giữa hai mức trọng số, đúng 5 cụm gieo sẵn |
| 1,5 | 50 | Trên trọng số trong cụm, không gì dính với nhau |

Hành vi này khớp lý thuyết CPM: gamma là ngưỡng mật độ có trọng số. Hệ quả cho phase 5: gamma phải được chọn theo thang trọng số cạnh thực tế của graph claim, nên tham số này thuộc `params.ts` và cần quét lại trên dữ liệu thật ở tuần chạy thử.

Ghi chú thêm cho phase 5: `leiden-ts` có tuỳ chọn `initialPartition` (khởi động từ phân hoạch trước) và `ngraph.leiden` có `preserveLabels`; cả hai chưa được thử ở đây. Lineage vẫn dựa vào khớp Jaccard sau khi chạy như plan đã chốt. `ngraph.leiden` không kèm khai báo kiểu TypeScript, nên repo tự khai báo phần API đang dùng.

## Nạp vector từ BLOB của D1

Bằng chứng: `apps/worker/test/spike/d1-blob-memory.test.ts`, 3.500 vector Float32 1.024 chiều (4.096 byte mỗi vector, 13,7 MB đóng gói) trên D1 local.

- D1 lưu đúng kích thước đóng gói: `SUM(LENGTH(vector))` bằng 3.500 × 4.096 byte.
- Client D1 trả cột BLOB dưới dạng `number[]`, mỗi byte một phần tử, không phải `ArrayBuffer`. Giả định của plan được xác nhận.
- Mọi vector round-trip chính xác khi giải mã từng khúc vào một `Float32Array` gộp.

| Cỡ khúc (dòng) | Thời gian nạp cả bảng | Đóng gói mỗi khúc |
|---|---|---|
| 100 | 533 ms | 0,4 MB |
| 250 | 542 ms | 1,0 MB |
| 500 | 591 ms | 2,0 MB |
| 1.000 | 634 ms | 3,9 MB |
| 3.500 (cả bảng) | 701 ms | 13,7 MB |

Giới hạn của phép đo: `workerd` local không áp trần 128 MB như production, nên việc khúc 3.500 dòng chạy qua ở local không chứng minh nó an toàn khi deploy. Cỡ khúc được chốt bằng tính toán trên biểu diễn đã quan sát: mảng số của V8 tốn 4 đến 8 byte mỗi phần tử, tức gấp 4 đến 8 lần kích thước đóng gói, cộng với văn bản JSON của phản hồi (khoảng 3,5 lần). Với khúc 500 dòng, phần tạm thời ở mức xấu nhất khoảng 25 MB, cộng 14 MB của mảng gộp, còn xa trần 128 MB. Khúc 1.000 dòng lên khoảng 60 MB và nạp cả bảng vượt trần. Thời gian gần như không đổi theo cỡ khúc, nên chọn khúc nhỏ không tốn gì.

Quyết định: lưu embedding dạng BLOB trong D1, nạp theo khúc 500 dòng, giải mã ngay vào `Float32Array` gộp và không giữ tham chiếu tới mảng dòng. Phase 9 xác nhận lại mức bộ nhớ trên Worker thật trong tuần chạy thử.

## Công cụ và chuỗi cung ứng

- Plan ghi `@cloudflare/vitest-pool-workers`; repo dùng `@cloudflare/vitest-plugin` 1.1.13. Cả hai cùng phát hành từ `cloudflare/workers-sdk` với cùng mô tả, tài liệu Cloudflare hiện hành hướng dẫn gói này, và nó phụ thuộc đúng `wrangler` 4.135.0 đã khoá. Bản `vitest-pool-workers` 0.22.0 kéo theo `miniflare` cũ có cảnh báo mức cao ở `sharp`; sau khi đổi, `npm audit` báo 0 lỗ hổng.
- Pool Workers yêu cầu Vitest 4.1.x, nên repo khoá Vitest 4.1.11 thay vì 5.x.
- `.npmrc` đặt `ignore-scripts=true` và `save-exact=true`; mọi phiên bản trong `package.json` là phiên bản chính xác.
- Trong test, `env` được import từ `cloudflare:workers`; `remoteBindings: false` để test không bao giờ chạm Workers AI thật.

## Tài nguyên Cloudflare đã tạo

| Loại | Tên | Ghi chú |
|---|---|---|
| D1 | `content-radar` | Vùng ENAM, gần vùng Mỹ mà Gemini hỗ trợ và nơi pipeline sẽ được đặt |
| R2 | `content-radar-raw` | Storage class Standard |
| Queue | `radar-poll`, `radar-llm`, `radar-dlq` | Lưu giữ message 14 ngày |

Binding queue trong code là `POLL_QUEUE` và `LLM_QUEUE`. Worker chưa được deploy; `wrangler.jsonc` đặt `workers_dev: false` và `preview_urls: false` và chưa khai báo route, nên hiện không hostname nào trỏ tới Worker.

## Placement (câu hỏi chưa giải quyết số 3 của plan)

Cú pháp đã đọc từ tài liệu Placement hiện hành: `"placement": { "region": "aws:us-east-1" }`, nhận định danh vùng dạng `aws:`, `gcp:` hoặc `azure:`; các lựa chọn `mode: "smart"`, `region`, `host`, `hostname` loại trừ lẫn nhau. Cấu hình này chưa được thêm vào `wrangler.jsonc` vì plan yêu cầu đo 10 lần khi chưa có placement trước.

## Việc còn lại của phase 1, cần người dùng

1. Cung cấp custom domain trên Cloudflare cho Worker.
2. Tạo ứng dụng Access (self-hosted) cho hostname đó với policy một email chủ sở hữu, rồi cung cấp miền team và AUD.
3. Đặt secret bằng `wrangler secret put`: `GEMINI_API_KEY`, `GITHUB_TOKEN`, `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `APP_ORIGIN`.

Sau đó mới làm được: deploy đầu tiên và kiểm tra curl rằng không hostname nào hở, đo lỗi vị trí Gemini trước và sau placement, chạy toàn bộ probe để biết nguồn nào chặn IP của Workers. Rủi ro lớn nhất còn treo là FxTwitter chặn IP Workers, vì X là trục nguồn chính.
