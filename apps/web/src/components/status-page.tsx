import { OperatorAction, OperatorLock } from "./operator-action";
import { useEffect, useMemo, useState } from "react";
import { useResource } from "../hooks/use-resource";
import { LlmCallLog } from "./llm-call-log";
import { formatTime } from "./story-card";
import "./ai-operations.css";

interface SourceRow {
  id: number;
  type: string;
  label: string;
  collection: string | null;
  enabled: number;
  lastOkAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  itemsLastPoll: number;
}
interface ModelRow {
  model: string;
  rpd: number | null;
  rpm: number | null;
  limitsAreDefaults: boolean;
  exhaustedUntil: number | null;
}
interface UsageRow {
  model: string;
  kind: string;
  requests: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
}
interface ActiveCall {
  id: number;
  model: string;
  kind: string;
  subjects: number | null;
  at: number;
  status: string;
}
interface ActiveResponse { now: number; activeCalls: ActiveCall[] }
interface RunRow {
  id: number;
  startedAt: number;
  status: string;
  stage: string | null;
  claims: number | null;
  communities: number | null;
  error: string | null;
}
interface BacklogRow {
  ingestMode: string;
  queued: number;
  oldestQueuedAt: number | null;
  maxAttempts: number;
}
interface Status {
  itemsByStatus: { status: string; n: number }[];
  now: number;
  pacificDay: string;
  timezone?: string;
  sources: SourceRow[];
  backlog: BacklogRow[];
  llm: {
    paused: boolean;
    unlimited: boolean;
    models: ModelRow[];
    usageToday: UsageRow[];
    circuitOpenUntil: number | null;
    activeCalls?: ActiveCall[];
  };
  clusterRuns: RunRow[];
  cards: {
    alive: number;
    fallbackHeadlines: number | null;
    ready: number | null;
    lead: number | null;
  };
}

const number = new Intl.NumberFormat("vi-VN");
const kindLabels: Record<string, string> = {
  extract: "Trích xuất",
  extract_backfill: "Bổ sung dữ liệu",
  synthesize: "Tổng hợp câu chuyện",
  adjudicate: "Đối chiếu thực thể",
};
const kindLabel = (kind: string) => kindLabels[kind] ?? kind;
const subjectLabel = (kind: string) => kind === "synthesize"
  ? "câu chuyện"
  : kind === "adjudicate" ? "cặp thực thể" : "bài";
export const ago = (now: number, at: number | null) => {
  if (at === null) return "chưa có";
  const elapsed = Math.max(0, now - at);
  if (elapsed < 60) return "vừa xong";
  if (elapsed < 3600) return `${Math.max(1, Math.round(elapsed / 60))} phút trước`;
  if (elapsed < 86_400) return `${Math.round(elapsed / 3600)} giờ trước`;
  return `${Math.round(elapsed / 86_400)} ngày trước`;
};

function queueStatus(status: Status, queued: number, active: ActiveCall[], timeZone: string, waitUntil: number) {
  if (!status.llm.models.length) {
    return {
      label: "Chưa cấu hình",
      tone: "neutral",
      detail: "Mở Settings để chọn provider và model.",
    };
  }
  if (status.llm.paused) {
    return {
      label: "Đang tạm dừng",
      tone: "paused",
      detail: "Hàng chờ vẫn được giữ nguyên. Tiếp tục AI để chạy tiếp.",
    };
  }
  if (waitUntil > status.now) {
    return {
      label: "Đang chờ thử lại",
      tone: "warning",
      detail: `Có thể thử lại sau ${formatTime(waitUntil, timeZone)}.`,
    };
  }
  if (active.length) {
    return {
      label: `${active.length} lượt đang chạy`,
      tone: "active",
      detail: "Kết quả sẽ xuất hiện trong nhật ký sau khi provider trả lời.",
    };
  }
  if (queued) {
    return {
      label: "Đang chờ xử lý",
      tone: "waiting",
      detail: `Lịch kiểm tra tiếp theo lúc ${new Intl.DateTimeFormat("vi-VN", { timeZone, hour: "2-digit", minute: "2-digit" }).format((Math.floor(status.now / 1800) + 1) * 1800000)}. Bạn có thể chạy sớm hơn.`,
    };
  }
  return {
    label: "Sẵn sàng",
    tone: "ready",
    detail: "Không còn bài chờ trong hàng AI.",
  };
}

export function StatusPage({ timeZone = "Asia/Ho_Chi_Minh" }: { timeZone?: string }) {
  const { data: status, error, reload } = useResource<Status>("/api/status", 15000);
  const { data: liveStatus, reload: reloadLive } = useResource<ActiveResponse>("/api/status/llm-active", 2500);
  const [collection, setCollection] = useState("");
  const [runLimit, setRunLimit] = useState(10);
  const [selectedModel, setSelectedModel] = useState("");
  useEffect(() => {
    if (status?.llm.models.length && !status.llm.models.some((model) => model.model === selectedModel)) {
      setSelectedModel(status.llm.models[0]!.model);
    }
  }, [selectedModel, status?.llm.models]);
  const queued = useMemo(() => status?.backlog.reduce((sum, row) => sum + row.queued, 0) ?? 0, [status?.backlog]);
  if (error && !status) return <p className="notice notice--error" role="alert">Không tải được trạng thái hệ thống. <button className="text-button" onClick={reload}>Thử lại</button></p>;
  if (!status) return <p className="notice" role="status">Đang tải trạng thái hệ thống…</p>;
  const displayTimeZone = status.timezone ?? timeZone;
  const active = liveStatus?.activeCalls ?? status.llm.activeCalls ?? [];
  const refreshAll = () => {
    reload();
    reloadLive();
  };
  const oldestQueuedAt = status.backlog
    .map((row) => row.oldestQueuedAt)
    .filter((at): at is number => at !== null)
    .reduce<number | null>((min, at) => min === null ? at : Math.min(min, at), null);
  const failing = status.sources.filter((source) => source.enabled === 1 && source.consecutiveFailures > 0);
  const counts = new Map(status.itemsByStatus.map((row) => [row.status, row.n]));
  const selected = selectedModel || status.llm.models[0]?.model || "";
  const waitUntil = Math.max(status.llm.circuitOpenUntil ?? 0, status.llm.models.find(model => model.model === selected)?.exhaustedUntil ?? 0);
  const state = queueStatus(status, queued, active, displayTimeZone, waitUntil);
  return (
    <div className="status-page ai-operations-page">
      {error && <p className="notice notice--error" role="status">Dữ liệu bên dưới là lần cập nhật gần nhất. <button className="text-button" onClick={refreshAll}>Tải lại</button></p>}
      <section className="ai-hero" aria-labelledby="ai-operations-title">
        <div className="ai-hero-head">
          <div>
            <h1 id="ai-operations-title">Điều khiển xử lý AI</h1>
            <p className="caption">Cập nhật {formatTime(status.now, displayTimeZone)} · Tự làm mới mỗi 15 giây</p>
          </div>
          <OperatorLock />
          <span className={`ai-status-badge ai-status-badge--${state.tone}`}>
            <span aria-hidden="true" />{state.label}
          </span>
        </div>
        <p className="ai-state-detail">{state.detail}</p>
        <div className="ai-metric-grid" aria-label="Tổng quan hàng đợi AI">
          <div className="ai-metric ai-metric--queue">
            <span className="ai-metric-label">Bài đang chờ</span>
            <strong>{number.format(queued)}</strong>
            <span>{oldestQueuedAt === null ? "hàng chờ trống" : `cũ nhất ${ago(status.now, oldestQueuedAt)}`}</span>
          </div>
          <div className="ai-metric">
            <span className="ai-metric-label">Đang xử lý</span>
            <strong>{number.format(active.length)}</strong>
            <span>{active.length ? active.map((call) => kindLabel(call.kind)).join(" · ") : "chưa có lượt đang chạy"}</span>
          </div>
          <div className="ai-metric">
            <span className="ai-metric-label">Đã trích xuất</span>
            <strong>{number.format(counts.get("extracted") ?? 0)}</strong>
            <span>{number.format(counts.get("irrelevant") ?? 0)} bài bị loại</span>
          </div>
        </div>
        <div className="ai-actions" aria-label="Điều khiển AI">
          <div className="ai-run-control">
            <label htmlFor="ai-run-limit">Số bài chạy ngay</label>
            <select
              id="ai-run-limit"
              value={runLimit}
              onChange={(event) => setRunLimit(Number(event.target.value))}
            >
              {[10, 50, 100, 500].map((limit) => (
                <option key={limit} value={limit}>{number.format(limit)} bài</option>
              ))}
            </select>
            {status.llm.models.length > 1 && (
              <select
                aria-label="Model xử lý"
                value={selected}
                onChange={(event) => setSelectedModel(event.target.value)}
              >
                {status.llm.models.map((model) => (
                  <option key={model.model} value={model.model}>{model.model}</option>
                ))}
              </select>
            )}
            <OperatorAction
              className="button button--primary"
              label={`Chạy ${number.format(runLimit)} bài`}
              body={{ action: "retry", model: selected, limit: runLimit }}
              refresh={refreshAll}
              disabled={!selected || status.llm.paused || queued === 0 || waitUntil > status.now}
            />
          </div>
          <OperatorAction
            label={status.llm.paused ? "Tiếp tục AI" : "Tạm dừng AI"}
            body={{ action: status.llm.paused ? "resume" : "pause" }}
            refresh={refreshAll}
          />
        </div>
        <p className="ai-help">Radar kiểm tra hàng chờ mỗi 30 phút. Mỗi lượt trích xuất xử lý tối đa 10 bài.</p>
      </section>

      {active.length > 0 ? (
        <section className="ai-live panel" aria-labelledby="ai-live-title">
          <div className="ai-section-head">
            <h2 id="ai-live-title">Đang xử lý</h2>
            <span className="ai-refresh-note">Tự cập nhật 2,5 giây · backlog cập nhật 15 giây</span>
          </div>
          <ul className="ai-active-list">
            {active.map((call) => (
              <li key={call.id} className="ai-active-row">
                <span className="ai-pulse" aria-hidden="true" />
                <div className="ai-active-copy">
                  <strong>{kindLabel(call.kind)}</strong>
                  <span>
                    {call.subjects
                      ? `${number.format(call.subjects)} ${subjectLabel(call.kind)}`
                      : "Một lượt xử lý"}
                    {call.status === "processing" ? " · đang ghi kết quả · bắt đầu " : " · bắt đầu "}
                    {ago(liveStatus?.now ?? status.now, call.at)}
                  </span>
                </div>
                {call.status === "running" && (
                  <OperatorAction
                    label="Dừng lượt"
                    body={{ action: "stop_call", id: call.id }}
                    refresh={refreshAll}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel ai-usage" aria-labelledby="ai-usage-title">
        <div className="ai-section-head">
          <h2 id="ai-usage-title">Nhật ký và lượt gọi AI</h2>
          <span className="ai-day-label">Ngày Pacific · {status.pacificDay}</span>
        </div>
        {status.llm.models.map((model) => {
          const used = status.llm.usageToday.filter((row) => row.model === model.model);
          const total = used.reduce((sum, row) => sum + row.requests, 0);
          const retryAfter = Math.max(status.llm.circuitOpenUntil ?? 0, model.exhaustedUntil ?? 0);
          return (
            <article className="ai-model-card" key={model.model}>
              <div className="ai-model-head">
                <div>
                  <span className="mono ai-model-name">{model.model}</span>
                  <p className="caption">
                    {status.llm.unlimited
                      ? "Không giới hạn ở cấp ứng dụng"
                      : `Giới hạn ${model.rpm ?? "provider"} lượt/phút · ${model.rpd ?? "provider"} lượt/ngày`}
                  </p>
                </div>
                <div className="ai-total">
                  <strong>{number.format(total)}</strong>
                  <span>lượt hôm nay</span>
                </div>
              </div>
              <div className="ai-usage-breakdown">
                {used.length
                  ? used.map((row) => (
                    <span key={row.kind}>
                      <b>{number.format(row.requests)}</b> {kindLabel(row.kind)}
                    </span>
                  ))
                  : <span>Chưa có lượt gọi trong ngày này</span>}
              </div>
              <LlmCallLog
                key={status.pacificDay}
                model={model.model}
                timeZone={displayTimeZone}
                retryBlocked={status.llm.paused ? "Tiếp tục AI để thử lại lượt lỗi." : retryAfter > status.now ? `Có thể thử lại sau ${formatTime(retryAfter, displayTimeZone)}.` : ""}
              />
            </article>
          );
        })}
        {!status.llm.models.length && (
          <div className="ai-empty-state">
            <strong>Chưa có model hoạt động</strong>
            <p>Vào Settings để cấu hình endpoint, model và API key.</p>
            <a className="button" href="?view=settings">Mở Settings</a>
          </div>
        )}
      </section>

      <section className="ai-secondary panel" aria-labelledby="pipeline-title">
        <div className="ai-section-head">
          <h2 id="pipeline-title">Kết quả hệ thống</h2>
          <a className="text-button" href="?view=jobs">Mở Jobs</a>
        </div>
        <dl className="facts ai-facts">
          <div>
            <dt>Provider</dt>
            <dd>
              {waitUntil > status.now
                ? `đang chờ đến ${formatTime(waitUntil, displayTimeZone)}`
                : "sẵn sàng"}
            </dd>
          </div>
          <div>
            <dt>Cards</dt>
            <dd>
              {number.format(status.cards.alive ?? 0)} đang hiển thị · {number.format(status.cards.ready ?? 0)} sẵn sàng · {number.format(status.cards.lead ?? 0)} nổi bật
            </dd>
          </div>
          <div>
            <dt>Nguồn</dt>
            <dd>
              {number.format(status.sources.filter((source) => source.enabled === 1).length)} bật · {number.format(failing.length)} lỗi
            </dd>
          </div>
        </dl>
      </section>

      <details className="ai-disclosure panel">
        <summary>
          <strong>Cluster runs</strong>
          <span className="ai-disclosure-hint">Mở để xem lịch sử</span>
        </summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Bắt đầu</th>
                <th>Trạng thái</th>
                <th>Claims</th>
                <th>Stories</th>
                <th>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {status.clusterRuns.length === 0 && (
                <tr><td colSpan={6}>Chưa có run.</td></tr>
              )}
              {status.clusterRuns.map((run) => (
                <tr key={run.id}>
                  <td className="mono">{run.id}</td>
                  <td>{ago(status.now, run.startedAt)}</td>
                  <td><span className={`state state--${run.status}`}>{run.status}</span></td>
                  <td>{run.claims ?? "–"}</td>
                  <td>{run.communities ?? "–"}</td>
                  <td>{run.error ?? run.stage ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="ai-disclosure panel">
        <summary>
          <strong>Nguồn dữ liệu</strong>
          <span className="ai-disclosure-hint">{number.format(status.sources.length)} nguồn · mở để xem</span>
        </summary>
        <div className="ai-source-filter">
          <label htmlFor="source-collection">Collection</label>
          <select id="source-collection" value={collection} onChange={(event) => setCollection(event.target.value)}>
            <option value="">Tất cả</option>
            {[...new Set(status.sources.map((source) => source.collection).filter((name) => name != null))]
              .sort()
              .map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Nguồn</th>
                <th>Collection</th>
                <th>Loại</th>
                <th>Thành công gần nhất</th>
                <th>Lỗi liên tiếp</th>
                <th>Bài mới</th>
                <th>Lỗi cuối</th>
              </tr>
            </thead>
            <tbody>
              {status.sources
                .filter((source) => !collection || source.collection === collection)
                .map((source) => (
                  <tr key={source.id} className={source.enabled === 1 ? "" : "row--disabled"}>
                    <td>{source.label}</td>
                    <td>{source.collection ?? "—"}</td>
                    <td className="mono">{source.type}</td>
                    <td>{ago(status.now, source.lastOkAt)}</td>
                    <td>
                      {source.consecutiveFailures > 0
                        ? <span className="state state--failed">{source.consecutiveFailures}</span>
                        : 0}
                    </td>
                    <td>{source.itemsLastPoll}</td>
                    <td>{source.lastError ?? ""}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
