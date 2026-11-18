import { OperatorAction } from "./operator-action";
import { useState } from "react";
import { useResource } from "../hooks/use-resource";

type Call = {
  id: number; at: number; kind: string; status: string; httpStatus: number | null; latencyMs: number | null;
  subjects: number | null; claimsAccepted: number | null; tokensIn: number | null; tokensOut: number | null; reason: string | null;
};
type CallPage = { calls: Call[]; nextBefore: number | null };

function CallRows({ path, timeZone, onOlder, onNewer }: {
  path: string; timeZone: string; onOlder: (id: number) => void; onNewer: (() => void) | undefined;
}) {
  const { data, error, reload } = useResource<CallPage>(path, 5000);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return <>
    {error && <p role="alert">Could not refresh the call log. <button className="text-button" onClick={reload}>Retry</button></p>}
    {!data && !error && <p role="status">Loading calls…</p>}
    {data && (!data.calls.length ? <p>No calls recorded for this Pacific day.</p> : <div className="table-scroll">
      <table aria-label="AI calls">
        <thead><tr><th>Started ({timeZone})</th><th>Task</th><th>Result</th><th>Duration</th><th>Batch size</th><th>Claims accepted</th><th>Tokens in / out</th><th>Action</th></tr></thead>
        <tbody>{data.calls.map((call) => <tr key={call.id}>
          <td><time dateTime={new Date(call.at * 1000).toISOString()}>{time.format(call.at * 1000)}</time></td>
          <td>{call.kind}</td>
          <td>{call.status.replaceAll("_", " ")}{call.httpStatus !== null && ` · HTTP ${call.httpStatus}`}{call.reason && ` · ${call.reason}`}</td>
          <td>{call.latencyMs === null ? "—" : `${(call.latencyMs / 1000).toFixed(1)}s`}</td>
          <td>{call.subjects ?? "—"}</td><td>{call.claimsAccepted ?? "—"}</td>
          <td>{call.tokensIn ?? "—"} / {call.tokensOut ?? "—"}</td>
          <td>{call.status === "running" ? <OperatorAction label="Stop request" body={{ action: "stop_call", id: call.id }} refresh={reload} />
            : ["extract", "extract_backfill"].includes(call.kind) && !["ok", "processing"].includes(call.status)
              ? <OperatorAction label="Retry batch" body={{ action: "retry", id: call.id }} refresh={reload} /> : "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>)}
    {onNewer && <button className="text-button" onClick={onNewer}>Newer calls</button>}
    {data?.nextBefore != null && <button className="text-button" onClick={() => onOlder(data.nextBefore!)}>Older calls</button>}
  </>;
}

export function LlmCallLog({ model, timeZone, usage }: { model: string; timeZone: string; usage: string }) {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<number[]>([]);
  const params = new URLSearchParams({ model });
  if (pages.length) params.set("before", String(pages.at(-1)));
  const path = `/api/status/llm-calls?${params}`;
  return <details className="llm-call-log" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>View log · {usage}</summary>
    {open && <CallRows key={path} path={path} timeZone={timeZone}
      onOlder={(id) => setPages([...pages, id])} onNewer={pages.length ? () => setPages(pages.slice(0, -1)) : undefined} />}
  </details>;
}
