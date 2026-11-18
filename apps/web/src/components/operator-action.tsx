import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, request } from "../api-client";

export function operatorAuthorization(password: string) {
  const bytes = new TextEncoder().encode(`settings:${password}`);
  return "Basic " + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
}

type Action = { label: string; path: string; body: object; refresh: () => void };
type Result = { status: string; sent?: number; until?: number; kind?: string };
type Session = { run: (action: Action) => void; busy: boolean; unlocked: boolean; lock: () => void };
const Context = createContext<Session | null>(null);

const messages: Record<string, string> = {
  paused: "Đã tạm dừng AI. Bài chờ được giữ lại.", stopped: "Đã dừng.",
  already_requested: "Yêu cầu này vừa được gửi. Nhật ký sẽ cập nhật khi AI bắt đầu.",
  no_eligible_items: "Hiện không có việc phù hợp để chạy. Các kết quả đã hoàn tất được giữ lại.",
  ai_paused: "AI đang tạm dừng. Hãy tiếp tục AI trước khi chạy.",
  call_not_retryable: "Lượt này đã xong hoặc vẫn đang xử lý.", model_changed: "Model đã đổi. Hãy làm mới trang.",
  ai_not_configured: "Cần bật và cấu hình model trong Settings.", job_already_finished: "Tác vụ này đã kết thúc.",
  call_already_finished: "Lượt AI này đã kết thúc.", password_not_configured: "Cần đặt PASSWORD cho Worker.",
  invalid_password: "Mật khẩu không đúng.", password_required: "Hãy nhập mật khẩu điều khiển.",
};

function receipt(result: Result, action: Action) {
  const resume = "action" in action.body && action.body.action === "resume" ? "Đã tiếp tục AI. " : "";
  if (result.status === "partially_queued") return `${resume}Đã chuyển ${result.sent} bài. Một phần chưa gửi được và vẫn đang chờ xử lý.`;
  if (result.status === "queued") {
    const unit = result.kind === "synthesize" ? "câu chuyện" : result.kind === "adjudicate" ? "cặp thực thể" : "bài";
    return `${resume}Đã xếp ${result.sent} ${unit} vào hàng đợi xử lý.`;
  }
  if (result.status === "cooldown") return resume + (result.until ? `Thử lại từ ${new Date(result.until * 1000).toLocaleTimeString("vi-VN")} (giờ thiết bị).` : "Hiện chưa có model sẵn sàng.");
  return resume + (messages[result.status] ?? "Đã nhận yêu cầu.");
}

export function OperatorSession({ children }: { children: ReactNode }) {
  const [authorization, setAuthorization] = useState("");
  const [intent, setIntent] = useState<Action | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!intent) return;
    const element = dialog.current;
    if (!element) return;
    if (!element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    input.current?.focus();
    return () => { if (element.open && typeof element.close === "function") element.close(); };
  }, [intent]);

  function dismiss() { if (!sending.current) { setIntent(null); setPassword(""); setError(""); } }
  async function perform(action: Action, auth: string) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await request<Result>(action.path, { method: "POST", body: JSON.stringify(action.body),
        headers: { "Content-Type": "application/json", Authorization: auth } });
      setAuthorization(auth); setPassword(""); setIntent(null);
      setNotice(action.label + " — " + receipt(response, action));
      action.refresh();
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : "";
      const message = messages[code] ?? (failure instanceof ApiError ? `Thao tác thất bại (HTTP ${failure.status}). Hãy thử lại.` : "Mất kết nối với Radar. Hãy thử lại.");
      if (code === "invalid_password" || code === "password_required") {
        setAuthorization(""); setPassword(""); setIntent(action); setError(message); input.current?.focus();
      } else {
        setIntent(null); setPassword(""); setError(message); action.refresh();
      }
    } finally { sending.current = false; setBusy(false); }
  }
  function run(action: Action) {
    if (sending.current || intent) return;
    setNotice(""); setError("");
    if (authorization) void perform(action, authorization);
    else setIntent(action);
  }
  return <Context.Provider value={{ run, busy, unlocked: Boolean(authorization), lock: () => { setAuthorization(""); setNotice("Đã khóa điều khiển."); setError(""); } }}>
    {children}
    {!intent && (notice || error) && <div className="operator-receipt" role={error ? "alert" : "status"}>
      <span>{error || notice}</span>
      <button type="button" aria-label="Đóng thông báo" onClick={() => { setNotice(""); setError(""); }}>×</button>
    </div>}
    {intent && <dialog ref={dialog} className="operator-dialog" aria-labelledby="operator-title" onCancel={event => { event.preventDefault(); dismiss(); }}>
      <form onSubmit={event => { event.preventDefault(); if (password) void perform(intent, operatorAuthorization(password)); }}>
        <h2 id="operator-title">{intent.label}</h2>
        <p>Nhập mật khẩu để thực hiện thao tác. Bạn có thể tiếp tục điều khiển đến khi khóa lại hoặc tải lại trang.</p>
        <label>Mật khẩu điều khiển<input ref={input} type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        {error && <p role="alert">{error}</p>}
        <div><button type="button" className="button" disabled={busy} onClick={dismiss}>Hủy</button>
          <button className="button button--primary" disabled={!password || busy}>{busy ? "Đang gửi…" : "Xác nhận"}</button></div>
      </form>
    </dialog>}
  </Context.Provider>;
}

export function OperatorLock() {
  const session = useContext(Context);
  return session?.unlocked ? <button className="text-button" type="button" disabled={session.busy} onClick={session.lock}>Khóa điều khiển</button> : null;
}

export function OperatorAction({ label, path = "/api/status/ai-control", body = {}, refresh, disabled, className = "button" }: {
  label: string; path?: string; body?: object; refresh: () => void; disabled?: boolean; className?: string;
}) {
  const session = useContext(Context);
  const actionLabel = "id" in body && typeof body.id === "number" ? `${label} #${body.id}` : label;
  return <button type="button" className={className} aria-label={actionLabel} disabled={disabled || session?.busy || !session}
    onClick={() => session?.run({ label: actionLabel, path, body, refresh })}>{label}</button>;
}
