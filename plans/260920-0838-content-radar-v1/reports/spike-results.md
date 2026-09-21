# Kết quả spike phase 1

Ngày đo: 2026-09-20. Môi trường local: Node 24.18, Wrangler 4.135.0, `workerd` qua `@cloudflare/vitest-plugin` 1.1.13, Vitest 4.1.11.

Trạng thái: các mục chạy local đã có kết quả dứt khoát. Các mục cần bản deploy thật **chưa đo được**, vì thiếu custom domain, ứng dụng Access và `GEMINI_API_KEY` do người dùng cung cấp. Không con số nào dưới đây là ước đoán thay cho phép đo còn thiếu.

## Bảng quyết định

| Câu hỏi | Trạng thái | Quyết định |
|---|---|---|
| Thư viện Leiden chính và dự phòng | Đã đo, sửa ở phase 5 | Chính: `ngraph.leiden` 0.3.0 với CPM và **tắt refinement**, cộng bước tách thành phần không liên thông. Dự phòng: `leiden-ts` 0.1.0 (modularity). |
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

### Bổ sung ở phase 5: pha refinement của `ngraph.leiden` làm giảm chất lượng

Spike ban đầu chỉ kiểm tra số cộng đồng của `ngraph.leiden`, chưa kiểm tra chất lượng phân hoạch. Khi phase 5 đo trên mạng tham chiếu và fixture có trọng số, kết quả như sau (seed 42):

| Phép đo | `ngraph.leiden` mặc định | `ngraph.leiden` với `refine: false` | `leiden-ts` (modularity) |
|---|---|---|---|
| Modularity karate club (tối ưu đã biết 0,4198) | 0,364; từ 0,364 đến 0,397 qua 5 seed | 0,415 | 0,4188 |
| Năm câu chuyện chung một entity phổ biến | Không gamma nào khôi phục đủ 5 | 5/5 ở gamma 0,25 | 5/5 ở resolution 1 |
| Dữ liệu thưa: đợt bùng nổ 300 claim, 12 cụm nhỏ, 70% cô lập | — | 11/13, không cụm nào lẫn câu chuyện (gamma 0,15 đến 0,25) | 11/13, không lẫn |

Các tuỳ chọn `candidateStrategy: "all"`, tăng `maxLocalPasses`, `maxLevels` và `allowNewCommunity` không cải thiện gì; chỉ việc tắt refinement là có tác dụng. Hai cụm không khôi phục được ở cả hai thư viện là do đợt bùng nổ 300 claim có dạng dải dài nên bị chia khúc, không phải do gộp nhầm.

Quyết định: giữ CPM vì nó không có giới hạn phân giải, điều quan trọng khi cửa sổ có hàng nghìn claim mà câu chuyện chỉ 2 đến 3 claim; chạy `ngraph.leiden` với `refine: false` và gamma mặc định 0,25. Cái giá phải nêu rõ: không có refinement thì thuật toán thực chất là Louvain và mất bảo đảm cộng đồng liên thông của Leiden. Bảo đảm đó được khôi phục bằng bước `splitDisconnected`, có test chứng minh mọi cộng đồng trả về đều liên thông. `leiden-ts` vẫn là phương án dự phòng sau interface `Clusterer` nếu dữ liệu thật cho thấy CPM không phù hợp.

### Bổ sung ở phase 6: CPM cắt vụn đợt bùng nổ lớn, cần bước gộp theo độ mạnh liên kết

Test tải 3.500 claim cho thấy một đợt bùng nổ 300 claim gần giống nhau bị CPM cắt thành khoảng 59 mảnh, mảnh lớn nhất 11 claim. Nguyên nhân là hai quyết định của plan tương tác với nhau: trần `maxNeighboursPerClaim = 30` làm đồ thị bên trong đợt bùng nổ thưa đi (mật độ khoảng 0,08), còn CPM giữ cụm theo ngưỡng mật độ gamma. Không gamma nào giải được cả hai phía:

| Cấu hình | Đợt bùng nổ kNN 300 claim + 40 cụm nhỏ | 5 câu chuyện dính một entity phổ biến |
|---|---|---|
| CPM gamma từ 0,02 đến 0,06 | 41/41 đúng | sụp thành 1 cụm |
| CPM gamma 0,25 | vỡ thành 87 mảnh | 5/5 đúng |
| Modularity | gộp lẫn 9 cụm, chỉ 6/41 đúng (giới hạn phân giải) | 5/5 đúng |
| CPM gamma 0,25 cộng `mergeLinkedFragments` | 41/41 đúng, cụm 300 nguyên vẹn | 5/5 đúng |

Mật độ không phân biệt được "thưa vì bị trần láng giềng" với "thưa vì không liên quan", nhưng độ mạnh của cạnh thì phân biệt được: cạnh giữa các mảnh của cùng một đợt bùng nổ mạnh ngang cạnh bên trong mảnh, còn cạnh keo dính do entity phổ biến chỉ vừa qua ngưỡng tối thiểu. Quy tắc gộp: hai cộng đồng nhập làm một khi số cạnh giữa chúng không ít hơn cỡ của cộng đồng nhỏ hơn, và trọng số trung bình của các cạnh đó đạt từ 90% trọng số trung bình bên trong của cộng đồng yếu hơn. Claim lẻ không bao giờ bị kéo vào. Kết quả trên fixture thưa cũng tốt lên, từ 11/13 lên 12/13, không lần nào gộp lẫn câu chuyện.

Số đo của test tải sau khi sửa (local, `workerd`): 5,9 giây cho toàn bộ job trên 3.500 claim, 6.851 cạnh cosine (trần cho phép 105.000), 41 câu chuyện, cụm lớn nhất 300. Bộ nhớ đỉnh không đo được ở local vì `workerd` local không áp trần và không lộ số đo; phase 9 theo dõi trên Worker thật.

## Gemini thật: lần gọi đầu tiên (2026-09-21, từ máy dev, không phải từ Workers)

Đo bằng key free tier của chủ tài khoản, với đúng prompt và `responseJsonSchema` của bước bóc claim, trên ba bài X công khai lấy từ fixture timeline.

| Câu hỏi | Kết quả |
|---|---|
| Key có thấy ba model của chuỗi không | Có: `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, ngữ cảnh 1.048.576 token, đầu ra 65.536 |
| Gemini có chấp nhận schema bóc claim không (rủi ro plan đã nêu) | Có, HTTP 200 trên `gemini-3.6-flash`; đầu ra qua được schema zod của hệ thống, mỗi item một mục theo `itemId` |
| `quote` có truy nguyên được không | Có: claim duy nhất trả về khớp nguyên văn với bài gốc qua `quoteFoundIn`; hai bài không liên quan được đánh `relevant = false` |
| Lỗi vị trí | Không gặp từ máy dev. **Chưa nói lên điều gì về IP của Workers**; vẫn phải đo bằng probe sau khi deploy |
| Độ ổn định của free tier | Trong khoảng 15 phút: 5 trên 8 lời gọi trả `503 UNAVAILABLE` ("high demand"), lần lượt trên cả ba model |
| Độ trễ và token | 3 bài ngắn: 20,7 giây, 648 token vào, 199 token ra, **1.912 thinking token** |

Hệ quả đã xử lý: một model trả 5xx giờ chỉ bị bỏ qua cho đúng lời gọi đó và chuỗi rơi xuống model kế tiếp; trước đó mọi 5xx làm cả lô phải retry và năm lần liên tiếp sẽ mở ngắt mạch cho mọi model. Prompt được bổ sung chỉ dẫn không liệt kê chính tác giả bài viết làm entity, vì phản hồi thật đã làm đúng điều đó và nó sẽ dính mọi claim của cùng một tác giả vào nhau.

### Lần chạy pipeline thật đầu tiên ở local (2026-09-21)

Poll 11 nguồn thật (4 tài khoản X, 2 truy vấn HN, 3 feed, 2 repo GitHub): cả 11 thành công, 257 item, 186 item qua bộ lọc rẻ. Bóc claim bằng Gemini thật, embedding bằng Workers AI thật.

| Phép đo | Kết quả |
|---|---|
| Hạn mức free tier thật | **20 request mỗi ngày mỗi model**, tính theo project. Google nêu trong thân 429: `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `quotaValue: 20` |
| 503 có bị tính vào quota không | Rất có thể có: `gemini-3.6-flash` nhận 25 request, chỉ 10 được trả lời, và hết quota ngày. Suy luận từ số đếm, không phải khẳng định của Google |
| Độ trễ lô đủ 10 item | 7 đến 33 giây qua 7 lô; timeout 60 giây của client còn dư |
| Chất lượng trích dẫn | 9 lời gọi thành công, 50 claim; 1 claim bị loại vì quote dài quá 300 ký tự, **0 claim bị loại vì `quote_not_found`** |
| Tỉ lệ 503 | 42 trên 54 lời gọi của pipeline |
| Item bị `failed` hoặc mất | 0; 100 item nằm lại ở `queued` chờ quota |
| Job cluster với Workers AI thật | 2,7 giây: 21 claim trong cửa sổ, 84 entity, 10 mention mơ hồ chuyển phân xử, 2 cạnh cosine (0,554 đến 0,608), 1 câu chuyện |

Ba lỗi thiết kế chỉ dữ liệu thật mới lộ ra, đều đã sửa kèm test: mọi 429 bị coi là hết quota ngày, trong khi một trong ba cái là giới hạn theo phút (model đó trả lời lại sau vài giây nhưng vẫn bị đỗ tới nửa đêm Pacific); 503 được hoàn chỗ trong sổ dù Google có vẻ vẫn tính; và mỗi lô gặp quá tải gõ lần lượt cả ba model rồi retry, đốt ba request cho mỗi lần thử. Mức an toàn mặc định 100 RPD của plan cao gấp 5 lần thực tế và đã được thay bằng 20.

Sau khi sửa, tick rút backlog kế tiếp chỉ tốn đúng 2 request: cả hai trả 429 loại theo ngày, hệ thống tự ghi `rpd = 20` cho cả ba model, đỗ chúng tới nửa đêm Pacific và nằm im. Không item nào `failed`; 103 item nằm lại `queued` trong D1.

Lần chạy cluster thứ hai trên 26 claim trong cửa sổ cho 2 câu chuyện, hiển thị đúng trên giao diện với headline dự phòng và nhãn "chưa tổng hợp" (quota Gemini hết trước lượt tổng hợp): "Gemini" là `READY` với 2 nguồn độc lập (hai người dùng HN khác nhau) và giữ nguyên `story_id` qua hai lần chạy (sự kiện `continue`); bản phát hành Ollama là `LEAD` vì hai claim cùng một tác giả.

Số đo cần cho việc hiệu chỉnh ở tuần chạy thử: với `bge-m3` trên claim thật, cosine của các cặp liên quan nằm trong khoảng 0,55 đến 0,66 (trung bình 0,60 trên 7 cạnh). Với `wCos = 0,6` và `minEdgeWeight = 0,45`, riêng cosine cần đạt 0,75 mới thành cạnh, mức chưa từng quan sát được. Tức hiện tại **mọi cạnh đều cần có entity chung**; hai claim cùng nói một chuyện nhưng gọi tên khác nhau sẽ không nối được. Mẫu 26 claim quá nhỏ để đổi tham số, nhưng đây là điều đầu tiên cần xem khi có dữ liệu một tuần.

Hệ quả cho sản phẩm: 60 request mỗi ngày nhân 10 item mỗi lô là tối đa khoảng 480 item bóc claim mỗi ngày (phần dành cho bóc claim là 80%), chưa trừ các lần 503. Với 119 nguồn, bộ lọc rẻ và thứ tự ưu tiên nguồn sẽ quyết định radar thấy được gì; đây là giới hạn của ràng buộc 0 USD và cần được theo dõi trong tuần chạy thử.

Còn mở: độ trễ của một lô đủ 10 item đã đo được (xem bảng trên), nên mục này đóng. Phần dưới giữ lại để ghi nhận bối cảnh của phép đo đầu tiên: độ trễ của một lô đủ 10 item chưa đo được vì cả chuỗi đang 503 ở lần thử. Với 20 giây cho 3 bài, một lô 10 bài có thể chạm timeout 60 giây của client; nếu phép đo xác nhận, hướng xử lý là hạ mức thinking của model cho bước bóc claim hoặc giảm cỡ lô. Fixture `extract-recorded-gemini-3.6-flash.json` và `overloaded-503-recorded.json` là bản ghi thật; `rate-limited-429.json` và `location-blocked-400.json` vẫn là bản dựng theo hợp đồng REST vì không tạo ra được theo ý muốn.

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
