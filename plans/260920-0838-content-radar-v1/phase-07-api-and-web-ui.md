---
title: "Phase 7: API và giao diện web"
status: todo
priority: P1
effort: "2.5d"
dependencies: [6]
---

# Phase 7: API và giao diện web

## Context Links

- [Contract](./research/brainstorm-260920-0730-content-radar-contract.md), mục Spec sản phẩm suy ra từ ảnh chụp
- [Nền tảng](./research/researcher-260920-0735-cloudflare-gemini-platform.md), mục 4 (Workers static assets và Cloudflare Access)

## Overview

Worker phục vụ một API JSON nhỏ và bản build tĩnh của `apps/web`. Giao diện là một trang duy nhất tái hiện ảnh chụp hệ thống tham chiếu: lưới thẻ lead hai cột, tab, lọc chủ đề, tìm kiếm, sắp xếp và bốn thao tác trên thẻ. Thêm một trang trạng thái hệ thống để biết pipeline còn sống.

## Key Insights

- Cloudflare khuyến nghị Workers kèm static assets thay cho Pages ở dự án mới; một Worker phục vụ cả API lẫn giao diện nên chỉ có một lần deploy và một miền để che bằng Access.
- Lớp kiểm tra JWT Access và chống CSRF đã có từ phase 1 và bọc mọi request, kể cả static assets; phase này chỉ gắn route mới vào sau lớp đó.
- Vài nghìn câu chuyện là quy mô mà `LIKE` trên cột `search_text` đã chuẩn hoá đáp ứng tức thì; không cần FTS5.

## Requirements

- [x] API: `GET /api/stories`, `GET /api/stories/:id`, `POST /api/stories/:id/action`, `GET /api/status`. Mọi route đi qua `access-auth` và `request-guard` của phase 1; không route nào được gắn thẳng vào `fetch` mà bỏ qua hai lớp này.
- [x] Thẻ hiển thị đúng spec: nhãn entity, trạng thái `LEAD` hoặc `READY` kèm chấm màu, điểm một chữ số thập phân, headline, các dòng `EVIDENCE`, `CONTEXT`, `COUNTER` có nhãn màu, dòng chân "N independent sources · M questions to verify", nhãn `counterpoint`, thời gian theo múi giờ cấu hình, bốn nút Link, Save, Dismiss, Written.
- [x] Thanh trên cùng: tab "Ready · Lead", "Saved", "Dismissed" kèm số đếm; lọc All, AI, System Design, Backend lấy từ bảng `topics`; ô tìm "Search entity, title or idea"; sắp xếp Newest hoặc Score.
- [x] Thao tác phản hồi tức thì trên giao diện, ghi `stories.user_state` và một dòng `user_actions` kèm điểm và điểm thành phần tại thời điểm đó.
- [x] Dùng được trên màn hình hẹp (một cột) và bằng bàn phím.

## Architecture

API (`apps/worker/src/api/`), router tự viết theo bảng route vì chỉ có vài endpoint:

- `GET /api/stories?tab=inbox|saved|dismissed&topic=<slug>&q=<text>&sort=score|newest&cursor=<c>&limit=30`. Tab `inbox` trả câu chuyện còn sống, `user_state = inbox` và đạt điểm hiển thị tối thiểu; mọi câu chuyện đều có headline vì phase 6 luôn ghi headline dự phòng, và thẻ đang dùng headline dự phòng (`headline_source = 'fallback'`) hiển thị một nhãn nhỏ "chưa tổng hợp". Tab `saved` gồm cả `written`, có nhãn phân biệt. Phân trang bằng cursor theo cặp (giá trị sắp xếp, id). Phản hồi kèm số đếm của ba tab.
- `GET /api/stories/:id` trả câu chuyện, các claim đang `active` theo vai trò (mỗi claim có `text_vi`, `quote`, tác giả, nền tảng, URL gốc, thời gian), danh sách câu hỏi kiểm chứng, điểm thành phần và các sự kiện lineage.
- `POST /api/stories/:id/action { action: "save" | "dismiss" | "written" | "restore" }`.
- `GET /api/status` trả sức khoẻ từng nguồn, ngân sách LLM trong ngày theo model và loại việc, độ sâu backlog (số item `queued` và tuổi của item cũ nhất), trạng thái ngắt mạch, lần chạy cluster gần nhất, số thẻ đang dùng headline dự phòng. Trang này không nằm trong ảnh tham chiếu; nó được giữ vì tiêu chí chạy 7 ngày không người trông cần một chỗ để nhìn thấy backlog và nguồn hỏng, và nó dùng chung truy vấn với `scripts/soak-report.sql` của phase 9.

Nút Link mở URL gốc của claim evidence đầu tiên; khi câu chuyện có nhiều nguồn, nút mở danh sách URL. URL luôn lấy từ `items.url`, không bao giờ từ đầu ra của LLM.

Giao diện (`apps/web/src/`): React với TypeScript, không thư viện component, CSS thuần với biến màu. Trạng thái bộ lọc nằm trên URL để tải lại trang không mất ngữ cảnh. Dữ liệu lấy bằng `fetch` và một hook nhỏ có huỷ request; cập nhật lạc quan cho thao tác, hoàn tác khi lỗi.

```
apps/web/src/
  main.tsx  app.tsx  api-client.ts  types.ts  styles.css
  components/ toolbar.tsx  story-grid.tsx  story-card.tsx  claim-line.tsx
              card-actions.tsx  status-page.tsx  empty-state.tsx
  hooks/ use-stories.ts  use-url-state.ts
```

Xác thực và chống CSRF dùng nguyên hai module `access-auth.ts` và `request-guard.ts` của phase 1. Phát triển local chạy bằng `wrangler.dev.jsonc`, nơi hằng số build `__DEV_AUTH_BYPASS__` bật đường bỏ qua; bundle production không chứa đường này.

## Related Code Files

- Create: `apps/worker/src/api/router.ts`, `stories-routes.ts`, `status-route.ts`, `api-errors.ts`
- Modify: `apps/worker/src/index.ts` (sau `access-auth` và `request-guard`: `/api/*` vào router, gồm cả `admin-probe` và `admin-backfill`; còn lại trả `env.ASSETS.fetch`), `apps/worker/wrangler.jsonc` (khối `assets` trỏ tới `../web/dist`, bật chế độ single-page application, giữ `run_worker_first: true` cho mọi đường dẫn như phase 1 đã đặt)
- Modify: `apps/worker/src/db/stories-repo.ts` (truy vấn danh sách có cursor, số đếm tab)
- Create: các file giao diện liệt kê ở trên trong `apps/web/src/`
- Create: `apps/worker/test/api/*.test.ts`, `apps/web/src/components/*.test.tsx`

## Implementation Steps

1. Chuyển việc gắn route của `admin-probe` và `admin-backfill` vào router mới và viết test khẳng định mọi route, kể cả hai route quản trị và static assets, trả 401 khi thiếu JWT và từ chối `POST` khác origin.
2. Viết router và ba nhóm route. Ô tìm kiếm chuẩn hoá chuỗi giống `search_text` (chữ thường, gỡ dấu) và escape ký tự `%`, `_` trước khi đưa vào `LIKE` bằng tham số bind.
3. Test API trong `workerd` với D1 local: lọc theo tab, chủ đề, tìm kiếm, hai kiểu sắp xếp, phân trang không trùng không sót, thao tác ghi đúng `user_state` và `user_actions`.
4. Dựng giao diện bám sát ảnh tham chiếu [`assets/reference-ui.jpg`](./assets/reference-ui.jpg) (ảnh chụp hệ thống gốc, đã phân tích trong contract): nền sáng, thẻ bo góc viền mảnh, nhãn `EVIDENCE` xanh lá, `COUNTER` đỏ, `CONTEXT` xám, chấm rỗng màu hổ phách cho `LEAD` và chấm đặc xanh cho `READY`, điểm dạng số đơn cách ở góc phải.
5. Viết trang trạng thái: bảng nguồn với lần thành công gần nhất và số lỗi liên tiếp, thanh ngân sách theo model, độ sâu backlog, lần chạy cluster gần nhất.
6. Test component cho `story-card` (đủ ba loại dòng, nhãn `counterpoint`, hai trạng thái) và cho luồng thao tác lạc quan có hoàn tác.
7. Cấu hình build: `npm run build -w @radar/web` ra `apps/web/dist`, `wrangler deploy` đóng gói cả hai. Kiểm tra thủ công trên trình duyệt ở bề rộng 1440 và 390 điểm ảnh, điều hướng bằng bàn phím qua toàn bộ thẻ và nút.

## Todo

- [x] Router gom mọi route sau lớp xác thực, test 401 và CSRF cho từng route
- [x] Route stories và route status
- [x] Truy vấn danh sách có cursor và số đếm tab
- [x] Test API
- [x] Thanh công cụ, lưới thẻ, thẻ, dòng claim, nút thao tác
- [x] Trang trạng thái
- [x] Test component
- [x] Cấu hình assets và kiểm tra trên trình duyệt

## Success Criteria

- Test API và test component xanh.
- Trên bản deploy: chưa đăng nhập Access thì mọi `/api/*` bị chặn; sau khi đăng nhập, trang hiển thị thẻ thật từ D1, bấm Save chuyển thẻ sang tab Saved và tải lại trang vẫn giữ.
- Đặt cạnh ảnh tham chiếu, thẻ có đủ mọi thành phần của spec.

## Risk Assessment

- `wrangler dev --test-scheduled` xung đột với khối `assets` (báo cáo nghiên cứu ghi nhận có issue). Phản ứng: khi cần test cron local thì chạy bằng một file cấu hình phụ không có `assets`.
- Headline dài làm vỡ bố cục. Phản ứng: thẻ co giãn theo nội dung như ảnh tham chiếu, không cắt chữ.

## Security Considerations

- Mọi nội dung từ D1 hiển thị dưới dạng văn bản qua React, không dùng `dangerouslySetInnerHTML`.
- Liên kết ngoài mở bằng `rel="noopener noreferrer"` và chỉ nhận scheme `http` hoặc `https`.
- API không bật CORS; chống CSRF dựa vào kiểm tra `Origin` và `Sec-Fetch-Site` của `request-guard`, không dựa vào CORS.
- Các route quản trị (`/api/admin/*`) đi qua cùng router và cùng hai lớp bảo vệ; test ở bước 1 là bằng chứng.

## Next Steps

`user_actions` ghi ở đây là dữ liệu hiệu chỉnh trọng số điểm ở phase 9 và về sau.
