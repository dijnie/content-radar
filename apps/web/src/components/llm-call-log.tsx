import { OperatorAction } from "./operator-action";
import { useState } from "react";
import { useResource } from "../hooks/use-resource";

type Call = {
  id: number; at: number; kind: string; status: string; httpStatus: number | null; latencyMs: number | null;
  subjects: number | null; claimsAccepted: number | null; tokensIn: number | null; tokensOut: number | null;
  reason: string | null; retryable?: number;
};
type CallPage = { calls: Call[]; nextBefore: number | null; day?: string };
type LogFilter = "all" | "failed" | "active";

const kindLabels: Record<string, string> = {
  extract: "Trích xuất",
  extract_backfill: "Bổ sung dữ liệu",
  synthesize: "Tổng hợp câu chuyện",
  adjudicate: "Đối chiếu thực thể",
};
const reasonLabels: Record<string, string> = {
  llm_invalid_json: "Provider trả về nội dung không đọc được thành JSON",
  llm_invalid_response_json: "Phản hồi HTTP không phải JSON hợp lệ",
  llm_invalid_content_json: "Nội dung model trả về không phải JSON hợp lệ",
  llm_unexpected_content_type: "Provider trả về kiểu nội dung không hỗ trợ",
  llm_empty_response: "Provider trả về nội dung rỗng",
  llm_incomplete_response: "Phản hồi không hoàn tất",
  llm_output_limit: "Phản hồi vượt giới hạn đầu ra",
  TimeoutError: "Provider phản hồi quá thời gian",
  AbortError: "Lượt gọi đã bị dừng",
};
const statusLabels: Record<string, string> = {
  ok: "Hoàn tất",
  running: "Đang chạy",
  processing: "Đang ghi kết quả",
  stopped: "Đã dừng",
  no_final_result: "Chưa có kết quả cuối",
  invalid_output: "Đầu ra không hợp lệ",
  invalid_request: "Request không hợp lệ",
  configuration_error: "Lỗi cấu hình",
  rate_limited: "Provider giới hạn tốc độ",
  transient: "Lỗi tạm thời",
  failed: "Thất bại",
};
const kindLabel = (kind: string) => kindLabels[kind] ?? kind;
const subjectLabel = (kind: string) => kind === "synthesize"
  ? "câu chuyện"
  : kind === "adjudicate" ? "cặp thực thể" : "bài";
const statusLabel = (status: string) => statusLabels[status] ?? status.replaceAll("_", " ");
const reasonLabel = (reason: string | null) => reason ? (reasonLabels[reason] ?? reason.replaceAll("_", " ")) : null;
const isActive = (call: Call) => ["running", "processing"].includes(call.status);
const isFailed = (call: Call) => !["ok", "running", "processing", "stopped"].includes(call.status);

function CallRows({
  path,
  timeZone,
  filter,
  retryBlocked,
  onOlder,
  onNewer,
}: {
  path: string;
  timeZone: string;
  filter: LogFilter;
  retryBlocked: string;
  onOlder: (id: number) => void;
  onNewer: (() => void) | undefined;
}) {
  const { data, error, reload } = useResource<CallPage>(path, 5000);
  const time = new Intl.DateTimeFormat("vi-VN", {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const visible = data?.calls.filter((call) => filter === "all"
    || (filter === "active" ? isActive(call) : isFailed(call))) ?? [];

  return (
    <>
      {error && (
        <p role="alert" className="ai-log-error">
          Không tải được nhật ký. <button className="text-button" onClick={reload}>Thử lại</button>
        </p>
      )}
      {!data && !error && <p role="status">Đang tải nhật ký…</p>}
      {data && (
        visible.length ? (
          <ol className="ai-call-list" aria-label="Nhật ký lượt gọi AI">
            {visible.map((call) => {
              const reason = reasonLabel(call.reason);
              const active = isActive(call);
              const subject = call.subjects === null
                ? "—"
                : `${call.subjects} ${subjectLabel(call.kind)}`;
              const latency = call.latencyMs === null
                ? active ? "đang xử lý" : "chưa ghi nhận"
                : `${(call.latencyMs / 1000).toFixed(1)} giây`;
              const retryable = call.retryable === 1;

              return (
                <li key={call.id} className={`ai-call-row ai-call-row--${isFailed(call) ? "failed" : call.status}`}>
                  <div className="ai-call-head">
                    <span className="ai-call-kind">{kindLabel(call.kind)}</span>
                    <span className={`ai-call-state ai-call-state--${isFailed(call) ? "failed" : call.status}`}>
                      {statusLabel(call.status)}
                    </span>
                    <time dateTime={new Date(call.at * 1000).toISOString()}>
                      {time.format(call.at * 1000)}
                    </time>
                  </div>
                  <div className="ai-call-meta">
                    <span className="mono">#{call.id}</span>
                    <span>{subject}</span>
                    <span>{latency}</span>
                    <span>{call.httpStatus === null ? "chưa có HTTP" : `HTTP ${call.httpStatus}`}</span>
                    <span>{call.tokensIn ?? "—"} / {call.tokensOut ?? "—"} token</span>
                    {call.claimsAccepted !== null && <span>{call.claimsAccepted} thông tin được trích xuất</span>}
                  </div>
                  {reason && (
                    <p className="ai-call-reason">
                      <strong>Chi tiết</strong> {reason}
                    </p>
                  )}
                  <div className="ai-call-actions">
                    {call.status === "running" && (
                      <OperatorAction
                        label="Dừng lượt"
                        body={{ action: "stop_call", id: call.id }}
                        refresh={reload}
                      />
                    )}
                    {retryable && (
                      <OperatorAction
                        label="Thử lại lượt"
                        disabled={Boolean(retryBlocked)}
                        body={{ action: "retry", id: call.id }}
                        refresh={reload}
                      />
                    )}
                    {!active && call.status !== "ok" && call.retryable === 0 && (
                      <span className="ai-no-retry">Đã hết việc để thử lại</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="ai-log-empty">
            {filter === "all"
              ? "Chưa có lượt gọi trong ngày Pacific này."
              : filter === "failed"
                ? "Không có lỗi trong phạm vi đang xem."
                : "Không có lượt nào đang chạy."}
          </p>
        )
      )}
      <div className="ai-log-pages">
        {onNewer && <button className="text-button" onClick={onNewer}>Mới hơn</button>}
        {data?.nextBefore != null && (
          <button className="text-button" onClick={() => onOlder(data.nextBefore!)}>Cũ hơn</button>
        )}
      </div>
    </>
  );
}

export function LlmCallLog({ model, timeZone, retryBlocked }: { model: string; timeZone: string; retryBlocked: string }) {
  const [open, setOpen] = useState(true);
  const [filter, setFilter] = useState<LogFilter>("all");
  const [pages, setPages] = useState<number[]>([]);
  const params = new URLSearchParams({ model });
  if (filter !== "all") params.set("filter", filter);
  if (pages.length) params.set("before", String(pages.at(-1)));
  const path = `/api/status/llm-calls?${params}`;
  return (
    <details
      className="llm-call-log ai-log"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>Nhật ký hôm nay</span>
        <span className="ai-log-summary">{open ? "Thu gọn ▴" : "Mở nhật ký ▾"}</span>
      </summary>
      {open && (
        <>
          <div className="ai-log-toolbar">
            <label htmlFor={`log-filter-${model}`}>Lọc nhật ký</label>
            <select
              id={`log-filter-${model}`}
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value as LogFilter);
                setPages([]);
              }}
            >
              <option value="all">Tất cả lượt gọi</option>
              <option value="failed">Chỉ lượt lỗi</option>
              <option value="active">Đang chạy</option>
            </select>
            <span className="ai-log-scope">Múi giờ · {timeZone}</span>
          </div>
          {retryBlocked && <p className="ai-help">{retryBlocked}</p>}
          <CallRows
            key={path}
            path={path}
            timeZone={timeZone}
            filter={filter}
            retryBlocked={retryBlocked}
            onOlder={(id) => setPages([...pages, id])}
            onNewer={pages.length ? () => setPages(pages.slice(0, -1)) : undefined}
          />
        </>
      )}
    </details>
  );
}
