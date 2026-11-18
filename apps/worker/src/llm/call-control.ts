import { getSetting } from "../db/settings-repo";
import { generateJson, type LlmRequest, type LlmResult } from "./custom-client";

export const aiPaused = async (db: D1Database) => (await getSetting<boolean>(db, "ai_processing_paused")) === true;

/** A dashboard request may be served in a different isolate from the queue consumer. */
export async function controlledGenerate(db: D1Database, id: number, request: LlmRequest): Promise<LlmResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const check = async () => {
    try {
      const row = await db.prepare(`SELECT status FROM llm_calls WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'ai_processing_paused' AND value_json = 'true')`).bind(id).first<{ status: string }>();
      if (row?.status !== "running") controller.abort();
    } finally {
      if (!finished && !controller.signal.aborted) timer = setTimeout(() => void check().catch(() => {}), 3000);
    }
  };
  try {
    try {
      await check();
    } catch {
      // The provider was never contacted. Let the caller log and release its reservation.
      return { ok: false, reached: false, kind: "transient", message: "control_check_failed",
        httpStatus: null, latencyMs: 0, tokensIn: 0, tokensOut: 0 };
    }
    return await generateJson({ ...request, signal: controller.signal });
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}
