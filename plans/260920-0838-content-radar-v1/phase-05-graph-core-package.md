---
title: "Phase 5: Gói lõi graph"
status: todo
priority: P1
effort: "4d"
dependencies: [1]
---

# Phase 5: Gói lõi graph

## Context Links

- [Graph và nguồn](./research/researcher-260920-0735-graph-leiden-and-sources.md), mục Q1 đến Q5
- `reports/spike-results.md` từ phase 1 (thư viện Leiden được chọn, CPM có dùng được với trọng số không)

## Overview

`packages/core` là phần "coding Graph và Leiden" của hệ thống: các hàm thuần, tất định, không I/O, không phụ thuộc runtime của Workers, test bằng Vitest trên Node. Nó nhận dữ liệu thường (mảng claim, vector, cạnh cosine, snapshot trước) và trả kết quả thường. Phase 6 lo toàn bộ việc đọc ghi D1.

## Key Insights

- Node là claim, không phải entity. Graph đồng xuất hiện entity gộp nhầm các sự kiện khác nhau chỉ vì chung một entity lớn.
- Entity phổ biến như "OpenAI" dính mọi thứ thành một cụm khổng lồ. Hai biện pháp: trọng số IDF cho phần chồng lấn entity, và hàm chất lượng CPM vì CPM không có giới hạn phân giải toàn cục. Gamma của CPM là ngưỡng mật độ cùng đơn vị với trọng số cạnh, và cosine của bge-m3 trên văn bản kỹ thuật ngắn nằm trong một dải cao và hẹp, nên dải gamma dùng được cũng hẹp và phụ thuộc dữ liệu: phải quét nhiều giá trị chứ không chốt một số từ fixture đẹp.
- Phần cosine của cạnh bất biến theo embedding nên lưu được; phần entity thay đổi theo IDF của cửa sổ và theo kết quả gộp entity, nên phải tính lại mỗi lần chạy. Tách hai phần này ra thì không có cạnh nào bị "đóng băng" theo trạng thái cũ.
- Bài đăng ngắn cho graph thưa: phần lớn claim là node cô lập. Không có cỡ cụm tối thiểu thì radar thành trình đọc RSS.
- So Jaccard trên toàn bộ thành viên làm câu chuyện dài ngày "chết" giả khi loạt claim đầu tiên ra khỏi cửa sổ cùng lúc. Chỉ so trên phần claim còn nằm trong cửa sổ hiện tại.
- "Nguồn độc lập" phải được định nghĩa chặt, nếu không một thông báo được sáu người nhắc lại sẽ thành sáu nguồn và cổng `READY` mất nghĩa.

## Requirements

- [x] Mọi hàm thuần và tất định: cùng đầu vào và cùng seed cho cùng đầu ra, kể cả thứ tự phần tử trong kết quả.
- [x] Không import API của Node hay Workers; chạy được trong cả hai môi trường.
- [x] Thư viện Leiden nằm sau một interface để đổi thư viện chỉ chạm một file.
- [x] `params.ts` là chủ sở hữu duy nhất của mọi tham số thuật toán: tên, kiểu, giá trị mặc định, `PARAMS_VERSION`. Hàm `resolveParams(overrides)` hợp nhất giá trị ghi đè từ bảng `settings` và kiểm tra hợp lệ; không hàm nào trong gói tự lấy mặc định ngầm.

## Architecture

```
packages/core/src/
  params.ts                 tham số, mặc định, PARAMS_VERSION, resolveParams
  text/normalize-entity.ts  chuẩn hoá chuỗi entity
  entities/resolve-mention.ts   quyết định theo thang: alias, embedding, vùng mơ hồ
  vector/cosine.ts          cosine trên Float32Array, topK chính xác, centroid
  graph/cosine-neighbours.ts    láng giềng cosine top-k cho claim mới
  graph/entity-idf.ts       IDF của entity trong cửa sổ
  graph/weighted-edges.ts   dựng cạnh có trọng số cho một lần chạy
  clustering/clusterer.ts   interface Clusterer
  clustering/leiden-clusterer.ts   adapter cho thư viện mà phase 1 đã chọn
  clustering/resolution-sweep.ts   quét gamma, đo độ ổn định số cộng đồng
  lineage/match-communities.ts  khớp Jaccard, hồi sinh, phát sinh sự kiện
  lineage/entity-signature.ts   chữ ký entity của một cộng đồng
  relations/derive-relations.ts xác định claim dẫn xuất từ claim nào
  scoring/independence.ts   đếm nguồn độc lập
  scoring/robust-z.ts       median, MAD, robust z, chuẩn hoá theo tuổi bài
  scoring/score-story.ts    sáu điểm thành phần và điểm tổng
  scoring/fallback-headline.ts  headline tất định khi chưa có bản của LLM
  index.ts
```

Tham số trong `params.ts` (giá trị khởi đầu; bước quét ở Implementation Steps chốt `resolution`):

| Nhóm | Tham số |
|---|---|
| Cửa sổ | `windowDays = 7` |
| Cạnh | `cosineFloor = 0.55`, `maxNeighboursPerClaim = 30`, `wCos = 0.6`, `wEnt = 0.4`, `minEdgeWeight = 0.45`, `hubEntityShare = 0.15` |
| Cụm | `quality = "cpm"`, `resolution` (từ bước quét), `seed = 42`, `minCommunitySize = 2`, `singletonMinVelocityZ = 3` |
| Lineage | `jaccardContinue = 0.5`, `jaccardRelated = 0.3`, `lookbackHours = 24`, `reviveHorizonDays = 30`, `reviveSignatureJaccard = 0.5` |
| Entity | `aliasAutoAccept = 0.92`, `aliasAutoReject = 0.75` |
| Điểm | trọng số `0.30 / 0.20 / 0.15 / 0.10 / 0.15 / 0.10`, `recencyHalfLifeHours = 48`, `velocityMinBaseline = 10`, `velocityMinAgeHours = 3` |

Hợp đồng chính:

- `resolveMention(normalized, aliasHit, nearest, params)` trả `{ action: "alias" | "new" | "adjudicate", entityId? }`: trúng alias thì dùng ngay; cosine từ `aliasAutoAccept` trở lên thì thêm alias; dưới `aliasAutoReject` thì tạo entity mới; khoảng giữa thì chuyển cho Gemini phân xử. Tên có dấu hiệu phiên bản khác nhau ("v4" so với "v4.1") không bao giờ tự động gộp dù cosine cao, mà luôn đi đường phân xử để giữ quan hệ `version_of`.
- `cosineNeighbours(newClaims, windowVectors, params)` trả tối đa `maxNeighboursPerClaim` láng giềng có cosine từ `cosineFloor` trở lên cho mỗi claim mới; hai claim của cùng một item không nối nhau. Đây là phần được lưu vào `claim_edges`.
- `weightedEdges(claims, cosineEdges, entityIdsByClaim, stopEntities, params)` dựng cạnh cho một lần chạy: ứng viên là các cạnh cosine đã lưu cộng các cặp chung ít nhất một entity không nằm trong danh sách stop và không phải entity trục (xuất hiện ở hơn `hubEntityShare` số claim của cửa sổ); `weight = wCos * cosine + wEnt * idfOverlap`; giữ cạnh có `weight >= minEdgeWeight` và hai claim cách nhau không quá `windowDays`. Vì phần entity tính tại chỗ từ trạng thái gộp entity hiện tại, một phán quyết gộp entity có hiệu lực ngay ở lần chạy kế tiếp.
- `Clusterer.cluster(nodes, edges, { seed, resolution, quality })` trả `{ communities, singletons }`; chỉ số cộng đồng được đánh lại theo claim ID nhỏ nhất trong cộng đồng; đầu vào được sắp theo ID trước khi đưa vào thư viện. Cộng đồng nhỏ hơn `minCommunitySize` bị trả về dạng `singletons`.
- `promoteSingletons(singletons, velocityZByClaim, params)` giữ lại claim lẻ có robust z từ `singletonMinVelocityZ` trở lên làm cộng đồng một thành viên, theo quyết định của người dùng: bài lẻ chỉ thành lead khi engagement bất thường so với chính tác giả.
- `matchCommunities(current, previousSnapshots, deadStories, windowClaimIds, params)`: thành viên của snapshot cũ được thu hẹp về `windowClaimIds` trước khi tính Jaccard. Quy tắc: từ `jaccardContinue` và là cặp tốt nhất của nhau thì `continue`; một cũ khớp nhiều mới từ `jaccardRelated` thì `split`, con lớn nhất giữ `storyId`; nhiều cũ khớp một mới từ `jaccardRelated` thì `merge`, thừa hưởng `storyId` của cha lớn nhất; không khớp với cộng đồng sống nào thì so chữ ký entity với các câu chuyện đã chết trong `reviveHorizonDays`, đạt `reviveSignatureJaccard` thì `revive` đúng `storyId` cũ, không thì `birth`; cộng đồng cũ không có khớp trong quá `lookbackHours` thì `death`. Chỉ so các cặp có chung ít nhất một thành viên.
- `deriveRelations(claims, items, itemLinks)` trả `derivedFromClaimId` và lý do cho từng claim: claim của một bài `quote` hoặc `repost` dẫn xuất từ claim của bài gốc, trừ khi claim đó là `first_hand` (tự đo, tự trải nghiệm); các claim loại `report` hoặc `announcement` mà item của chúng cùng trỏ về một `canonical_url` thì dẫn xuất từ claim sớm nhất của URL đó. Bình luận HN không phải dẫn xuất của story vì đó là tiếng nói độc lập.
- `countIndependentSources(claims)`: số cặp (tác giả chuẩn, gốc dẫn xuất) phân biệt, trong đó tác giả chuẩn là `author_id` sau khi các handle đã được nối vào cùng một tác giả ở phase 2 và 3.
- `scoreStory(input, params)` trả `{ score, subscores }` với `score = 100 * clip(0.30*S_sources + 0.20*S_velocity + 0.15*S_specificity + 0.10*S_counter + 0.15*S_novelty + 0.10*S_recency)`. `S_sources = min(1, log2(1+n)/log2(6))`. `S_velocity` là sigmoid của robust z lớn nhất trong câu chuyện; engagement của bài dưới 24 giờ tuổi được chia cho `max(0.25, tuổi/24)` trước khi so với baseline đã chín của tác giả; bài dưới `velocityMinAgeHours` hoặc tác giả dưới `velocityMinBaseline` mẫu nhận 0.5. `S_specificity` là tỉ lệ claim có `has_numbers` hoặc `first_hand`, không phụ thuộc vai trò do LLM gán. `S_counter` là 1 khi đã có claim vai trò `counter`. `S_novelty = 1 - cosine lớn nhất` giữa centroid của câu chuyện và centroid của các câu chuyện sống khác trong cửa sổ, centroid do phase 6 tính trong bộ nhớ và truyền vào. `S_recency = exp(-ln2 * giờ / recencyHalfLifeHours)`.
- `fallbackHeadline(claims)` chọn `text_vi` của claim có độ cụ thể cao nhất, hoà thì lấy claim sớm nhất, để thẻ luôn có headline kể cả khi quota tổng hợp đã hết.

## Related Code Files

- Create: các file liệt kê ở mục Architecture trong `packages/core/src/`
- Create: `packages/core/test/**/*.test.ts` tương ứng từng module
- Create: `packages/core/test/fixtures/karate-club.json`, `football.json`, `synthetic-stories.json`, `sparse-social.json`, `lineage-scenarios.json`
- Modify: `packages/core/package.json` (thêm thư viện Leiden đã chọn với phiên bản chính xác, và `fast-check` cho dev)

## Implementation Steps

1. Viết `params.ts` với bảng tham số ở trên, `PARAMS_VERSION = 1` và `resolveParams`; test: ghi đè hợp lệ được áp dụng, khoá lạ hoặc giá trị ngoài khoảng bị từ chối.
2. Viết `normalize-entity.ts` (chữ thường, gỡ dấu và dấu câu, gộp khoảng trắng, giữ nguyên chuỗi phiên bản như "v4.1") và `resolve-mention.ts` kèm test bảng quyết định, có ca "deepseek v4 flash" so với "deepseek v4.1 flash" phải ra `adjudicate`.
3. Viết `cosine.ts`, `cosine-neighbours.ts`, `entity-idf.ts`, `weighted-edges.ts`. Test tính chất bằng `fast-check`: trọng số đối xứng, nằm trong khoảng 0 đến 1, không có cạnh ngoài cửa sổ, không node nào có quá `maxNeighboursPerClaim` cạnh cosine, và một cụm 300 claim gần giống nhau không sinh quá 300 nhân 30 cạnh.
4. Viết `clusterer.ts` và adapter cho thư viện đã chọn. Test: karate club và football cho modularity không thấp hơn giá trị tham chiếu quá 5%; hai mươi lần chạy cùng seed cho cùng một hash phân hoạch; đổi thứ tự cạnh đầu vào không đổi kết quả.
5. Dựng hai fixture có trọng số: `synthetic-stories.json` (năm câu chuyện chung một entity phổ biến) và `sparse-social.json` (mô phỏng dữ liệu thật: 70% claim cô lập, vài cụm nhỏ, một đợt bùng nổ 300 claim). Viết `resolution-sweep.ts` quét gamma trên cả hai, chọn `resolution` nằm giữa dải mà số cộng đồng ổn định, ghi giá trị và dải vào `params.ts`. Test: năm câu chuyện giả lập không bị gộp; dữ liệu thưa không sụp thành một cụm khổng lồ; claim cô lập ra `singletons` chứ không thành cộng đồng.
6. Viết `entity-signature.ts` và `match-communities.ts`; test trên `lineage-scenarios.json` gồm đủ sáu sự kiện, cộng ba ca: câu chuyện vắng mặt vài giờ rồi quay lại vẫn giữ `storyId`; 100 claim đầu cùng ra khỏi cửa sổ trong khi câu chuyện còn sống vẫn cho `continue`; câu chuyện đã chết 9 ngày rồi bùng lại được `revive` đúng `storyId`.
7. Viết `derive-relations.ts` và `independence.ts` với các ca: cùng tác giả trên hai nền tảng đếm một; chuỗi quote không có đo đạc riêng đếm một; quote có `first_hand` đếm thêm một; sáu bài cùng thuật lại một thông báo chung URL gốc đếm một; bình luận HN phản bác đếm là nguồn riêng.
8. Viết `robust-z.ts`, `score-story.ts`, `fallback-headline.ts`; test giá trị biên và tính đơn điệu: thêm một nguồn độc lập không bao giờ làm giảm điểm; câu chuyện mất nguồn thứ hai thì quay về dưới ngưỡng `READY`.
9. Xuất API qua `index.ts`, chạy `npm run build` và đảm bảo gói không kéo theo phụ thuộc Node.

## Todo

- [x] `params.ts` có phiên bản và `resolveParams`
- [x] Chuẩn hoá entity và thang quyết định gộp mention
- [x] Cosine, láng giềng top-k, IDF, cạnh có trọng số tính tại chỗ
- [x] Interface Clusterer và adapter Leiden, test tất định
- [x] Hai fixture có trọng số và bước quét gamma
- [x] Cỡ cụm tối thiểu và quy tắc nâng claim lẻ bất thường
- [x] Khớp lineage trên phần còn trong cửa sổ, có hồi sinh
- [x] Quan hệ dẫn xuất và đếm nguồn độc lập
- [x] Robust z, chấm điểm, headline dự phòng
- [x] Build sạch, không phụ thuộc runtime

## Success Criteria

- `npm test -w @radar/core` xanh, độ phủ dòng của `packages/core/src` từ 90% trở lên.
- Test tất định: 20 lần chạy liên tiếp trên cùng fixture cho cùng một hash phân hoạch.
- Trên `sparse-social.json`: không có cụm khổng lồ, claim cô lập không thành câu chuyện, đợt bùng nổ 300 claim không vượt trần số cạnh.
- Ba ca lineage khó (vắng mặt ngắn, vách cửa sổ, hồi sinh) đều giữ đúng `storyId`.
- Gói import được trong test `workerd` của `apps/worker` mà không lỗi.

## Risk Assessment

- CPM không dùng được với trọng số trong thư viện đã chọn (phase 1 phát hiện). Phản ứng: `quality = "modularity"` với `resolution` quét tương tự, dựa nhiều hơn vào IDF và `hubEntityShare`.
- Thư viện Leiden lộ lỗi trên graph thật. Tín hiệu: cộng đồng có thành phần không liên thông hoặc kết quả đổi giữa các lần chạy. Phản ứng: đổi adapter sang thư viện dự phòng; nếu cả hai hỏng thì tự viết Leiden tối giản sau cùng interface, thêm 2 đến 4 ngày ngoài ước tính của phase này.
- Dải gamma ổn định trên fixture không khớp dữ liệu thật. Phản ứng: phase 9 chạy lại `resolution-sweep` trên dữ liệu của tuần chạy thử và ghi đè qua `core_overrides`, không đổi code.

## Security Considerations

Gói này không có I/O, không chạm secret, không nhận dữ liệu ngoài kiểu đã khai báo.

## Next Steps

Phase 6 gọi các hàm này từ job theo giờ, ghi bộ tham số đã hợp nhất vào `cluster_runs.params_json`, và lưu kết quả vào D1.
