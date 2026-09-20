import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, normalizeEntity, resolveMention, versionTokens } from "../../src/index";

const near = (name: string, cosine: number) => ({ entityId: 7, normalizedName: normalizeEntity(name), cosine });

describe("resolveMention", () => {
  it.each([
    ["an alias hit wins without looking further", "mcp", 3, near("Something Else", 0.1), { action: "alias", entityId: 3, addAlias: false }],
    ["no candidate creates a new entity", "brand new thing", null, null, { action: "new" }],
    ["a distant candidate creates a new entity", "vllm", null, near("Kubernetes", 0.4), { action: "new" }],
    ["a near-identical name becomes an alias", "open ai", null, near("OpenAI", 0.95), { action: "alias", entityId: 7, addAlias: true }],
    ["the ambiguous band goes to adjudication", "claude code", null, near("Claude", 0.85), { action: "adjudicate", candidateEntityId: 7, similarity: 0.85 }],
  ])("%s", (_name, normalized, alias, nearest, expected) => {
    expect(resolveMention(normalized, alias, nearest, DEFAULT_PARAMS)).toEqual(expected);
  });

  it("never auto-merges names that differ in a version, even at very high similarity", () => {
    const decision = resolveMention(normalizeEntity("DeepSeek V4 Flash"), null, near("DeepSeek V4.1 Flash", 0.99), DEFAULT_PARAMS);
    expect(decision).toEqual({ action: "adjudicate", candidateEntityId: 7, similarity: 0.99 });
    expect(resolveMention(normalizeEntity("GPT-5"), null, near("GPT", 0.97), DEFAULT_PARAMS).action).toBe("adjudicate");
  });

  it("still auto-merges spelling variants of the same version", () => {
    const decision = resolveMention(normalizeEntity("Deep Seek V4 Flash"), null, near("DeepSeek V4 Flash", 0.96), DEFAULT_PARAMS);
    expect(decision).toEqual({ action: "alias", entityId: 7, addAlias: true });
  });

  it("reads version tokens from normalized names", () => {
    expect(versionTokens("deepseek-v4.1 flash")).toEqual(["4.1"]);
    expect(versionTokens("claude 3.5 sonnet")).toEqual(["3.5"]);
    expect(versionTokens("gpt-4o")).toEqual(["4o"]);
    expect(versionTokens("openai")).toEqual([]);
  });
});
