import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/index";

describe("@radar/core", () => {
  it("exposes a version", () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
