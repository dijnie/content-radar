import { z } from "zod";
import type { Env } from "../env";
import { selectedChatModel, getAiSettings } from "../db/ai-settings";
import { listEnabledModels } from "../db/llm-repo";
import { setSetting } from "../db/settings-repo";
import { aiPaused } from "../llm/call-control";
import { circuitOpenUntil } from "../llm/circuit-breaker";
import { drainBacklog } from "../llm/drain-backlog";
import { checkOperatorPassword } from "./operator-password";
import { jsonError } from "./api-errors";

const callId = z.number().int().positive();
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("stop_call"), id: callId }),
  z.object({ action: z.literal("retry"), id: callId.optional(), model: z.string().max(2048).optional() }),
]);

export async function handleAiControl(request: Request, env: Env, now = Math.floor(Date.now() / 1000)) {
  const denied = await checkOperatorPassword(request, env.PASSWORD);
  if (denied) return denied;
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_ai_action");
  const action = parsed.data;
  const db = env.DB;
  if (action.action === "pause") {
    await db.batch([
      db.prepare("INSERT INTO settings (key,value_json) VALUES ('ai_processing_paused','true') ON CONFLICT(key) DO UPDATE SET value_json = 'true'"),
      db.prepare("UPDATE llm_calls SET status = 'stopped' WHERE status = 'running'"),
    ]);
    return Response.json({ status: "paused" });
  }
  if (action.action === "stop_call") {
    const row = await db.prepare("UPDATE llm_calls SET status = 'stopped' WHERE id = ? AND status IN ('running','stopped') RETURNING id").bind(action.id).first();
    return row ? Response.json({ status: "stopped" }) : jsonError(409, "call_already_finished");
  }
  const selected = selectedChatModel(await getAiSettings(db));
  if (selected === "") return jsonError(409, "ai_not_configured");
  const models = await listEnabledModels(db, selected);
  if (action.action === "retry" && action.model && !models.some(m => m.model === action.model)) return jsonError(409, "model_changed");
  if (action.action === "resume") await setSetting(db, "ai_processing_paused", false);
  if (await aiPaused(db)) return jsonError(409, "ai_paused");
  const until = await circuitOpenUntil(db, now);
  if (until || !models.some(m => (m.exhausted_until ?? 0) <= now)) {
    return Response.json({ status: "cooldown", until: until ?? models[0]?.exhausted_until });
  }
  let ids: number[] | undefined;
  if (action.action === "retry" && action.id) {
    const call = await db.prepare(`SELECT item_ids_json FROM llm_calls WHERE id = ? AND kind IN ('extract','extract_backfill')
      AND status != 'ok' AND (status NOT IN ('running','processing') OR at < ?)`).bind(action.id, now - 900).first<{ item_ids_json: string | null }>();
    if (!call) return jsonError(409, "call_not_retryable");
    const items = z.array(callId).safeParse(JSON.parse(call.item_ids_json ?? "[]"));
    if (!items.success || !items.data.length) return jsonError(409, "call_not_retryable");
    ids = items.data;
  }
  const lock = await db.prepare(`INSERT INTO settings (key,value_json) VALUES ('ai_manual_retry',?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json WHERE CAST(settings.value_json AS INTEGER) <= ?
    RETURNING key`).bind(String(now + 15), now).first();
  if (!lock) return Response.json({ status: "already_requested" });
  try {
    if (ids) await db.prepare(`UPDATE items SET status = 'queued', enqueue_attempts = 0, filter_reason = NULL WHERE status = 'failed'
      AND filter_reason IN ('dead_letter','llm_rejected','enqueue_attempts_exceeded') AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).run();
    const { sent } = await drainBacklog(env, now, true, ids);
    return Response.json({ status: sent ? "queued" : "no_eligible_items", sent }, { status: sent ? 202 : 200 });
  } catch (error) {
    await db.prepare("DELETE FROM settings WHERE key = 'ai_manual_retry' AND value_json = ?").bind(String(now + 15)).run();
    throw error;
  }
}
