# Brainstorm: Content Radar trên Cloudflare

Ngày: 2026-09-20. Trạng thái: contract đã được người dùng chốt, sẵn sàng chuyển sang lập plan.

Hệ thống tham chiếu là bài post của Viet Tran (facebook.com/viettranx) kèm một ảnh chụp giao diện. Bài post không công bố công thức điểm, schema D1 hay cách dựng cạnh graph, nên ba phần đó do dự án này tự thiết kế. Mục tiêu là giống về hành vi, không phải giống từng con số.

## Outcome

Một radar cá nhân tìm đề tài đáng viết và trả lời câu hỏi "Giới nghiên cứu và ứng dụng AI/Agent đang có gì thú vị, và đang dịch chuyển về hướng nào?". Pipeline crawl nguồn public, lọc theo chủ đề, dùng Gemini bóc claim cùng evidence, context và counter, dựng graph, chạy Leiden để gom thành từng "câu chuyện", chấm điểm rồi ghi vào D1. Một giao diện trên Pages hiển thị các thẻ lead. Claude/Codex truy vấn D1 qua wrangler để kiểm chứng giả định, phát hiện signal dị thường và trending.

## Constraints

- Chi phí LLM trong pipeline bằng 0$: chỉ dùng quota free của Gemini API, có chuỗi fallback giữa các model. Quota thực tế chỉ xem được trên dashboard AI Studio nên phải là cấu hình, kèm sổ ngân sách theo ngày trong D1.
- Hạ tầng là Cloudflare với Workers Paid 5$/tháng (người dùng đã chốt): Workers, Cron, Queues hoặc Workflows, D1, R2, Cache, Pages.
- Chỉ dùng nguồn public, không tài khoản, không token trả phí. Quy mô danh sách KOL không cố định; giới hạn duy nhất là mọi thứ phải miễn phí, nên thông lượng do quota Gemini và phép lịch sự với FxTwitter quyết định.
- Graph, Leiden và scoring là code TypeScript tất định, không giao cho LLM. Lõi này viết thành module thuần, không phụ thuộc runtime.
- Hệ thống một người dùng. Nội dung thẻ viết bằng tiếng Việt như hệ thống tham chiếu.

## Non-goals

- Không multi-user, không xác thực phức tạp, không realtime.
- Không crawl nguồn cần đăng nhập, không dùng API chính thức của X.
- Không để LLM làm clustering hay chấm điểm.
- Không tự động hoá tầng analyst: Claude/Codex do người dùng gọi tay.
- arXiv và HF Papers chưa nằm trong bản đầu (người dùng không chọn).

## Phạm vi bản đầu (người dùng đã chốt)

- Chủ đề: AI, System Design, Backend. Danh sách chủ đề là cấu hình.
- Nguồn: X theo KOL, Reddit, Hacker News, blog của các lab và công ty, GitHub.

## Spec sản phẩm suy ra từ ảnh chụp

- Mỗi thẻ là một lead gắn với một entity, có điểm 0–100 với một chữ số thập phân.
- Trạng thái `LEAD` khi có 1 nguồn độc lập, `READY` khi có từ 2 nguồn độc lập trở lên.
- Headline là một nhận định tổng hợp, luôn nêu người đưa ra và điều kiện giới hạn.
- Các dòng bên dưới thuộc ba loại: `EVIDENCE`, `CONTEXT`, `COUNTER`. Thẻ có counter mang nhãn `counterpoint`.
- Chân thẻ ghi số nguồn độc lập và số câu hỏi cần kiểm chứng; các câu hỏi này là đầu việc cho tầng analyst.
- Thao tác: Link, Save, Dismiss, Written. Tab: Ready·Lead, Saved, Dismissed. Lọc theo chủ đề, tìm theo entity, tiêu đề hoặc ý tưởng, sắp xếp Newest hoặc Score.

## Acceptance criteria

1. Pipeline chạy không người trông 7 ngày liên tục; khi hết quota Gemini thì việc dồn vào backlog và không mất dữ liệu.
2. D1 chứa đủ: items, claims (loại evidence, context, counter, kèm URL và đoạn trích), entities cùng bảng alias, edges, communities, snapshot theo thời gian, lineage của community, trạng thái thẻ, `source_health`, sổ ngân sách LLM.
3. Leiden cho kết quả lặp lại được khi cố định seed; community được nối danh tính qua các lần chạy bằng độ chồng lấn.
4. Giao diện hiển thị đúng spec ở trên, bốn thao tác trên thẻ ghi được trạng thái vào D1.
5. Một phiên Claude trả lời được câu hỏi gốc bằng vài query qua wrangler, mọi nhận định dẫn về evidence URL, và ghi ngược được signal cùng giả thuyết vào D1.

## Trade-offs

| Hướng | Giả định sống còn | Hỏng đầu tiên khi |
|---|---|---|
| A. Toàn bộ trên Cloudflare, Workers Paid (đã chọn) | Chấp nhận 5$/tháng | Graph vượt 128 MB RAM, ở mức vài trăm nghìn cạnh |
| B. Workers Free lo ingest, job graph chạy ngoài | Chịu được hai nền tảng | Trần 10 ms CPU, 50 subrequest và 50 query D1 buộc chia lô mọi thứ |
| C. Leiden chạy trong phiên Claude/Codex | Phiên phân tích chạy đều đặn | Snapshot không đều làm chuỗi trending bị thủng |

Lõi graph viết bằng TypeScript thuần nên nếu sau này phải bỏ hướng A thì chuyển sang B không cần viết lại.

## Better approaches

Với nguồn X, mô tả ban đầu dùng RSS để lấy danh sách bài rồi gọi riêng từng bài để lấy số liệu, còn timeline API chỉ dùng cho backfill. Probe ngày 2026-09-20 cho thấy nên dùng timeline API `api.fxtwitter.com/2/profile/{handle}/statuses` làm đường chính: một call trả 20 bài mới nhất kèm like, repost, reply, view, bookmark, quote và cursor phân trang. Mỗi lần poll vì thế tự làm mới số liệu và cho sẵn chuỗi thời gian engagement để tính velocity. Chi phí chuyển đổi bằng không vì chưa có code.

Thứ tự fallback: timeline API, rồi RSS `fxtwitter.com/{handle}/feed.xml` để phát hiện bài mới, rồi FxTwitter JSON theo ID để lấy số liệu, cuối cùng là Syndication CDN.

## Kết quả probe và rủi ro

- Syndication CDN chỉ trả like và reply, không có view và repost, nên chỉ làm fallback một phần.
- `nitter.net` không kết nối được trong lần probe, chưa thể coi là fallback. FxTwitter vì vậy là điểm lỗi đơn của nguồn X; nếu bị siết thì lối thoát là API chính thức hoặc dịch vụ trung gian trả phí. Mỗi nguồn là một adapter riêng để việc đổi chỉ chạm một module.
- Nguồn X chỉ theo dõi theo tài khoản, không tìm theo từ khoá; Reddit, HN, blog và GitHub lấp khoảng trống đó.
- Danh tính community qua thời gian là rủi ro kỹ thuật lớn nhất: cần seed cố định, khớp community giữa các snapshot bằng Jaccard và lưu lineage (sinh, tách, gộp, chết), nếu không "trend" chỉ là nhiễu do chia cụm lại.
- Chuẩn hoá entity cần bảng alias, nếu không "MCP" và "Model Context Protocol" thành hai node và graph vỡ vụn.
- Điểm engagement phải chuẩn hoá theo baseline từng tác giả và dựa trên velocity, không dựa trên con số tuyệt đối.
- Lọc rẻ (quy tắc nguồn, từ khoá, bỏ reply và repost) phải chạy trước khi gọi Gemini vì quota free là tài nguyên khan hiếm nhất.
- `source_health` trong D1 giúp tầng analyst phân biệt nguồn hỏng với chủ đề nguội đi.

## Unresolved questions

1. Quota free thực tế (RPM, RPD) của các model Gemini trên dashboard AI Studio của người dùng, và thứ tự model trong chuỗi fallback "3.8 -> 3.6".
2. Reddit và Syndication CDN có chặn IP của Cloudflare Workers không; cần probe bằng một Worker thật ở phase đầu của plan.
3. Công thức điểm cụ thể (trọng số giữa số nguồn độc lập, velocity, độ cụ thể của evidence, counter, độ mới) cần được đề xuất trong plan và hiệu chỉnh bằng dữ liệu thật.
