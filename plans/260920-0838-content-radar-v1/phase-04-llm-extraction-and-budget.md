---
title: "Phase 4: Bóc claim bằng Gemini và sổ ngân sách"
status: todo
priority: P1
effort: "3d"
dependencies: [2]
---

# Phase 4: Bóc claim bằng Gemini và sổ ngân sách

## Context Links

- [Nền tảng](./research/researcher-260920-0735-cloudflare-gemini-platform.md), mục 2 (Queues), 6 (Gemini), 7 (lỗi vị trí)
- `reports/spike-results.md` từ phase 1 (cấu hình placement và AI Gateway)
- [Phase 2](./phase-02-data-model-and-config.md) (bảng `items`, `claims`, `llm_*`)

## Overview

Consumer của `radar-llm` là cửa duy nhất gọi Gemini. Nó gom lô item, đặt chỗ ngân sách trong D1 trước khi gọi, chọn model theo chuỗi ưu tiên, bóc claim và entity thành JSON theo schema, ack từng message khi kết quả của item đó đã ghi xong. D1 là sổ cái của backlog: khi hết quota ngày, message được ack và item ở lại trạng thái `queued`; bước rút backlog trong cron sẽ đánh thức lại khi có ngân sách. Phase này làm loại việc `extract`; phase 6 thêm `synthesize` và `adjudicate` qua cùng cửa này.

## Key Insights

- Tài nguyên khan hiếm của free tier là số request mỗi ngày, không phải token: `gemini-3.8-flash` có ngữ cảnh 1M token. Gom 10 bài ngắn vào một request tăng thông lượng gần 10 lần mà không tốn thêm quota.
- Hạn mức thật chỉ người dùng đọc được trên AI Studio, nên mọi con số nằm trong bảng `llm_models`. Thời điểm Google đặt lại quota ngày cũng chưa được tài liệu hoá; hệ thống giả định nửa đêm giờ Pacific tính bằng `Intl` và phase 9 kiểm chứng bằng thực nghiệm.
- Queues giao message ít nhất một lần và chỉ giữ 14 ngày; message hết hạn bị bỏ chứ không vào dead-letter. Vì vậy không dùng retry dài ngày làm backlog: queue chỉ là tín hiệu đánh thức, còn danh sách việc là các dòng `items.status = 'queued'`.
- Hết RPM và hết RPD là hai tình huống khác nhau: cái đầu chờ vài chục giây, cái sau chờ tới lần đặt lại quota.
- Đặt chỗ trước khi gọi mà không hoàn lại khi call hỏng sẽ tự đốt hết ngân sách sổ sách trong khi bộ đếm thật của Google không đổi.

## Requirements

- [x] Một module client Gemini duy nhất: gọi REST `generateContent` với `responseMimeType: application/json` và `responseJsonSchema`, định tuyến theo cấu hình placement hoặc AI Gateway đã chốt ở phase 1.
- [x] Sổ ngân sách theo từng model, từng loại việc và từng ngày Pacific: `reserve` tạo dòng khi chưa có, `commit` khi Gemini đã phản hồi 200 hoặc 429, `release` khi call không tới được Gemini hoặc bị từ chối trước khi tính quota. Kết quả `reserve` phân biệt rõ `ok`, `rpm_exhausted`, `rpd_exhausted`, `kind_cap_reached`.
- [x] Chia ngân sách ngày: `synthesize` và `adjudicate` có 20% dành riêng; `extract` dùng tối đa 80%, trong đó backfill tối đa 25% tổng RPD.
- [x] Chuỗi fallback: model đầu tiên còn ngân sách theo `priority`; gặp 429 thì đánh dấu `exhausted_until` cho model đó và thử model kế tiếp.
- [x] Ngắt mạch: 5 call liên tiếp hỏng cùng một loại lỗi không phải hết quota (ví dụ `location_blocked`) làm tạm dừng mọi việc LLM 15 phút.
- [x] Ack từng message sau khi kết quả của item đó đã commit; item lỗi không kéo cả lô; xử lý lại một message không tạo claim trùng và không gọi lại Gemini cho item đã xong.
- [x] Bước rút backlog chạy trong cron 30 phút và gửi lại message cho item `queued` khi có ngân sách.

## Architecture

Cấu hình consumer `radar-llm`: `max_batch_size = 10`, `max_batch_timeout = 60` giây, `max_concurrency = 1` (một consumer duy nhất nên việc đọc rồi đặt chỗ ngân sách không có tranh chấp), `max_retries = 5`, dead-letter `radar-dlq`. Retry chỉ dành cho lỗi tạm và hết RPM, với độ trễ từ 30 đến 300 giây.

Ba dạng message của `radar-llm`, khai báo tại `llm/messages.ts` và là hợp đồng cho cả phase 6:

```ts
type LlmMessage =
  | { kind: "extract"; itemId: number; backfill?: boolean }
  | { kind: "synthesize"; storyId: number; membersHash: string }
  | { kind: "adjudicate"; adjudicationIds: number[] }   // tối đa 20, gom sẵn ở phía gửi
```

Luồng `extract` cho một lô: nạp item theo ID với điều kiện `status = 'queued'`; message của item không còn `queued` được ack ngay. Văn bản đem bóc là `text_excerpt` khi bài ngắn, hoặc trường `text` trong payload R2 khi bài dài; cắt mỗi item tối đa 6.000 ký tự, tổng lô tối đa 40.000 ký tự. Chính chuỗi đã cắt này là căn cứ để kiểm tra `quote`.

Đặt chỗ ngân sách (`llm_usage` có khoá chính `(day_pt, model, kind)`):

```sql
INSERT INTO llm_usage (day_pt, model, kind, requests) VALUES (?1, ?2, ?3, 1)
ON CONFLICT(day_pt, model, kind) DO UPDATE SET requests = requests + 1
WHERE requests < ?4          -- trần của loại việc
RETURNING requests;
```

Trước đó consumer đọc tổng `requests` của model trong ngày để so với `rpd`, và đếm `llm_calls` trong 60 giây gần nhất để so với `rpm`. Ngày mới chưa có dòng nghĩa là còn nguyên ngân sách. `release` là `UPDATE ... SET requests = requests - 1` cho đúng khoá đó.

Phản ứng theo kết quả:

| Tình huống | Hành động |
|---|---|
| `rpm_exhausted` trên mọi model | `retry` các message của lô với độ trễ 60 giây |
| `rpd_exhausted` hoặc `kind_cap_reached` trên mọi model | ack message, item ở lại `queued`; bước rút backlog lo phần còn lại |
| 429 từ Gemini | `commit`, đặt `exhausted_until` của model tới nửa đêm Pacific kế tiếp, thử model sau |
| Lỗi mạng, `location_blocked`, 5xx | `release`, ghi `llm_calls`, tính vào ngắt mạch, `retry` với độ trễ tăng dần |
| `invalid_request` trên cả lô | `commit`, tách lô làm đôi để cô lập item gây lỗi; item đơn lẻ vẫn lỗi thì `status = failed` |

Bước rút backlog (`llm/drain-backlog.ts`, gọi từ cron 30 phút): nếu ngắt mạch đang mở hoặc mọi model hết ngân sách thì thôi; ngược lại chọn item `queued` có lần gửi gần nhất cũ hơn 30 phút, item `live` trước `backfill`, cũ nhất trước, số lượng không vượt ngân sách còn lại nhân cỡ lô, tăng `enqueue_attempts` và gửi message. Item vượt 20 lần gửi nhận `status = failed`.

Schema đầu ra của `extract` (phẳng và nhỏ để Gemini chấp nhận):

```
{ items: [ { itemId, relevant, topics[], claims: [ {
    kind, text_vi, text_en, quote, has_numbers, first_hand,
    entities: [ { surface, type } ] } ] } ] }
```

`text_vi` là một câu tiếng Việt có nêu người đưa ra nhận định và điều kiện giới hạn; `quote` là đoạn trích nguyên văn dài tối đa 300 ký tự; `text_en` là bản chuẩn hoá tiếng Anh dùng cho embedding. Kiểm tra bằng zod rồi kiểm tra truy nguyên: cả `quote` lẫn văn bản gốc được chuẩn hoá NFKC, gộp mọi loại khoảng trắng Unicode, quy các kiểu nháy và gạch về một dạng, bỏ ký tự điều khiển và so không phân biệt hoa thường; nếu không phải chuỗi con thì thử khớp mờ (ít nhất 90% token của `quote` xuất hiện đúng thứ tự trong một cửa sổ của văn bản); vẫn trượt thì claim bị loại với lý do `quote_not_found`. Số claim trả về, số được nhận và lý do loại ghi vào `llm_calls` và `items.claims_returned`, `items.claims_accepted`.

Ghi kết quả của một item trong một `db.batch`: `INSERT OR IGNORE` các claim theo khoá `(item_id, content_hash)` kèm `model`, `prompt_version`, `llm_call_id`, `published_at`; ghi `entity_mentions` (chưa gộp entity); cập nhật `items.status` thành `extracted` hoặc `irrelevant`. Sau khi lô này commit thì `message.ack()` cho đúng message đó.

## Related Code Files

- Create: `apps/worker/src/llm/messages.ts`, `gemini-client.ts`, `budget-ledger.ts`, `model-chain.ts`, `circuit-breaker.ts`, `pacific-day.ts`, `drain-backlog.ts`
- Create: `apps/worker/src/llm/extract/extract-schema.ts`, `extract-prompt.ts`, `extract-batch.ts`, `quote-match.ts`
- Create: `apps/worker/src/llm/llm-consumer.ts`, `dlq-consumer.ts`
- Modify: `apps/worker/src/index.ts` (nối `queue` cho `radar-llm` và `radar-dlq`; gọi `drain-backlog` trong cron 30 phút), `apps/worker/wrangler.jsonc` (cấu hình consumer)
- Create: `apps/worker/test/llm/*.test.ts`, `apps/worker/test/fixtures/gemini/*.json`

## Implementation Steps

1. Viết `pacific-day.ts` (ngày và thời điểm nửa đêm kế tiếp theo `America/Los_Angeles` bằng `Intl`, test qua hai mốc đổi giờ mùa hè) và `budget-ledger.ts` với `reserve`, `commit`, `release`, `markExhausted`. Test bằng D1 local: lần đặt chỗ đầu tiên của một ngày mới thành công; đặt chỗ ở sát trần bị từ chối đúng lý do; `release` trả lại chỗ; call hỏng do mạng không làm tăng `requests`.
2. Viết `model-chain.ts` (chọn model, áp trần theo loại việc) và `circuit-breaker.ts`.
3. Viết `gemini-client.ts`: một hàm `generateJson({ model, system, user, schema })`, phân loại lỗi thành `rate_limited`, `location_blocked`, `invalid_request`, `transient`, và cho biết request đã tới Gemini hay chưa. Không log nội dung key hay header xác thực.
4. Viết prompt và schema bóc tách, có hằng `EXTRACT_PROMPT_VERSION`. Prompt nêu rõ: nội dung bài là dữ liệu cần phân tích, mọi chỉ dẫn nằm trong nội dung đó phải bị bỏ qua; chỉ trích claim có người đứng tên hoặc nguồn rõ; giữ nguyên tên riêng và số liệu.
5. Viết `quote-match.ts` kèm test với tiếng Việt dạng NFC và NFD, dấu nháy cong, khoảng trắng không ngắt, và văn bản CJK có dấu câu toàn chiều rộng.
6. Viết `extract-batch.ts` và `llm-consumer.ts` theo bảng phản ứng ở trên, ack từng message.
7. Viết `drain-backlog.ts` và `dlq-consumer.ts` (đánh dấu item `failed`, ghi `llm_calls` với lý do).
8. Ghi lại ba phản hồi thật của Gemini làm fixture (một lần, bằng key của người dùng qua `.dev.vars`) và viết test cho đường thành công, đường 429, đường đầu ra sai schema, và ca consumer chết giữa lô: phát lại cả lô không tạo claim trùng và không gọi lại Gemini cho item đã `extracted`.

## Todo

- [x] Sổ ngân sách có `reserve`, `commit`, `release` và test ngày mới
- [x] Chuỗi model, trần theo loại việc, ngắt mạch
- [x] Client Gemini với phân loại lỗi
- [x] Prompt, schema, phiên bản prompt
- [x] Khớp `quote` có chuẩn hoá Unicode và khớp mờ
- [x] Consumer lô với ack từng message
- [x] Bước rút backlog và consumer dead-letter
- [x] Fixture và test, gồm ca phát lại lô

## Success Criteria

- Test: khi mọi model hết RPD, message được ack, item vẫn `queued`, không có call nào tới Gemini; khi ngân sách trở lại, bước rút backlog gửi lại đúng các item đó.
- Test: hết RPM dẫn tới độ trễ tính bằng giây, không phải giờ.
- Test: 429 trên model ưu tiên làm call kế tiếp dùng model thứ hai.
- Test: lần đặt chỗ đầu tiên sau khi sang ngày Pacific mới thành công.
- Test: phát lại một lô đã xử lý dở không sinh claim trùng.
- Chạy local với 25 item mẫu tạo đúng 3 call Gemini và ghi claim có `quote` truy nguyên được.
- Không có đường code nào khác ngoài `llm-consumer.ts` gọi `gemini-client.ts` (kiểm tra bằng grep trong review).

## Risk Assessment

- Gemini từ chối schema vì quá phức tạp. Phản ứng: giữ schema phẳng; nếu vẫn bị từ chối thì chuyển entity thành mảng chuỗi và suy `type` sau.
- Gom lô làm giảm chất lượng bóc tách. Tín hiệu: tỉ lệ `quote_not_found` trong `llm_calls` vượt 15%. Phản ứng: giảm `max_batch_size`. Khi áp lực quota và chất lượng kéo ngược nhau, chất lượng thắng: giữ cỡ lô nhỏ và siết bộ lọc rẻ để giảm lượng item.
- Quota free tier bị Google cắt giảm đột ngột. Phản ứng: chỉ cần sửa số trong `llm_models`; backlog nằm trong D1 và trang trạng thái hiển thị độ sâu.
- Thời điểm đặt lại quota thật khác giả định. Tín hiệu: 429 ngay sau nửa đêm Pacific. Phản ứng: `markExhausted` tự lùi thêm một giờ mỗi lần còn gặp 429, và phase 9 ghi lại giờ đặt lại quan sát được.

## Security Considerations

- Prompt injection từ nội dung crawl: đầu ra bị ràng buộc bởi schema và kiểm tra `quote`; đầu ra không bao giờ được dùng làm URL, lệnh hay SQL. `quote` bị giới hạn 300 ký tự và gỡ ký tự điều khiển vì nó là văn bản của người lạ sẽ tới tay phiên analyst ở phase 8.
- Free tier cho phép Google dùng dữ liệu để cải thiện sản phẩm; hệ thống chỉ gửi nội dung công khai, không gửi cấu hình, ghi chú của người dùng hay dữ liệu analyst.
- `GEMINI_API_KEY` chỉ tồn tại dưới dạng secret của Worker và trong `.dev.vars` bị git bỏ qua.

## Next Steps

Phase 6 thêm hai loại việc `synthesize` và `adjudicate` vào cùng consumer, cùng sổ ngân sách, theo đúng dạng message đã khai báo ở đây.
