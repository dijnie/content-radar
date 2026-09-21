# Kiến trúc

Tài liệu này giải thích hệ thống hoạt động thế nào và vì sao. Chi tiết schema nằm trong [`apps/worker/migrations/`](../apps/worker/migrations/), tham số thuật toán nằm trong [`packages/core/src/params.ts`](../packages/core/src/params.ts); tài liệu này không chép lại chúng.

## Luồng dữ liệu

```mermaid
flowchart TD
  subgraph "Cron */30"
    D[dispatch-polls] -->|radar-poll| P[poll-consumer]
    DR[drain-backlog]
  end
  P --> AD[adapter: x, hn, rss, github]
  AD --> R2[(R2: payload thô)]
  AD --> F[cheap-filter]
  F -->|items: queued hoặc filtered_out| D1[(D1)]
  F -->|radar-llm: extract| L[llm-consumer]
  DR -->|radar-llm: item queued còn tồn| L
  L -->|budgeted-call| G[AI Gateway: DeepSeek]
  L -->|claims, entity_mentions| D1
  subgraph "Cron 5 * * * *"
    C[run-cluster-job]
  end
  D1 --> C
  C -->|Workers AI bge-m3| E[embedding]
  C -->|stories, story_claims, lineage_events| D1
  C -->|radar-llm: synthesize, adjudicate| L
  subgraph "Cron 20 8 * * *"
    M[daily-maintenance]
  end
  M --> D1
  D1 --> API[API sau Access + CSRF] --> WEB[Giao diện thẻ lead]
  D1 --> AN[Phiên analyst qua token D1]
```

Một Worker duy nhất xử lý `fetch`, `scheduled` và `queue`, và phục vụ luôn bản build tĩnh của giao diện. Nhờ vậy chỉ có một lần deploy và một hostname để che bằng Access.

## D1 là sổ cái, queue chỉ là tín hiệu đánh thức

Queues giao message ít nhất một lần, chỉ giữ 14 ngày, và message hết hạn thì biến mất chứ không vào dead-letter. Vì vậy không công việc nào chỉ tồn tại trong queue:

- Item mới được ghi **cùng trạng thái cuối của nó** (`queued` kèm `queued_at`, hoặc `filtered_out` kèm lý do) trong một câu lệnh, rồi message mới được gửi. Consumer chết giữa chừng thì item vẫn nằm đó ở trạng thái `queued`.
- Ưu tiên bóc claim cho bài trong cửa sổ gom nhóm hiện tại (mặc định 7 ngày, cùng `core_overrides.windowDays` với cluster). Poll trực tiếp vẫn lưu bài cũ vào D1/R2 nhưng chỉ đánh thức ngay bài trong cửa sổ; bài cũ chờ lượt rút backlog. Backfill thủ công vẫn gửi message theo hợp đồng hiện có.
- Mỗi 30 phút `drain-backlog` gửi lại message cho các item `queued` có lần đánh thức gần nhất quá 30 phút, trong phạm vi ngân sách còn lại của ngày. Khi còn bất kỳ bài trong cửa sổ đang `queued`, chỉ nhóm này được gửi và xử lý, kể cả khi chúng đang chờ retry; message bài cũ có sẵn trong queue được ack để chờ trong D1, không tốn lượt AI hay retry. Khi nhóm mới hết, bài cũ tự được xử lý tiếp. Trong mỗi nhóm ưu tiên, item trực tiếp trước item backfill, cũ nhất trước. Nếu bài mới đến liên tục vượt khả năng AI thì bài cũ có thể chờ lâu; dữ liệu không bị xoá hay đổi chế độ ingest.
- Bộ đếm giới hạn 20 lần xử lý item chỉ tăng khi nhận được output hoặc request bị từ chối; chờ ngân sách, lỗi cấu hình, mạng, output trống/cắt và chờ bài mới không bị tính. Request/shape bị từ chối vẫn theo đường chia đôi lô để cô lập item lỗi.
- Message của item không còn `queued` được ack mà không gọi DeepSeek. Nhờ đó message giao trùng hay một lô bị phát lại đều vô hại; khoá `(item_id, content_hash)` chặn claim trùng.
- Một nguồn được "thuê" trong D1 (đẩy `next_poll_at` lên 15 phút) trước khi message poll được gửi, nên tick kế tiếp không gửi trùng và message mất thì nguồn tự đến hạn lại.

Lưu ý khi sửa code ghi dữ liệu: dùng `ON CONFLICT (...) DO NOTHING` trên đúng khoá, không dùng `INSERT OR IGNORE`. `OR IGNORE` của SQLite nuốt cả vi phạm `CHECK`, tức một claim sai định dạng sẽ biến mất trong im lặng.

## Ngân sách DeepSeek

`deepseek-flash` thực hiện cả bóc claim, tổng hợp và phân xử entity qua Chat Completions. Cấu hình production định tuyến qua Cloudflare AI Gateway qua binding `env.AI.run()` với key BYOK alias `default`; key upstream nằm trên Gateway, Worker không cần token Gateway. `AI_GATEWAY_ID` chọn gateway `gateway`; request gửi `deepseek/deepseek-flash` và lấy Response thô để giữ status/usage cho sổ. Gateway bật `byok_only`, mỗi request cũng đặt `cf-aig-no-wholesale` để không chuyển sang Unified Billing. Client tắt thinking, yêu cầu JSON object, giới hạn 8.192 token đầu ra và timeout 60 giây cả lúc đọc body. Prompt đưa schema cùng ví dụ JSON; code vẫn kiểm tra schema, ID và quote trước khi lưu. JSON mode không thay thế validation.

- `budgeted-call` đặt chỗ trong `llm_usage` trước mỗi lần gọi. Trần chủ sở hữu chọn là **100 request/ngày, 5 request/phút**, ghi rõ trong [`0009_deepseek_models.sql`](../apps/worker/migrations/0009_deepseek_models.sql). Đây là hạn mức ứng dụng để kiểm soát chi phí, không phải quota của DeepSeek. Chỉ một model được bật; không fallback về Gemini.
- Mỗi phản hồi HTTP tính một lượt vào trần ứng dụng, kể cả 429/5xx; không nhận được phản hồi thì hoàn chỗ. `tokens_in` và `tokens_out` ghi usage nhà cung cấp trả về. Số lượt gọi không phải trần USD; token của request mất kết nối có thể không quan sát được trong sổ.
- Sổ giữ ngày Pacific như trước; sang ngày mới tự tạo dòng mới. 80 lượt dành cho bóc claim, 20 lượt dùng chung cho tổng hợp/phân xử, không vay giữa hai phần. Backfill tối đa 25 lượt trong phần bóc claim. Mỗi lượt bóc claim gom tối đa 10 item.
- Hết trần theo phút thì chờ 60 giây; hết phần ngân sách ngày thì để việc trong D1. DeepSeek 429 chỉ cho model nghỉ ngắn: theo `Retry-After` trong khoảng 1–300 giây, mặc định 60 giây. Không suy ra quota ngày hoặc tự đổi `rpm`/`rpd` từ lỗi này. Gateway bị giới hạn một upstream attempt/request, bỏ cache và không tự fallback, để sổ ứng dụng vẫn kiểm soát retry.
- 5xx cho model nghỉ 3 phút. Lỗi mạng, JSON trống/hỏng hoặc output bị cắt được retry có giãn cách. Sau tối đa bốn retry ngắn, việc trở về D1 trước khi queue đưa vào dead-letter; bài vẫn `queued`.
- Thiếu key, 401/403/404 hoặc hết số dư (402) mở ngắt mạch 15 phút ngay, giữ nguyên bài chờ. Năm lỗi mạng/output liên tiếp cùng loại cũng mở ngắt mạch 15 phút. Sau khi sửa key hoặc nạp tiền, đợi hết ngắt mạch và cron rút backlog tiếp.
- Migration chỉ tắt model Gemini, không xoá usage, call, claim hoặc dấu vết model cũ; ngắt mạch của provider cũ được xoá khi chuyển sang DeepSeek.

Probe chẩn đoán `deepseek` ở `/api/admin/probe` là một lần gọi tay ngoài sổ tự động, vẫn phát sinh chi phí. Tài liệu nhà cung cấp: [JSON mode](https://api-docs.deepseek.com/guides/json_mode), [rate limit](https://api-docs.deepseek.com/quick_start/rate_limit).

## Claim phải truy nguyên được

Mỗi claim mang một `quote` nguyên văn dài tối đa 300 ký tự. Trước khi lưu, `quote` được so với đúng chuỗi văn bản đã gửi cho DeepSeek, sau khi chuẩn hoá NFKC, quy các kiểu nháy, gạch và khoảng trắng về một dạng. Nếu không khớp nguyên chuỗi thì thử khớp mờ: ít nhất 90% token xuất hiện đúng thứ tự trong một cửa sổ. Khớp mờ tha cho một từ bị rơi, nhưng **không bao giờ tha cho một con số bị đổi**: mọi token chứa chữ số phải khớp chính xác. Claim bị loại được đếm theo lý do trong `llm_calls.reject_reasons_json`.

Việc bóc claim không tất định, nên mỗi claim ghi `model` và `prompt_version` để truy vết. Tính tất định của hệ thống bắt đầu từ sau bước này.

## Từ claim tới câu chuyện

Node của graph là claim, không phải entity: graph đồng xuất hiện entity sẽ gộp nhầm các sự kiện khác nhau chỉ vì chung một entity lớn.

1. **Gộp entity** theo thang rẻ trước: khớp alias, rồi độ tương tự embedding, và chỉ vùng mơ hồ (cosine 0,75 đến 0,92) mới nhờ DeepSeek phân xử. Mention mơ hồ nhận ngay một entity tạm để claim của nó vẫn được phân cụm. Tên khác nhau ở dấu hiệu phiên bản ("V4" và "V4.1") không bao giờ tự động gộp.
2. **Cạnh.** Phần cosine (top 30 láng giềng, cosine từ 0,55) bất biến nên được lưu ở `claim_edges`. Phần entity (Jaccard có trọng số IDF, bỏ entity trong danh sách stop và entity trục xuất hiện ở hơn 15% claim) được tính lại **mỗi lần chạy** từ trạng thái gộp entity hiện tại, nên một phán quyết gộp entity có hiệu lực ngay ở lần chạy sau. `weight = 0,6 × cosine + 0,4 × overlap`, giữ cạnh từ 0,45.
3. **Phân cụm** bằng CPM với gamma 0,25 qua `ngraph.leiden`. Hai điều chỉnh đều đến từ phép đo, ghi ở [`spike-results.md`](../plans/260920-0838-content-radar-v1/reports/spike-results.md):
   - Thư viện chạy với `refine: false`, vì pha refinement của nó làm giảm chất lượng phân hoạch. Không có refinement thì đây thực chất là Louvain, nên bảo đảm "cộng đồng liên thông" được khôi phục bằng `splitDisconnected`.
   - CPM giữ cụm theo ngưỡng mật độ, còn trần láng giềng làm một đợt bùng nổ lớn thưa đi, nên CPM cắt một câu chuyện 300 claim thành hàng chục mảnh. `mergeLinkedFragments` nối lại các mảnh theo **độ mạnh liên kết**: cạnh giữa các mảnh của cùng một câu chuyện mạnh ngang cạnh bên trong, còn cạnh keo dính do entity phổ biến chỉ vừa qua ngưỡng.
4. **Cỡ cụm tối thiểu là 2.** Claim lẻ chỉ thành thẻ khi engagement của bài bất thường so với chính tác giả (robust z từ 3).

Thư viện phân cụm nằm sau interface `Clusterer`; thay thư viện chỉ chạm một file.

## Danh tính câu chuyện qua thời gian

`stories` vừa là lineage vừa là thẻ hiển thị, và trạng thái Saved, Dismissed, Written gắn vào `story_id`. Mỗi lần chạy, cộng đồng mới được khớp với **lần xuất hiện gần nhất của mọi câu chuyện còn sống** bằng Jaccard, tính trên phần thành viên **còn nằm trong cửa sổ**. Nếu so trên toàn bộ thành viên, một câu chuyện dài ngày sẽ "chết" giả khi loạt claim đầu tiên ra khỏi cửa sổ cùng lúc.

| Sự kiện | Điều kiện | Ai giữ `story_id` |
|---|---|---|
| `continue` | Jaccard từ 0,5 và là cặp tốt nhất của nhau | Giữ nguyên |
| `split` | Một cũ khớp nhiều mới từ 0,3 | Cụm con lớn nhất |
| `merge` | Nhiều cũ khớp một mới từ 0,3 | Cha lớn nhất; lựa chọn của người dùng trên cha bị nhập được chuyển sang nếu bên thừa kế còn ở inbox |
| `revive` | Không khớp ai đang sống, chữ ký entity khớp từ 0,5 với câu chuyện chết trong 30 ngày | Lấy lại id cũ |
| `birth` | Không thuộc các trường hợp trên | Id mới |
| `death` | Không có kế thừa và lần xuất hiện cuối đã quá 24 giờ | Không còn |

`lookbackHours` là thời gian ân hạn trước khi tuyên bố chết, không phải bộ lọc đầu vào: sau một sự cố dài hơn 24 giờ, các câu chuyện cũ vẫn được khớp hoặc được chôn, không bị bỏ sống cạnh một bản sao mới sinh.

### Công bố nguyên khối

Một lần chạy ghi dở trông giống hệt một cộng đồng bị co lại dưới con mắt của Jaccard, và API đọc thẳng bảng `stories`. Vì vậy công bố gồm hai pha. Pha dàn dựng ghi theo khúc vào các bảng gắn `run_id` mà không ai đọc (`run_communities`, `run_members`, `run_stories`, `run_retirements`, `lineage_events`); câu chuyện mới được chèn dưới dạng bản giữ chỗ vô hình (`alive = 0`) chỉ để lấy id. Pha công bố là **một** `db.batch` duy nhất, tức một transaction của D1: vài câu lệnh theo tập hợp chép dữ liệu đã dàn dựng sang `stories` và `story_claims`, cho các câu chuyện bị nhập hoặc đã chết nghỉ, lật `cluster_runs.status` sang `done` và nhả lease. Hoặc tất cả cùng hiện ra, hoặc không gì cả. Lưu ý khi sửa: `chunkedBatch` là nhiều transaction rời nhau, nên không được dùng nó cho bất cứ thứ gì người đọc nhìn thấy. Mọi truy vấn đọc lineage đều lọc theo lần chạy `done`.

Khoá chống chạy chồng là một lease lấy bằng một câu lệnh upsert có điều kiện, dài 75 phút, được kiểm tra trước và gia hạn sau mỗi bước theo đồng hồ thật. Ngay trước công bố, job kiểm tra lại lease; mọi câu lệnh công bố trong cùng transaction cũng kiểm tra chủ lease và trạng thái `running`. Nếu một job khác đã lấy lease, toàn bộ phần công bố không ghi gì, giữ nguyên thẻ và trạng thái người dùng đã công bố, đồng thời không xếp thêm việc tổng hợp. Thời điểm hoàn thành và heartbeat cuối lấy theo đồng hồ thật.

## Chấm điểm

```
score = 100 × clip(0,30·S_sources + 0,20·S_velocity + 0,15·S_specificity
                  + 0,10·S_counter + 0,15·S_novelty + 0,10·S_recency)
```

- **Nguồn độc lập** là số cặp (tác giả chuẩn, gốc dẫn xuất) phân biệt. Claim trong một bài quote hoặc repost dẫn xuất từ bài gốc, trừ khi nó là trải nghiệm hay đo đạc của chính người viết. Các bài `report` hoặc `announcement` cùng nói về một URL dẫn xuất từ bài sớm nhất. Chỉ **liên kết chính** của item được xét (item có đúng một liên kết ngoài), vì một bài blog thật có thể chứa hàng chục liên kết và việc cùng trích một trang không chứng minh gì. Bình luận Hacker News là tiếng nói độc lập. `READY` khi có từ 2 nguồn độc lập, ngược lại là `LEAD`.
- **Velocity** là robust z của engagement so với median và MAD của chính tác giả (50 bài gần nhất đã đủ 24 giờ tuổi). Bài dưới 24 giờ được quy về mức 24 giờ; bài dưới 3 giờ hoặc tác giả dưới 10 mẫu nhận giá trị trung tính 0,5.
- **Specificity** là tỉ lệ claim có số liệu hoặc là trải nghiệm trực tiếp, không phụ thuộc vai trò do LLM gán.
- **Counter** là 1 khi câu chuyện có claim vai trò `counter`. Đây là thành phần duy nhất của điểm dựa trên phán đoán của DeepSeek.
- **Novelty** là 1 trừ cosine lớn nhất giữa centroid của câu chuyện và centroid của các câu chuyện sống khác.
- **Recency** giảm một nửa sau mỗi 48 giờ.

Điểm không bao giờ giảm khi thêm một nguồn độc lập (có test tính chất). Mỗi thao tác của người dùng lưu lại điểm và điểm thành phần tại thời điểm đó, làm dữ liệu hiệu chỉnh trọng số về sau.

## LLM làm gì, code làm gì

| DeepSeek | Code tất định |
|---|---|
| Bóc claim, `text_vi`, `text_en`, `quote`, entity | Kiểm tra `quote` có trong văn bản gốc |
| Headline tiếng Việt, vai trò `evidence` / `context` / `counter`, câu hỏi kiểm chứng | Cạnh, cụm, lineage, quan hệ dẫn xuất, số nguồn độc lập, điểm |
| Phân xử entity mơ hồ | Khớp alias, ngưỡng tự nhận và tự loại, chặn gộp khác phiên bản |

Thẻ không phụ thuộc LLM để hiện ra: mọi câu chuyện có headline dự phòng tất định (claim cụ thể nhất, hoà thì lấy claim sớm nhất) cho tới khi DeepSeek tổng hợp, và giao diện đánh dấu "chưa tổng hợp". Một câu chuyện chỉ được tổng hợp lại khi thay đổi đáng kể: số nguồn độc lập đổi hoặc từ 30% thành viên là mới, và cách lần trước ít nhất 6 giờ.

Giới hạn của tính tất định: trên cùng tập claim, embedding và tham số đã lưu (`cluster_runs.params_json`), chạy lại với cùng seed cho cùng phân hoạch. Tập claim thì không tái lập được, vì việc bóc claim dùng LLM.

## Bảo mật

- **Mọi request, kể cả static assets, đi qua kiểm tra JWT của Cloudflare Access trong code** (`RS256`, `iss`, `aud`, `exp`, email chủ sở hữu; lỗi tải JWKS thì từ chối) rồi qua lớp chống CSRF (`Sec-Fetch-Site`, `Origin` khớp chính xác, `POST` phải là JSON). Mọi route API nằm trong một bảng route chỉ tới được sau hai lớp này; một test đi qua cả bảng bằng `fetch` thật của Worker. Theo lựa chọn ngày 2026-09-21, `workers_dev` bật với Access che toàn bộ hostname, preview URL tắt. Access dùng Cloudflare làm identity provider, chỉ thành viên account được xác thực, tự chuyển sang đăng nhập Cloudflare; policy và Worker tiếp tục giới hạn một chủ sở hữu. Không dùng mã email của Access hay tài khoản/mật khẩu do ứng dụng tự quản lý. Trạng thái deployment thực tế phải đối chiếu theo [hướng dẫn vận hành](operations.md).
- **SSRF.** URL từ nội dung crawl bị từ chối nếu là scheme lạ, có thông tin đăng nhập, địa chỉ nội bộ (loopback, RFC1918, link-local, CGNAT, mọi IPv6 literal), hostname không có dấu chấm, `*.workers.dev` hay chính hostname của Worker. Redirect được theo thủ công tối đa 3 bước và kiểm tra lại từng bước; header của người gọi (có thể mang token) chỉ gửi tới host đầu tiên. Body được đếm sau giải nén và huỷ tại trần, nên bom nén không gây hại. Worker không phân giải được DNS nên không chống được DNS rebinding.
- **Prompt injection.** Nội dung crawl tới DeepSeek trong thẻ dữ liệu, và đầu ra bị ràng buộc bởi schema, chỉ tham chiếu id do hệ thống cấp, và không bao giờ được dùng làm URL, lệnh hay SQL. Bình luận Hacker News được chọn theo thứ hạng của HN, không theo độ dài. Với phiên analyst, cơ chế thật là phạm vi của API token; xem [`analyst-runbook.md`](analyst-runbook.md).
- **Chuỗi cung ứng.** Mọi phiên bản được khoá chính xác, `package-lock.json` được commit, script cài đặt bị tắt. Các gói ít người dùng (`ngraph.leiden`) chỉ được nâng phiên bản kèm đọc diff.
