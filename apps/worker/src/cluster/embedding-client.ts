import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "./vector-store";

export type EmbedFn = (texts: readonly string[]) => Promise<Float32Array[]>;

const BATCH_SIZE = 50;
const ATTEMPTS = 3;

/** Embeds with Workers AI in batches of 50, retrying a failed batch before giving up. */
export function workersAiEmbedder(ai: Ai, onTokens: (approxTokens: number) => void = () => {}): EmbedFn {
  return async (texts) => {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      let lastError: unknown;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          const output = (await ai.run(EMBEDDING_MODEL, { text: [...batch] })) as { data?: number[][] };
          if (!output.data || output.data.length !== batch.length || output.data.some((row) => row.length !== EMBEDDING_DIMS)) throw new Error("unexpected embedding shape");
          vectors.push(...output.data.map((row) => Float32Array.from(row)));
          // Rough token count, only used to watch the free neuron allocation.
          onTokens(Math.ceil(batch.reduce((sum, text) => sum + text.length, 0) / 4));
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (lastError) throw lastError;
    }
    return vectors;
  };
}
