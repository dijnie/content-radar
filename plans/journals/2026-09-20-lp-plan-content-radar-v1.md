---
title: Lập plan Content Radar v1
date: 2026-09-20
summary: "Brainstorm, nghiên cứu, plan 9 phase, red-team 15 nhóm sửa, 4 quyết định kiểm chứng"
---

# Lập plan Content Radar v1

## What happened

Phiên lập kế hoạch cho Content Radar, một radar cá nhân trên Cloudflare lấy cảm hứng từ bài post của Viet Tran: crawl nguồn public, Gemini free tier bóc claim, graph cùng Leiden gom thành câu chuyện, chấm điểm, thẻ lead, và D1 mở cho Claude/Codex phân tích qua wrangler.

- Brainstorm chốt contract tại `plans/reports/brainstorm-260920-0730-content-radar-contract.md`. Probe trực tiếp cho thấy timeline API của FxTwitter trả 20 bài kèm đủ số liệu trong một call, còn Syndication CDN chỉ có like và reply.
- Hai researcher xác minh nền tảng: Workers Free chỉ có 10 ms CPU nên người dùng chọn Workers Paid; Gemini 3.8, 3.7, 3.6 Flash có free tier nhưng hạn mức chỉ đọc được trên AI Studio; lỗi "User location is not supported" vẫn còn, sửa bằng Placement Hints; Nitter đã chết sau thư cease-and-desist tháng 8/2026; Reddit đã đóng truy cập không cần tài khoản.
- Plan 9 phase tại `plans/260920-0838-content-radar-v1/`, ước tính 25 ngày công.

## Red-team

Bốn reviewer đối kháng trả 39 phát hiện, gộp còn 15 nhóm, người dùng chọn áp dụng hết. Những lỗi thiết kế đáng nhớ nhất của bản nháp đầu:

- Câu lệnh đặt chỗ ngân sách là `UPDATE` trần, nên sang ngày Pacific mới không có dòng và hệ thống tự coi là hết quota mãi mãi. Test của chính plan lại khẳng định hành vi sai đó.
- Dùng retry dài ngày của Queues làm backlog trong khi message chỉ sống 14 ngày và hết hạn thì bị bỏ, không vào dead-letter. Sửa: D1 là sổ cái, queue chỉ là tín hiệu đánh thức.
- Lần chạy cluster ghi dở trông giống cộng đồng bị co lại dưới Jaccard, kéo theo death và birth giả và mất trạng thái Saved, Dismissed. Sửa: mọi thứ gắn `run_id`, chỉ hiện ra khi trạng thái lật sang `done` ở câu lệnh cuối.
- `derived_from_claim_id` và alias tác giả được đọc nhưng không phase nào ghi, nên cổng READY vô nghĩa.
- Không có cỡ cụm tối thiểu: claim lẻ vẫn đạt khoảng 58 điểm và thành thẻ.
- Cạnh lưu cả phần entity nên bị đóng băng theo IDF và trạng thái gộp entity cũ. Sửa: chỉ lưu cosine top-k, phần entity tính lại mỗi lần chạy.
- Jaccard trên toàn bộ thành viên giết câu chuyện dài ngày khi loạt claim đầu ra khỏi cửa sổ 7 ngày. Sửa: chỉ so phần còn trong cửa sổ, thêm hồi sinh theo chữ ký entity.
- Access bật sau lần deploy đầu, `workers.dev` hở, cờ tắt xác thực dựa vào header Host. Sửa: kiểm tra JWT trong code từ phase 1, đường bỏ qua chỉ tồn tại trong bản build dev.
- Bình luận HN "dài nhất" là đường prompt injection tới phiên analyst có quyền wrangler đầy đủ. Sửa: chọn theo thứ hạng, giới hạn `quote` 300 ký tự, và cơ chế thật là API token chỉ có quyền D1.

## Decision

- Bỏ Reddit khỏi v1.
- GitHub dùng PAT fine-grained chỉ đọc.
- Bài lẻ chỉ thành LEAD khi robust z engagement từ 3 trở lên; cụm thường cần tối thiểu 2 claim.
- Giữ backfill X 15 ngày vì người dùng yêu cầu, nhưng có cờ riêng, trần 25% quota và chạy từ ngày thứ 3 của tuần chạy thử.
- Giữ `SELECT` tự do cho phiên analyst; không ghim một model Gemini; không chép mã nguồn thư viện Leiden vào repo.

## Next steps

- Người dùng chuẩn bị: custom domain trên Cloudflare, GitHub PAT, hạn mức Gemini thật từ AI Studio.
- Chạy `/ak:cook` với `plans/260920-0838-content-radar-v1/plan.md`, bắt đầu từ phase 1 vì nó kiểm chứng ba giả định chịu lực: lỗi vị trí Gemini, Leiden CPM có trọng số trong workerd, và chi phí bộ nhớ khi nạp BLOB từ D1.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
