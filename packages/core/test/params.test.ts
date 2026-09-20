import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, PARAMS_VERSION, resolveParams } from "../src/index";

describe("resolveParams", () => {
  it("returns the defaults untouched and versioned", () => {
    expect(resolveParams()).toEqual(DEFAULT_PARAMS);
    expect(resolveParams({})).not.toBe(DEFAULT_PARAMS);
    expect(PARAMS_VERSION).toBe(1);
    expect(Object.isFrozen(DEFAULT_PARAMS)).toBe(true);
  });

  it("applies valid overrides", () => {
    const params = resolveParams({ resolution: 0.35, windowDays: 10, quality: "modularity" });
    expect(params).toMatchObject({ resolution: 0.35, windowDays: 10, quality: "modularity", seed: 42 });
  });

  it.each([
    [{ gamma: 1 }, /unknown parameter gamma/],
    [{ resolution: 0 }, /resolution/],
    [{ resolution: "0.5" }, /resolution/],
    [{ windowDays: 7.5 }, /windowDays must be an integer/],
    [{ minCommunitySize: 1 }, /minCommunitySize/],
    [{ cosineFloor: Number.NaN }, /cosineFloor/],
    [{ quality: "louvain" }, /quality/],
    [{ jaccardRelated: 0.8 }, /jaccardRelated must not exceed/],
    [{ aliasAutoReject: 0.95 }, /aliasAutoReject must not exceed/],
    [{ wCos: 0.9 }, /wCos \+ wEnt/],
    [{ weightSources: 0.5 }, /score weights must sum to 1/],
  ])("refuses %j", (overrides, message) => {
    expect(() => resolveParams(overrides)).toThrow(message);
  });

  it("reports every problem at once", () => {
    expect(() => resolveParams({ nope: 1, seed: -1 })).toThrow(/unknown parameter nope; seed/);
  });
});
