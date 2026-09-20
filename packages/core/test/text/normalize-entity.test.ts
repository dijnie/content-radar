import { describe, expect, it } from "vitest";
import { normalizeEntity } from "../../src/index";

describe("normalizeEntity", () => {
  it.each([
    ["  OpenAI  ", "openai"],
    ["DeepSeek-V4.1 Flash", "deepseek-v4.1 flash"],
    ["DeepSeek V4 Flash", "deepseek v4 flash"],
    ["GPT-4o", "gpt-4o"],
    ["Model Context Protocol (MCP)", "model context protocol mcp"],
    ["Claude 3.5 Sonnet.", "claude 3.5 sonnet"],
    ["“Llama”, v3!", "llama v3"],
    ["Trí tuệ nhân tạo Việt", "tri tue nhan tao viet"],
    ["Đại học Bách Khoa", "dai hoc bach khoa"],
    ["C++ / Node.js", "c node.js"],
    ["--- ...", ""],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeEntity(input)).toBe(expected);
  });

  it("keeps different versions apart", () => {
    expect(normalizeEntity("DeepSeek V4 Flash")).not.toBe(normalizeEntity("DeepSeek V4.1 Flash"));
  });

  it("is idempotent", () => {
    const once = normalizeEntity("DeepSeek-V4.1 “Flash” (preview)");
    expect(normalizeEntity(once)).toBe(once);
  });
});
