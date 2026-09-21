# Content Radar: khôi phục Cloudflare Access

Ngày: 2026-09-21 UTC. Phạm vi: giữ xác thực Cloudflare Access theo quyết định mới nhất; chỉ chủ sở hữu được vào URL `workers.dev` hiện tại. Không triển khai email/mật khẩu riêng trong ứng dụng.

## Thực hiện

- Trước sửa: `/` trả 503 `access_not_configured`; Worker thiếu `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`, `APP_ORIGIN`. Zero Trust đã có tổ chức, identity provider mã email và reusable policy chỉ cho đúng một email; chưa có ứng dụng Access cho Content Radar.
- Tạo ứng dụng self-hosted `Content Radar` che toàn bộ hostname hiện tại, dùng identity provider và policy có sẵn, phiên 24 giờ. Policy được dùng chung với ứng dụng WARP trước đó; không sửa nội dung policy. Lớp kiểm tra `OWNER_EMAIL` trong Worker vẫn độc lập.
- Bổ sung bốn binding bằng API `PATCH /accounts/{account_id}/workers/scripts/content-radar/secrets-bulk`. Các secret Gemini/GitHub giữ nguyên. API kích hoạt version `5d46b4ae-6648-4039-a457-55e0e707b5b0` ở 100% lúc 08:06:43 UTC, deployment `f659cf46-0a89-4a3c-82d3-6b36b215f182`; đây là thay đổi secret trên code đang chạy, không phải deploy source HEAD.
- Route thực tế: `enabled: true`, `previews_enabled: false`. Đồng bộ repo thành `workers_dev: true`, giữ `preview_urls: false`; không thay đổi handler, dữ liệu D1, pipeline, tài khoản hay mật khẩu.
- Lookup: Cloudflare Zero Trust → Access applications → `Content Radar`; bindings tại Workers & Pages → `content-radar` → Settings → Variables and Secrets. Không ghi email cá nhân hay giá trị secret vào repo.

## Kiểm chứng

- `npm run test --workspace @radar/worker -- test/api/access-auth.test.ts test/api/routes-behind-auth.test.ts test/api/request-guard.test.ts`: **33/33** qua. Kiểm tra chữ ký JWT, issuer/audience/email, hạn token, từ chối khi thiếu cấu hình, toàn bộ bảng route và CSRF.
- `wrangler deploy --dry-run`: qua, 74 static assets, đủ sáu resource bindings, không upload code.
- Request giống trình duyệt tới `/`, `/api/status`, `/api/stories`, `/api/admin/probe?target=hn-algolia`, `/assets/index.js`: **302** sang miền team Access. Chưa đăng nhập nên probe không gọi dịch vụ nguồn.
- Request JSON không đăng nhập, gồm POST thao tác thẻ: **403** ở Access. Không thay đổi dữ liệu.
- Endpoint JWKS của team: **200**, hai signing keys.
- Ban đầu redirect tới màn hình Access 404 `Unable to find your Access application!`; người dùng cũng gặp. Không thay đổi thêm ứng dụng/policy: lần kiểm tra sau trả **200**, có `Log in to Content Radar`, ô email và `Send login code`. Khả năng do cấu hình chưa lan truyền là suy luận từ diễn biến, không phải chẩn đoán đã được Cloudflare xác nhận.
- Rà soát tại chỗ: Access che toàn hostname, chỉ một email; không policy Bypass/Everyone; production không bật dev bypass, không mở preview; không thay thế secret khác. Chưa có bằng chứng phiên đăng nhập hợp lệ truy cập Worker thật.

## Vận hành và hoàn tác

- Sau khi vừa tạo Access, kiểm tra cả redirect lẫn trang đăng nhập cuối. 302 riêng lẻ không chứng minh ứng dụng đăng nhập được.
- Giữ Access, binding xác thực và cấu hình origin khi deploy về sau. Nếu cần đóng URL khẩn cấp, tắt route `workers.dev`; không xoá Access khi route còn mở. Hoàn tác code không cần hoàn tác D1 hay bỏ xác thực.
- Tài liệu chính thức: [Access trên Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [mã đăng nhập email](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).

## Còn chờ

- Chủ sở hữu hoàn tất mã email, mở radar và System status; không yêu cầu gửi mã hoặc mật khẩu vào chat.
- Các tiêu chí production khác và tuần chạy thử vẫn theo plan gốc; thay đổi Access không hoàn tất những tiêu chí đó.
