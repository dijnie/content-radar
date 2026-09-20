---
title: "Phase 9: Triển khai, chạy thử 7 ngày và tài liệu"
status: todo
priority: P1
effort: "3d"
dependencies: [7, 8]
---

# Phase 9: Triển khai, chạy thử 7 ngày và tài liệu

## Context Links

- [Contract](./research/brainstorm-260920-0730-content-radar-contract.md), mục Acceptance criteria
- [Nền tảng](./research/researcher-260920-0735-cloudflare-gemini-platform.md), mục 3 (Time Travel, export) và mục 6 (hạn mức Gemini)

## Overview

Đưa hệ thống lên production với hạn mức Gemini thật, chạy không người trông 7 ngày, đo theo tiêu chí chấp nhận của contract, hiệu chỉnh tham số bằng dữ liệu thật, backfill nguồn X khi pipeline đã ổn, và viết tài liệu vận hành. Ba ngày effort là thời gian làm việc; bảy ngày chạy thử là thời gian chờ.

## Key Insights

- Tiêu chí chấp nhận số 1 của contract chỉ chứng minh được bằng thời gian chạy thật, và phải gồm ít nhất một lần hết quota Gemini cùng ít nhất một lần sang ngày Pacific mới để thấy backlog sống sót và sổ ngân sách mở lại.
- Tham số graph ở phase 5 đến từ fixture; tuần chạy thử là lúc đầu tiên có dữ liệu thật để quét lại gamma và chỉnh ngưỡng. Mọi thay đổi đi qua `settings.core_overrides`, không sửa code.
- Backfill 15 ngày ngay ngày đầu sẽ ăn hết quota trước khi item trực tiếp đầu tiên được xử lý. Backfill vì vậy chạy sau khi pipeline trực tiếp đã ổn và bị chặn bởi trần 25% RPD của phase 4.
- Dự án chưa có tài liệu nào. Tài liệu cần viết là phần ảnh hưởng tới cài đặt, lệnh, cấu hình, kiến trúc và vận hành; không viết lại những gì code và migration đã tự mô tả.

## Requirements

- [ ] Hạn mức RPM, RPD, TPM thật của từng model được người dùng đọc từ `aistudio.google.com/rate-limit` và ghi vào `llm_models`.
- [ ] Production chạy đủ ba cron, hai consumer, Access và kiểm tra JWT trong code, secret đặt bằng `wrangler secret put`.
- [ ] Báo cáo chạy thử 7 ngày với số liệu theo từng tiêu chí chấp nhận, gồm ngưỡng ổn định lineage.
- [ ] Backfill 15 ngày cho danh sách KOL ban đầu, chạy từ ngày thứ 3 của tuần chạy thử, có giãn cách.
- [ ] Quy trình rollback được thử ít nhất một lần.
- [x] Tài liệu: `README.md`, `docs/architecture.md`, `docs/operations.md`; `docs/analyst-runbook.md` đã có từ phase 8.

## Architecture

Danh mục kiểm tra trước khi bật production:

1. Ghi bookmark Time Travel, áp dụng migration lên remote, chạy `npm run config:sync -- --remote`.
2. Đặt secret `GEMINI_API_KEY`, `GITHUB_TOKEN` (PAT chỉ đọc), `OWNER_EMAIL`; đặt biến `ACCESS_AUD` và miền team Access.
3. Cập nhật `llm_models` bằng hạn mức thật qua `scripts/set-llm-limits.sql` do người dùng điền số.
4. `wrangler deploy`; kiểm tra bằng curl rằng không hostname nào hở, rồi kiểm tra `/api/status` sau khi đăng nhập Access.

Thứ tự triển khai an toàn cho mọi thay đổi schema về sau: migration chỉ mở rộng, deploy code, và chỉ thu hẹp schema ở lần phát hành kế tiếp. Deploy lỗi thì `wrangler rollback` về phiên bản Worker trước mà không đụng dữ liệu. Time Travel là phương án cuối vì nó quay ngược cả `llm_usage` lẫn trạng thái thẻ và `user_actions`.

Số liệu đo trong tuần chạy thử, lấy từ D1 bằng `scripts/soak-report.sql` (dùng chung truy vấn với `/api/status`):

- Số item theo nguồn theo ngày; tỉ lệ `filtered_out`, `irrelevant`, `extracted`, `failed`; tuổi của item `queued` cũ nhất.
- Số call Gemini theo model và loại việc theo ngày so với hạn mức; số lần hết quota; giờ của call thành công đầu tiên sau nửa đêm Pacific; số lần ngắt mạch mở.
- Số message trong dead-letter queue.
- Thời gian CPU, bộ nhớ đỉnh và thời gian chạy của job cluster; số node, cạnh, cộng đồng, claim cô lập mỗi lần chạy; số lần chạy `failed`.
- Độ ổn định lineage: tỉ lệ `continue` trên tổng số khớp; tỉ lệ câu chuyện sống đổi `story_id` mỗi lần chạy; số `split`, `merge`, `revive` mỗi ngày; kiểm tra thủ công 20 câu chuyện xem cụm có đúng là một câu chuyện không.
- Tỉ lệ claim bị loại vì `quote_not_found`; tỉ lệ mention phải phân xử; số thẻ đang dùng headline dự phòng.
- Sức khoẻ nguồn: số giờ mỗi nguồn bị thủng.

## Related Code Files

- Create: `scripts/set-llm-limits.sql`, `scripts/soak-report.sql`, `scripts/backfill-kols.sh`, `scripts/backup-d1.sh`, `scripts/resolution-sweep.ts` (chạy `resolutionSweep` của `@radar/core` trên dữ liệu xuất từ D1)
- Create: `README.md`, `docs/architecture.md`, `docs/operations.md`
- Create: `plans/260920-0838-content-radar-v1/reports/soak-report.md`
- Modify: `config/settings.json` (khối `core_overrides` khi hiệu chỉnh); `packages/core/src/params.ts` chỉ khi một giá trị mặc định cần đổi hẳn, kèm tăng `PARAMS_VERSION`

## Implementation Steps

1. Hỏi người dùng hạn mức Gemini thật và điền `scripts/set-llm-limits.sql`. Nếu người dùng chưa cung cấp, production chạy bằng mức an toàn mặc định của phase 2 và việc này ghi vào báo cáo như một hạng mục còn mở.
2. Chạy danh mục kiểm tra trước production ở trên.
3. Thử rollback một lần: deploy một phiên bản vô hại, chạy `wrangler rollback`, xác nhận Worker trở về phiên bản trước và pipeline vẫn chạy. Ghi lệnh chính xác vào tài liệu vận hành.
4. Để hệ thống chạy 7 ngày. Mỗi ngày chạy `soak-report.sql` một lần và ghi vào `reports/soak-report.md`. Chủ động tạo tình huống hết quota ít nhất một lần bằng cách hạ `rpd` của mọi model xuống thấp trong một ngày, rồi khôi phục và xác nhận backlog trong D1 được rút hết mà không mất item.
5. Từ ngày thứ 3, chạy `scripts/backfill-kols.sh`: gọi endpoint backfill cho từng handle, cách nhau 30 giây, dừng khi gặp lỗi `rate_limited` hoặc `blocked`. Xác nhận trong báo cáo rằng việc bóc tách item trực tiếp không bị chậm đi trong lúc backfill chạy.
6. Hiệu chỉnh sau ngày thứ 3 và ngày thứ 7: chạy `scripts/resolution-sweep.ts` trên dữ liệu thật để chọn lại `resolution`; xem lại `minEdgeWeight`, ngưỡng entity, điểm hiển thị tối thiểu dựa trên kiểm tra thủ công 20 câu chuyện. Trọng số điểm chỉ chỉnh khi đã có từ 50 thao tác trong `user_actions`; nếu chưa đủ thì ghi lại là việc về sau.
7. Thử payload canary cho các lớp chống prompt injection: đưa vào D1 local một item chứa chỉ dẫn giả dạng gửi cho agent, chạy một phiên phân tích theo runbook bằng token giới hạn phạm vi và ghi lại agent có làm theo không; dù kết quả thế nào, xác nhận các lệnh deploy và secret bị Cloudflare từ chối.
8. Viết `scripts/backup-d1.sh`: `wrangler d1 export content-radar --remote --output=<thư mục ngoài repo>/<ngày>.sql`. Thư mục sao lưu nằm ngoài repo và ngoài thư mục làm việc của phiên phân tích.
9. Viết `README.md` (hệ thống là gì, yêu cầu, cài đặt bằng `npm ci --ignore-scripts`, lệnh phát triển, lệnh deploy), `docs/architecture.md` (luồng dữ liệu, mô hình graph, lineage, công thức điểm, vai trò của LLM so với code và giới hạn của tính tất định, sơ đồ Mermaid), `docs/operations.md` (secret, hạn mức Gemini, thêm bớt nguồn và KOL, đọc trang trạng thái, xử lý khi nguồn bị chặn, rollback, Time Travel và cái giá của nó, sao lưu, dead-letter queue, nâng phiên bản các gói ít người dùng, chi phí dự kiến).
10. Đối chiếu từng tiêu chí chấp nhận của contract với bằng chứng trong `soak-report.md`. Chạy một phiên phân tích thật theo runbook và đính kèm câu trả lời cho câu hỏi gốc vào báo cáo.

## Todo

- [ ] Hạn mức Gemini thật trong `llm_models`
- [ ] Danh mục kiểm tra production hoàn tất, deploy xong, không hostname hở
- [ ] Thử rollback
- [ ] Bảy ngày chạy thử, có một lần hết quota có chủ đích
- [ ] Backfill KOL từ ngày thứ 3
- [ ] Quét lại gamma và hiệu chỉnh ngày 3, ngày 7
- [ ] Thử payload canary
- [x] Script sao lưu
- [x] `README.md`, `docs/architecture.md`, `docs/operations.md`
- [ ] `soak-report.md` đối chiếu đủ năm tiêu chí chấp nhận

## Success Criteria

- Bảy ngày liên tục không có can thiệp thủ công ngoài lần hạ quota có chủ đích và lần chạy backfill; khi quota còn, không item `live` nào ở trạng thái `queued` quá 48 giờ.
- Mỗi ngày trong tuần đều có call Gemini thành công trong vòng một giờ sau nửa đêm Pacific, hoặc báo cáo ghi lại giờ đặt lại quota thực tế quan sát được.
- Sau lần hết quota, mọi item đã `queued` đều kết thúc ở `extracted`, `irrelevant` hoặc `failed`; không item nào kẹt hay biến mất.
- Dead-letter queue dưới 1% số message; không lần chạy cluster nào `failed` quá hai lần liên tiếp.
- Ổn định lineage: tỉ lệ `continue` từ 85% số khớp trở lên, và dưới 20% câu chuyện sống đổi `story_id` trong một lần chạy bất kỳ.
- Trong 20 câu chuyện kiểm tra thủ công, ít nhất 16 câu chuyện là một chủ đề nhất quán.
- Chi phí Cloudflare trong tuần không vượt gói 5 USD; chi phí Gemini bằng 0.
- Một người mới làm theo `README.md` dựng được môi trường local và chạy test xanh.

## Risk Assessment

- Quota free tier thực tế quá thấp so với lượng item. Tín hiệu: tuổi của item `queued` cũ nhất tăng đều qua các ngày. Phản ứng theo thứ tự: siết bộ lọc rẻ, giảm số nguồn ưu tiên thấp, rồi mới tăng `max_batch_size` nếu tỉ lệ `quote_not_found` còn thấp; mọi thứ là cấu hình. Nếu vẫn không đủ thì báo người dùng với con số cụ thể vì đây là giới hạn của ràng buộc 0 USD.
- Không đạt ngưỡng ổn định lineage. Phản ứng: quét lại gamma; nếu vẫn không đạt thì ghi các ca lỗi làm fixture cho `packages/core` và chỉnh công thức cạnh; nếu nguyên nhân là thư viện Leiden thì đổi adapter theo phương án của phase 5. Plan không được coi là hoàn thành khi tiêu chí này chưa đạt.
- Một nguồn bị chặn trong tuần chạy thử. Phản ứng: `source_health` và trang trạng thái hiển thị; tài liệu vận hành có quy trình xử lý.

## Security Considerations

- File sao lưu chứa toàn bộ dữ liệu, nằm ngoài git, ngoài thư mục mà phiên phân tích đọc được, và không được tải lên dịch vụ bên ngoài.
- `scripts/set-llm-limits.sql` chỉ chứa con số hạn mức, không chứa key.
- Rà lại repo trước commit cuối: không có `.dev.vars`, không có key, không có email cá nhân; `package-lock.json` đã commit và các gói ít người dùng đang ở phiên bản chính xác.

## Next Steps

Sau v1: bổ sung arXiv và HF Papers (đã để ngoài phạm vi bản đầu), cân nhắc lại Reddit nếu có đường truy cập chính thức, hiệu chỉnh trọng số điểm khi đủ 50 đến 100 thao tác, cân nhắc tự host FxEmbed nếu FxTwitter bất ổn.
