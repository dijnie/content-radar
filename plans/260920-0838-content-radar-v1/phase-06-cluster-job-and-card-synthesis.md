---
title: "Phase 6: Job cluster và tổng hợp thẻ"
status: todo
priority: P1
effort: "4d"
dependencies: [3, 4, 5]
---

# Phase 6: Job cluster và tổng hợp thẻ

## Context Links

- [Phase 4](./phase-04-llm-extraction-and-budget.md) (consumer `radar-llm`, dạng message, sổ ngân sách)
- [Phase 5](./phase-05-graph-core-package.md) (hợp đồng của `@radar/core`)
- [Nền tảng](./research/researcher-260920-0735-cloudflare-gemini-platform.md), mục 1 (giới hạn cron) và 8 (Workers AI)
- `reports/spike-results.md` từ phase 1 (cách lưu embedding và cỡ khúc an toàn)

## Overview

Cron theo giờ biến claim thô thành câu chuyện có điểm: gộp entity, embed claim, xác định quan hệ dẫn xuất, lưu láng giềng cosine, dựng cạnh có trọng số và chạy Leiden trên cửa sổ, khớp lineage, chấm điểm, rồi công bố kết quả trong một bước kết thúc duy nhất và xếp hàng tổng hợp headline cho các câu chuyện thay đổi đáng kể. Cron theo ngày lo baseline tác giả, tổng hợp theo ngày, dọn dữ liệu cũ và sửa các trạng thái dở dang.

## Key Insights

- Cron có khoảng cách từ một giờ trở lên được 15 phút CPU; bộ nhớ 128 MB là giới hạn thật. Cách nạp vector và cỡ khúc lấy từ phép đo của phase 1, không lấy từ ước tính kích thước đóng gói.
- Một lần chạy ghi dở trông giống hệt một cộng đồng bị co lại dưới con mắt của Jaccard. Vì vậy mọi thứ một lần chạy ghi ra đều gắn `run_id` và vô hình với người đọc cho tới khi `cluster_runs.status` lật sang `done` ở câu lệnh cuối cùng.
- Phần cosine của cạnh được lưu; phần entity tính lại mỗi lần chạy từ trạng thái gộp entity hiện tại. Nhờ đó phán quyết của Gemini về một entity mơ hồ có hiệu lực ngay ở lần chạy sau mà không cần sửa cạnh cũ.
- Vai trò `evidence`, `context`, `counter` và headline là việc ngôn ngữ, giao cho Gemini; cụm, lineage, số nguồn độc lập và điểm là code. Riêng `S_counter` dựa trên nhãn do Gemini gán, điều này được ghi rõ trong tài liệu.
- Quota tổng hợp rất nhỏ: với mức an toàn 3 model nhân 100 RPD và 20% dành riêng, mỗi ngày có khoảng 60 call cho cả `synthesize` lẫn `adjudicate`. Thẻ vì vậy không được phụ thuộc vào LLM để hiện ra: mọi câu chuyện có headline dự phòng tất định, và chỉ thay đổi đáng kể mới đáng một call.

## Requirements

- [x] Job theo giờ chia thành các bước có tên, ghi tiến độ vào `cluster_runs.stage`; bước nào cũng idempotent theo `run_id`.
- [x] Khoá chống chạy chồng là một lease nguyên tử trong `job_leases`, dài 75 phút, được gia hạn sau mỗi bước; lần chạy có lease hết hạn bị đánh dấu `failed`.
- [x] Các bước chỉ đọc snapshot của lần chạy có `status = 'done'`.
- [x] `story_claims` phản ánh thành viên hiện tại: claim mới được thêm, claim rời cụm bị đặt `active = 0`, vai trò của claim ở lại được giữ nguyên. Chấm điểm, đếm nguồn độc lập và giao diện chỉ dùng claim `active`.
- [x] Hai loại việc LLM mới đi qua consumer và sổ ngân sách của phase 4 theo đúng dạng message đã khai báo: `adjudicate` (phía gửi gom tối đa 20 cặp mỗi message) và `synthesize` (một câu chuyện mỗi message, mang `membersHash`).
- [x] Trạng thái người dùng gắn với `story_id` và sống qua `continue`, `split`, `merge`, `revive`.
- [x] Job theo ngày cập nhật `author_baselines`, `story_daily`, `entity_daily`, dọn dữ liệu quá hạn và sửa trạng thái dở dang.

## Architecture

Các bước của job theo giờ (`cluster/run-cluster-job.ts`):

0. `acquire_lease`: `INSERT INTO job_leases ... ON CONFLICT(name) DO UPDATE SET holder = ?, expires_at = ? WHERE expires_at < ?now RETURNING holder`. Không lấy được thì thoát. Lấy được thì đánh dấu `failed` mọi `cluster_runs` còn `running`, tạo lần chạy mới, hợp nhất tham số bằng `resolveParams(settings.core_overrides)` và ghi vào `params_json`.
1. `resolve_entities`: nạp alias và embedding của entity một lần; với mỗi `entity_mentions` chưa gộp: chuẩn hoá, tra alias, nếu trượt thì embed bằng Workers AI (gom lô 50 chuỗi) và gọi `resolveMention`. Kết quả `adjudicate`: nếu `entity_adjudications` đã có dòng cho `mention_normalized` thì dùng lại entity tạm của dòng đó; chưa có thì tạo một entity tạm (`provisional = 1`) và một dòng `pending`. Các dòng `pending` chưa được xếp hàng được gom 20 cái một message `adjudicate`.
2. `embed_claims`: embed `text_en` của claim chưa có vector.
3. `derive_relations`: gọi `deriveRelations` cho claim chưa xét, ghi `derived_from_claim_id` và `derivation_reason`.
4. `cosine_edges`: nạp vector trong cửa sổ theo cỡ khúc an toàn, giải mã vào một `Float32Array` gộp, gọi `cosineNeighbours` cho claim mới, upsert `claim_edges`.
5. `cluster`: tính IDF, gọi `weightedEdges`, `Clusterer.cluster`, rồi `promoteSingletons` với robust z tính từ `item_metrics` và `author_baselines`.
6. `lineage`: nạp các snapshot `done` trong `lookbackHours` và các câu chuyện chết trong `reviveHorizonDays`, gọi `matchCommunities`. Ghi `run_communities`, `run_members` gắn `run_id`.
7. `score`: tính centroid từng cộng đồng trong bộ nhớ, gọi `countIndependentSources` và `scoreStory` trên claim thuộc cộng đồng; xác định `label_entity_id` (entity có tổng IDF cao nhất), `entity_signature_json`, `members_hash`, `search_text`, và `headline_vi` dự phòng bằng `fallbackHeadline` khi câu chuyện chưa có headline của LLM.
8. `finalize`: ghi `lineage_events`, upsert `stories` (gồm `status`, `alive`, `died_at`), đồng bộ `story_claims` theo thành viên mới, tất cả theo khúc và idempotent; câu lệnh cuối cùng lật `cluster_runs.status = 'done'` và nhả lease. Nếu job chết trước câu lệnh đó, lần chạy sau bỏ qua toàn bộ snapshot này và tính lại từ snapshot `done` gần nhất.
9. `enqueue_synthesis`: chọn câu chuyện sống có điểm từ `synthesis_min_score` (30, thấp hơn điểm hiển thị 40 để câu chuyện có counter tiềm năng không bị kẹt dưới ngưỡng) và thay đổi đáng kể kể từ lần tổng hợp trước: chưa từng tổng hợp, hoặc số nguồn độc lập đổi, hoặc từ 30% thành viên là mới; cách lần tổng hợp trước ít nhất 6 giờ; `synthesis_attempts` cho cùng một `members_hash` chưa quá 3. Số lượng không vượt ngân sách dành riêng còn lại trong ngày; 70% suất theo điểm cao, 30% suất cho câu chuyện mới xuất hiện dưới 6 giờ để chuyện mới nổi không bị chuyện lớn chèn mất.

Việc `synthesize`: nạp claim `active` hiện tại của câu chuyện (không phải tập tại thời điểm xếp hàng), gửi `text_vi`, `quote`, tác giả, nền tảng, số liệu engagement rút gọn; nhận `{ headline_vi, roles: [{ claimId, role }], questions: [string] }`. Headline phải nêu người đưa ra nhận định và điều kiện giới hạn, theo văn phong của ảnh tham chiếu. Áp kết quả: vai trò chỉ ghi cho claim còn `active`, `claimId` lạ bị bỏ qua chứ không làm hỏng cả phản hồi; giữ 2 đến 5 câu hỏi kiểm chứng; cập nhật có điều kiện `stories` với `headline_source = 'llm'` và `synthesized_hash` bằng hash của đúng tập claim đã gửi đi, nên nếu thành viên đã đổi tiếp thì câu chuyện vẫn được coi là cần tổng hợp lại ở lần đủ điều kiện kế tiếp. Sau đó tính lại điểm vì `S_counter` có thể đổi.

Việc `adjudicate`: prompt nhận các cặp (mention, entity ứng viên) và trả `same | version_of | different`. `same`: chuyển mọi mention của entity tạm sang entity ứng viên, thêm alias bằng `INSERT OR IGNORE` (alias đã thuộc entity khác thì giữ nguyên chủ cũ), xoá entity tạm. `version_of`: entity tạm thành entity thật có `parent_entity_id` và một dòng `entity_relations`. `different`: entity tạm thành entity thật.

Job theo ngày (`maintenance/run-daily-maintenance.ts`): baseline tác giả từ tối đa 50 bài gần nhất đã đủ 24 giờ tuổi, gồm cả bài backfill vì số liệu của chúng đã chín; `story_daily` và `entity_daily` tính lại cho 16 ngày gần nhất theo `claims.published_at` để dữ liệu backfill lấp được lịch sử; xoá câu chuyện mồ côi (không thuộc lần chạy `done` nào và không có `user_actions`). Chính sách lưu giữ: `run_members` 14 ngày; `poll_log` và `llm_calls` 14 ngày; embedding và `claim_edges` của claim ra khỏi cửa sổ quá 30 ngày; `item_metrics` gộp còn một snapshot mỗi ngày sau 14 ngày. `lineage_events`, `story_daily`, `entity_daily`, `stories`, `claims`, `items` giữ vĩnh viễn.

## Related Code Files

- Create: `apps/worker/src/cluster/run-cluster-job.ts`, `job-lease.ts`, `resolve-entities-step.ts`, `embed-claims-step.ts`, `derive-relations-step.ts`, `cosine-edges-step.ts`, `cluster-step.ts`, `lineage-step.ts`, `score-step.ts`, `finalize-step.ts`, `enqueue-synthesis-step.ts`, `embedding-client.ts`, `vector-store.ts`
- Create: `apps/worker/src/llm/synthesize/synthesize-schema.ts`, `synthesize-prompt.ts`, `synthesize-story.ts`
- Create: `apps/worker/src/llm/adjudicate/adjudicate-schema.ts`, `adjudicate-prompt.ts`, `adjudicate-entities.ts`
- Create: `apps/worker/src/maintenance/run-daily-maintenance.ts`, `author-baselines.ts`, `daily-aggregates.ts`, `retention.ts`, `repair-stale-state.ts`
- Modify: `apps/worker/src/llm/llm-consumer.ts` (thêm hai nhánh `kind`), `apps/worker/src/index.ts` (nối cron theo giờ và theo ngày)
- Create: `apps/worker/test/cluster/*.test.ts`, `apps/worker/test/maintenance/*.test.ts`

## Implementation Steps

1. Viết `job-lease.ts` và test: hai lần xin lease đồng thời chỉ một bên được; lease hết hạn được bên mới lấy và lần chạy cũ bị đánh dấu `failed`.
2. Viết `vector-store.ts` theo cách lưu đã chốt ở phase 1 (ghi, nạp theo khúc vào mảng gộp, không giữ mảng dòng của D1) và `embedding-client.ts` gọi `env.AI.run("@cf/baai/bge-m3", ...)` theo lô, có retry, ghi số token đã embed.
3. Viết từng bước từ 1 đến 7, mỗi bước một file, nhận `runId`, tự bỏ qua phần việc đã xong và gia hạn lease khi kết thúc.
4. Viết `finalize-step.ts`: ghi theo khúc, câu lệnh lật trạng thái nằm cuối. Test bằng cách làm job chết giữa bước này: lần chạy sau không sinh `death` hay `birth` giả và mọi `user_state` còn nguyên.
5. Viết `enqueue-synthesis-step.ts` theo quy tắc chọn ở trên và test: câu chuyện có `synthesized_hash` bằng `members_hash` không được xếp hàng; câu chuyện đổi 10% thành viên không được xếp hàng; câu chuyện mới 2 giờ tuổi có suất dù điểm thấp hơn các chuyện lớn.
6. Viết `synthesize-story.ts` và `adjudicate-entities.ts` theo hợp đồng ở trên; headline và câu hỏi viết bằng tiếng Việt. Test: phản hồi chứa `claimId` đã rời cụm vẫn được áp dụng cho phần còn lại; phán quyết `same` làm hai claim vốn tách nhau vì entity tạm nhập cùng cộng đồng ở lần chạy kế tiếp.
7. Viết job theo ngày và `repair-stale-state.ts`.
8. Test tích hợp trong `workerd` với D1 local và Workers AI được thay bằng bản giả trả vector cố định theo nội dung (bản giả chỉ dùng trong test): nạp fixture 60 claim của năm câu chuyện cùng 100 claim cô lập, chạy job hai lần, khẳng định `story_id` không đổi, claim cô lập không thành câu chuyện, lần chạy thứ hai không embed lại.
9. Test lineage đầu cuối: thêm claim làm một câu chuyện tách đôi, khẳng định sự kiện `split` và trạng thái `saved` ở lại với cộng đồng con lớn nhất; cho nguồn thứ hai của một câu chuyện `READY` rời cửa sổ và khẳng định nó quay về `LEAD`.
10. Test tải: fixture 3.500 claim có một đợt bùng nổ 300 claim; ghi lại số cạnh, bộ nhớ đỉnh và thời gian CPU.

## Todo

- [x] Lease nguyên tử và xử lý lần chạy treo
- [x] Kho vector và client embedding
- [x] Bảy bước tính toán của job theo giờ
- [x] Bước `finalize` công bố nguyên khối và test chết giữa chừng
- [x] Quy tắc chọn câu chuyện để tổng hợp và test
- [x] Việc `synthesize` và `adjudicate`
- [x] Job theo ngày: baseline, tổng hợp theo ngày xuất bản, lưu giữ, sửa trạng thái dở
- [x] Test tích hợp hai lần chạy, test lineage đầu cuối, test tải

## Success Criteria

- Hai lần chạy job liên tiếp trên cùng dữ liệu cho cùng `members_hash` ở mọi câu chuyện và không phát sinh sự kiện lineage nào ngoài `continue`.
- Job chết ở bất kỳ bước nào không làm đổi `story_id` hay `user_state` của câu chuyện nào ở lần chạy sau.
- Trên fixture 3.500 claim: bộ nhớ đỉnh dưới 100 MB, số cạnh cosine không vượt 30 nhân số claim, thời gian CPU dưới 60 giây.
- Câu chuyện mới luôn có headline (dự phòng hoặc của LLM) ngay sau lần chạy đầu tiên chứa nó.
- Sau job theo ngày: không còn `run_members` cũ hơn 14 ngày, không còn `cluster_runs` ở trạng thái `running` quá hạn lease.

## Risk Assessment

- Nạp vector chậm hoặc tốn bộ nhớ hơn phép đo của phase 1 khi dữ liệu thật lớn dần. Tín hiệu: bước `cosine_edges` quá 2 phút hoặc bộ nhớ đỉnh vượt 100 MB trong log. Phản ứng: chuyển `vector-store.ts` sang file đóng gói theo ngày trong R2; các bước khác không đổi vì chỉ gọi qua module này.
- Nhu cầu tổng hợp vượt ngân sách dành riêng kéo dài. Tín hiệu: số câu chuyện hiển thị với `headline_source = 'fallback'` tăng đều. Phản ứng: nâng ngưỡng thay đổi đáng kể, nâng `synthesis_min_score`; mọi thứ là thiết lập.
- Workers AI vượt 10.000 neuron miễn phí mỗi ngày. Ước tính theo báo cáo nghiên cứu là vài trăm neuron mỗi ngày nên rủi ro thấp; job ghi số token đã embed để theo dõi.
- Gemini gán vai trò sai. Phản ứng: giao diện hiển thị đoạn trích nguyên văn cạnh mỗi dòng nên người dùng tự kiểm chứng; nút Dismiss là phản hồi được ghi lại.

## Security Considerations

- Prompt tổng hợp và phân xử chứa nội dung crawl: áp dụng cùng nguyên tắc với phase 4, đầu ra bị ràng buộc bởi schema và chỉ tham chiếu ID có sẵn.
- Job không bao giờ xoá `items`, `claims` hay `stories` có thao tác của người dùng; chính sách lưu giữ chỉ chạm dữ liệu dẫn xuất và log.

## Next Steps

Phase 7 đọc `stories` và `story_claims` có `active = 1`; phase 8 dựng view trên `lineage_events` của các lần chạy `done`, `story_daily`, `entity_daily`.
