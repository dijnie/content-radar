import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useResource } from "./use-resource";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("stops polling a hidden control panel and reads immediately when the operator returns", async () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const fetcher = vi.fn(async () => Response.json({ activeCalls: [] }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => { renderHook(() => useResource("/api/status/llm-active", 2500)); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  hidden = false;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
