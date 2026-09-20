---
title: "Phase 1: Nền móng và kiểm chứng rủi ro"
status: todo
priority: P1
effort: "2d"
dependencies: []
---

# Phase 1: Nền móng và kiểm chứng rủi ro

## Context Links

- [Contract](./research/brainstorm-260920-0730-content-radar-contract.md)
- [Nền tảng Cloudflare và Gemini](./research/researcher-260920-0735-cloudflare-gemini-platform.md), mục 1, 4, 7, 9
- [Graph, Leiden và nguồn](./research/researcher-260920-0735-graph-leiden-and-sources.md), mục Q1, Q6

## Overview

Dựng khung repo và tài nguyên Cloudflare, đặt lớp xác thực trước lần deploy đầu tiên, rồi trả lời bằng thực nghiệm các giả định mà cả hệ thống dựa vào trước khi viết code nghiệp vụ. Mọi kết quả được ghi vào `reports/spike-results.md` trong thư mục plan này và quyết định các nhánh ở phase sau.

## Key Insights

- Gemini free tier vẫn trả "User location is not supported" khi Worker chạy ở một số vùng; cách sửa có tài liệu là Placement Hints cố định vùng, AI Gateway là lớp dự phòng chưa được bảo đảm.
- Cả ba thư viện Leiden bằng JS đều trẻ và ít người dùng; phải chứng minh thư viện được chọn chạy trong `workerd`, tất định, và hỗ trợ CPM trên graph có trọng số trước khi phase 5 dựa vào nó. Karate club là graph không trọng số nên chưa đủ làm bằng chứng.
- Client D1 trả cột BLOB dưới dạng mảng số JavaScript chứ không phải `ArrayBuffer`, nên chi phí bộ nhớ khi nạp vector lớn hơn kích thước đóng gói nhiều lần. Phải đo trước khi chốt cách lưu embedding.
- Chưa ai xác nhận FxTwitter, Syndication và một số feed có chặn IP của Workers hay không; chỉ Worker thật mới trả lời được.
- Worker lộ ra internet ngay từ lần deploy đầu; Access trên dashboard chỉ che hostname được khai báo, còn `workers.dev` và preview URL thì không. Xác thực trong code phải có từ đầu.

## Requirements

- [ ] Repo là git repository với npm workspaces, TypeScript strict, Vitest; `package-lock.json` được commit, mọi nơi cài bằng `npm ci --ignore-scripts`, thư viện Leiden và thư viện trích nội dung bài được khoá phiên bản chính xác.
- [ ] Một Worker triển khai được lên Cloudflare với đủ binding D1, R2, hai queue, dead-letter queue, Workers AI và static assets; `workers_dev: false` và `preview_urls: false`, chỉ phục vụ qua một custom domain nằm sau Cloudflare Access.
- [ ] Mọi request tới Worker, kể cả static assets, đi qua lớp kiểm tra JWT của Access trong code trước lần deploy đầu tiên.
- [ ] Endpoint chẩn đoán cố định `GET /api/admin/probe?target=<tên>` chỉ gồm các phụ thuộc bên ngoài, vì việc nguồn chặn IP có thể thay đổi theo thời gian và cần công cụ kiểm tra lâu dài.
- [ ] Không secret nào nằm trong repo; `.dev.vars` bị git bỏ qua, có `.dev.vars.example` chỉ chứa tên biến.

## Architecture

```
content-radar/
  package.json            workspaces: packages/*, apps/*
  package-lock.json
  tsconfig.base.json
  packages/core/          @radar/core, TypeScript thuần
  apps/worker/            @radar/worker
    wrangler.jsonc        production: crons, queues, d1, r2, ai, assets, placement,
                          workers_dev=false, define __DEV_AUTH_BYPASS__="false"
    wrangler.dev.jsonc    chỉ dùng cho `npm run dev`: define __DEV_AUTH_BYPASS__="true"
    src/index.ts          export default { fetch, scheduled, queue }
    src/env.ts
    src/api/access-auth.ts    kiểm tra JWT Access
    src/api/request-guard.ts  chống CSRF cho request thay đổi trạng thái
    src/api/admin-probe.ts
  apps/web/               @radar/web, Vite + React + TypeScript, build ra apps/web/dist
  config/  analyst/  docs/
```

Tên tài nguyên: D1 `content-radar`, R2 `content-radar-raw`, queue `radar-poll`, `radar-llm`, `radar-dlq`. Cron khai báo sẵn: `*/30 * * * *`, `5 * * * *`, `20 8 * * *`.

Xác thực (`access-auth.ts`): kiểm tra header `Cf-Access-Jwt-Assertion` bằng `jose` với JWKS của team Access; ghim thuật toán `RS256`; đối chiếu `iss` với miền team, `aud` với `ACCESS_AUD`, `exp` và `nbf`; claim `email` phải bằng biến `OWNER_EMAIL`; lỗi tải JWKS khi chưa có cache thì từ chối (fail-closed). Không có biến runtime nào tắt được kiểm tra: đường bỏ qua cho phát triển local nằm sau hằng số build `__DEV_AUTH_BYPASS__`, chỉ bằng `true` trong `wrangler.dev.jsonc`, nên bị loại khỏi bundle production. Khối `assets` đặt `run_worker_first: true` cho mọi đường dẫn để static assets cũng qua lớp này.

Chống CSRF (`request-guard.ts`): request không phải `GET` hoặc `HEAD` bị từ chối nếu `Sec-Fetch-Site` khác `same-origin` hoặc `Origin` không khớp chính xác origin đã deploy, và từ chối khi thiếu cả hai; `POST` bắt buộc `Content-Type: application/json`.

## Related Code Files

- Create: `package.json`, `package-lock.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `.npmrc` (`ignore-scripts=true`), `.dev.vars.example`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/vitest.config.ts`
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/wrangler.jsonc`, `apps/worker/wrangler.dev.jsonc`, `apps/worker/vitest.config.ts`, `apps/worker/src/index.ts`, `apps/worker/src/env.ts`, `apps/worker/src/api/access-auth.ts`, `apps/worker/src/api/request-guard.ts`, `apps/worker/src/api/admin-probe.ts`
- Create: `apps/worker/test/api/access-auth.test.ts`, `apps/worker/test/api/request-guard.test.ts`, `apps/worker/test/spike/leiden-in-workerd.test.ts`, `apps/worker/test/spike/d1-blob-memory.test.ts`
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`
- Create: `plans/260920-0838-content-radar-v1/reports/spike-results.md`

## Implementation Steps

1. Chạy `git init`, tạo workspaces và ba package rỗng có script `build`, `test`, `typecheck`. Gói `apps/worker` dùng `@cloudflare/vitest-pool-workers`, gói `packages/core` dùng Vitest thuần trên Node.
2. Tạo tài nguyên bằng Wrangler: `wrangler d1 create`, `wrangler r2 bucket create`, `wrangler queues create` cho ba queue. Ghi ID vào `wrangler.jsonc`. Trước khi dùng lệnh nào, đọc `wrangler <lệnh> --help` để xác nhận cờ hiện hành.
3. Tạo ứng dụng Access cho custom domain với policy một email chủ sở hữu, lấy `aud`. Viết `access-auth.ts` và `request-guard.ts` kèm test: thiếu JWT trả 401; sai `aud`, sai `iss`, sai `email`, hết hạn trả 403; JWKS không tải được trả 503 và không cho qua; `POST` từ origin khác bị từ chối. Nối cả hai vào `fetch` trước mọi route và trước `env.ASSETS.fetch`.
4. Viết `admin-probe.ts` nhận `target` thuộc danh sách cố định (không nhận URL tuỳ ý để tránh biến Worker thành proxy mở): `gemini`, `fxtwitter-timeline`, `fxtwitter-status`, `syndication`, `hn-algolia`, `hn-firebase`, `github-api`, `github-atom`, `rss-uber`, `rss-medium`, `workers-ai-embed`. Mỗi probe trả JSON gồm HTTP status, thời gian, `colo` của request và độ dài phản hồi; không trả nội dung phản hồi của upstream.
5. Deploy lần đầu chỉ sau khi bước 3 xanh. Kiểm tra bằng curl: hostname `workers.dev` không phân giải tới Worker; custom domain không có JWT trả 401 cho cả `/` lẫn `/api/admin/probe`.
6. Probe `gemini` gọi `gemini-3.8-flash` với một prompt một dòng và `responseJsonSchema` tối giản. Đo 10 lần khi chưa có `placement`, rồi thêm `placement` theo đúng cú pháp trong tài liệu Placement hiện hành [UNVERIFIED: cú pháp chính xác của region hint cần đọc từ docs lúc làm], deploy lại và đo lại. Nếu vẫn lỗi vị trí, thử định tuyến qua AI Gateway và ghi kết quả.
7. Viết `leiden-in-workerd.test.ts`: cài `ngraph.leiden` và `leiden-ts` (phiên bản chính xác), chạy trong `workerd` trên karate club và trên một graph có trọng số sinh từ năm cụm giả lập; hai lần chạy cùng seed phải cho cùng phân hoạch; với `ngraph.leiden` kiểm tra thêm CPM có tôn trọng trọng số cạnh không bằng cách quét ba giá trị gamma và ghi số cộng đồng. Ghi thư viện được chọn và thư viện dự phòng.
8. Viết `d1-blob-memory.test.ts`: ghi 3.500 vector Float32 1024 chiều vào D1 local, nạp lại theo khúc, giải mã từng khúc vào một `Float32Array` gộp và bỏ tham chiếu tới mảng dòng của D1; ghi lại cỡ khúc lớn nhất mà không vượt bộ nhớ. Nếu không có cỡ khúc nào an toàn, quyết định của phase này là lưu vector đóng gói theo ngày trong R2 và phase 2, 6 đi theo nhánh đó.
9. Chạy toàn bộ probe trên bản deploy, ghi bảng kết quả và các quyết định kéo theo vào `reports/spike-results.md`: cấu hình placement cuối cùng và có dùng AI Gateway hay không; thư viện Leiden chính và dự phòng, có dùng CPM được không; cách lưu embedding (BLOB trong D1 hay file trong R2) kèm cỡ khúc; trạng thái từng nguồn từ IP của Workers.

## Todo

- [ ] Khung repo, workspaces, lockfile, `ignore-scripts`, test mẫu xanh
- [ ] Tài nguyên Cloudflare tạo xong và khai báo trong `wrangler.jsonc`
- [ ] Access app, `access-auth.ts`, `request-guard.ts` và test
- [ ] Endpoint probe với danh sách target cố định
- [ ] Deploy đầu tiên sau khi có xác thực; kiểm tra không còn hostname hở
- [ ] Đo lỗi vị trí Gemini trước và sau placement
- [ ] Test Leiden trong `workerd`: tất định, CPM có trọng số
- [ ] Test bộ nhớ khi nạp BLOB từ D1
- [ ] `spike-results.md` có bảng kết quả và quyết định

## Success Criteria

- `npm run typecheck` và `npm test` xanh ở cả ba workspace.
- Không hostname nào không được bảo vệ phân giải tới Worker; request không có JWT hợp lệ bị từ chối ở tầng code cho cả API lẫn static assets, kiểm chứng bằng curl.
- `spike-results.md` trả lời dứt khoát: tỉ lệ lỗi vị trí Gemini sau placement; thư viện Leiden được chọn kèm bằng chứng tất định và hành vi CPM trên graph có trọng số; cách lưu embedding kèm cỡ khúc an toàn; trạng thái từng nguồn từ IP của Workers.

## Risk Assessment

- Placement không loại bỏ hết lỗi vị trí. Tín hiệu: probe vẫn lỗi sau khi đặt vùng. Phản ứng: thêm AI Gateway; nếu vẫn lỗi thì phase 4 coi lỗi vị trí là lỗi tạm có ngắt mạch, và báo người dùng vì thông lượng sẽ giảm.
- Không thư viện Leiden nào tất định hoặc CPM không dùng được với trọng số. Phản ứng đã định: nếu chỉ CPM hỏng thì dùng modularity với `resolution` và dựa vào trọng số IDF để xử lý entity phổ biến; nếu cả hai thư viện hỏng thì phase 5 tự viết Leiden tối giản, thêm 2 đến 4 ngày, dùng fixture tham chiếu của `leiden-ts` làm oracle.
- FxTwitter chặn IP Workers. Phản ứng: dừng và báo người dùng, vì nguồn X là trục chính; lối thoát là tự host FxEmbed trên Worker riêng.

## Security Considerations

- Probe chỉ nhận tên target trong danh sách trắng và không trả nội dung upstream.
- API key Gemini đặt bằng `wrangler secret put`, không bao giờ ghi vào file hay log.
- Email của chủ sở hữu là biến `OWNER_EMAIL` đặt trên dashboard hoặc bằng `wrangler secret put`, không nằm trong repo.
- Rủi ro chuỗi cung ứng từ các gói ít người dùng được giảm bằng lockfile, phiên bản chính xác và tắt script cài đặt; việc nâng phiên bản các gói này phải kèm đọc diff.

## Next Steps

Phase 2 dùng khung repo này; phase 3, 4, 5, 6 đọc `spike-results.md` để chọn nhánh.
