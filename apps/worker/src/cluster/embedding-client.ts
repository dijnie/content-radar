import type { Env } from "../env";
import { providerUrl } from "../llm/api-url";
import { EMBEDDING_DIMS, DEFAULT_EMBEDDING_MODEL } from "./vector-store";

export type EmbedFn = (texts: readonly string[]) => Promise<Float32Array[]>;
type EmbeddingEnv = Pick<Env, "LLM_ENDPOINT" | "LLM_API_KEY" | "EMBEDDING_MODEL">;

export function embeddingModel(env: EmbeddingEnv): string {
  return env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export class EmbeddingHttpError extends Error {
  constructor(readonly status: number) { super(`embedding_http_${status}`); }
}

function readVectors(data: unknown, count: number): Float32Array[] {
  if (!Array.isArray(data) || data.length !== count) throw new Error("unexpected embedding count");
  const vectors = new Array<Float32Array>(count);
  for (const row of data) {
    const index = row?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count || vectors[index]) throw new Error("unexpected embedding index");
    if (!Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIMS || !row.embedding.every(Number.isFinite)) {
      throw new Error(`expected finite ${EMBEDDING_DIMS}-dimensional embeddings`);
    }
    const vector = Float32Array.from(row.embedding);
    if (!vector.every(Number.isFinite)) throw new Error("embedding value exceeds Float32 range");
    vectors[index] = vector;
  }
  return vectors;
}

export function openAiEmbedder(env: EmbeddingEnv, onTokens?: (tokens: number) => void, timeoutMs = 60_000): EmbedFn {
  return async (texts) => {
    if (!texts.length) return [];
    if (!env.LLM_ENDPOINT?.trim()) throw new Error("llm_endpoint_missing");
    if (!env.LLM_API_KEY?.trim()) throw new Error("llm_api_key_missing");
    const url = providerUrl(env.LLM_ENDPOINT, "embeddings");
    const model = embeddingModel(env);
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += 50) {
      const input = texts.slice(start, start + 50);
      // BGE-M3 already emits 1024 dimensions. Adjustable models take the standard dimensions parameter.
      const dimensions = /(?:^|\/)bge-m3$/i.test(model) ? undefined : EMBEDDING_DIMS;
      const body = JSON.stringify({ model, input, dimensions, encoding_format: "float" });
      for (let attempt = 1; ; attempt++) {
        let response: Response;
        let output;
        try {
          response = await fetch(url.toString(), {
            method: "POST", headers: { Authorization: `Bearer ${env.LLM_API_KEY.trim()}`, "Content-Type": "application/json" },
            body, signal: AbortSignal.timeout(timeoutMs), redirect: "manual",
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new EmbeddingHttpError(response.status);
          }
          output = await response.json<{ data?: unknown; usage?: { prompt_tokens?: number } }>();
        } catch (error) {
          if (attempt >= 3 || (error instanceof EmbeddingHttpError && error.status < 500 && error.status !== 408 && error.status !== 429)) throw error;
          continue;
        }
        vectors.push(...readVectors(output?.data, input.length));
        onTokens?.(output.usage?.prompt_tokens ?? Math.ceil(input.reduce((sum, text) => sum + text.length, 0) / 4));
        break;
      }
    }
    return vectors;
  };
}
