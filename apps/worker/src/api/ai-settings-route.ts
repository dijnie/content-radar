import { z } from "zod";
import { getAiSettings, type AiSettings } from "../db/ai-settings";
import type { Env } from "../env";
import { providerUrl } from "../llm/api-url";

const value = z.string().trim().max(2048);
const changes = z.object({
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  chatEndpoint: value.min(1),
  chatModel: value.min(1),
  chatKey: value.optional(),
  embeddingEndpoint: value,
  embeddingModel: value.min(1),
  embeddingKey: value.optional(),
}).strict();

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function visible(row: AiSettings) {
  return {
    revision: row.revision, enabled: Boolean(row.enabled),
    chatEndpoint: row.chat_endpoint, chatModel: row.chat_model ?? "", hasChatKey: Boolean(row.chat_key),
    embeddingEndpoint: row.embedding_endpoint, embeddingModel: row.embedding_model, hasEmbeddingKey: Boolean(row.embedding_key),
  };
}

function validEndpoint(endpoint: string, worker: URL): boolean {
  try {
    const url = providerUrl(endpoint, "embeddings");
    if ([...url.searchParams.keys()].some(key => /key|token|password|secret|signature/i.test(key))) return false;
    const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
    return url.protocol === "https:" || (loopback(worker.hostname) && loopback(url.hostname));
  } catch { return false; }
}

export async function handleAiSettings(request: Request, { DB: db, OWNER_TOKEN }: Pick<Env, "DB" | "OWNER_TOKEN">): Promise<Response> {
  const owner = OWNER_TOKEN?.trim();
  if (!owner) return reply({ error: "owner_token_not_configured" }, 503);
  const supplied = /^Bearer (\S+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!supplied) return reply({ error: "owner_token_required" }, 401);
  const encoder = new TextEncoder();
  const digest = (token: string) => crypto.subtle.digest("SHA-256", encoder.encode(token));
  const [expected, received] = await Promise.all([digest(owner), digest(supplied)]);
  if (!crypto.subtle.timingSafeEqual(expected, received)) {
    return reply({ error: "invalid_owner_token" }, 403);
  }
  const row = await getAiSettings(db);
  if (request.method === "GET") return reply(visible(row));
  const parsed = changes.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return reply({ error: "invalid_settings" }, 400);
  const data = parsed.data;
  if (data.revision !== row.revision) return reply({ error: "settings_changed" }, 409);
  const worker = new URL(request.url);
  if (!validEndpoint(data.chatEndpoint, worker) || (data.embeddingEndpoint && !validEndpoint(data.embeddingEndpoint, worker))) {
    return reply({ error: "invalid_endpoint" }, 400);
  }
  // A saved key can only be reused for the exact endpoint it was entrusted to.
  const chatKey = data.chatKey || (data.chatEndpoint === row.chat_endpoint ? row.chat_key : "");
  const embeddingKey = data.embeddingEndpoint
    ? data.embeddingKey || (data.embeddingEndpoint === row.embedding_endpoint ? row.embedding_key : "")
    : "";
  if (!chatKey || (data.embeddingEndpoint && !embeddingKey)) return reply({ error: "provider_key_required" }, 400);

  const [updated] = await db.batch([
    db.prepare(`UPDATE ai_settings SET revision = revision + 1, enabled = ?, chat_endpoint = ?, chat_model = ?, chat_key = ?,
      embedding_endpoint = ?, embedding_model = ?, embedding_key = ? WHERE id = 1 AND revision = ?`)
      .bind(Number(data.enabled), data.chatEndpoint, data.chatModel, chatKey, data.embeddingEndpoint, data.embeddingModel, embeddingKey, data.revision),
    db.prepare("DELETE FROM settings WHERE key = 'llm_circuit' AND changes() = 1 AND json_extract(value_json, '$.errorKind') IN ('configuration_error','insufficient_balance')"),
  ]);
  if (!updated?.meta.changes) return reply({ error: "settings_changed" }, 409);
  return reply(visible(await getAiSettings(db)));
}
