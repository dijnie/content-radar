import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorAction, OperatorLock, OperatorSession } from "./operator-action";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reuses a successful unlock until locked and lets the operator cancel without sending", async () => {
  const fetcher = vi.fn(async () => Response.json({ status: "queued", sent: 4 }));
  vi.stubGlobal("fetch", fetcher);
  const refresh = vi.fn();
  render(<OperatorSession><OperatorLock /><OperatorAction label="Chạy 50 bài" body={{ action: "retry", limit: 50 }} refresh={refresh} /></OperatorSession>);
  const user = userEvent.setup();
  const run = () => screen.getByRole("button", { name: "Chạy 50 bài" });
  await user.click(run());
  const dialog = screen.getByRole("dialog", { name: "Chạy 50 bài" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  await user.type(screen.getByLabelText("Mật khẩu điều khiển"), "fixture-password");
  await user.click(screen.getByRole("button", { name: "Xác nhận" }));
  expect((await screen.findByRole("status")).textContent).toContain("Đã xếp 4 bài");
  await user.click(run());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(refresh).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Khóa điều khiển" }));
  await user.click(run());
  expect((screen.getByLabelText("Mật khẩu điều khiển") as HTMLInputElement).value).toBe("");
  await user.click(screen.getByRole("button", { name: "Hủy" }));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("prompts again when a previously accepted password stops working", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ status: "paused" }))
    .mockResolvedValueOnce(Response.json({ error: "invalid_password" }, { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  render(<OperatorSession><OperatorAction label="Tạm dừng AI" body={{ action: "pause" }} refresh={() => {}} /></OperatorSession>);
  const user = userEvent.setup();
  const button = screen.getByRole("button", { name: "Tạm dừng AI" });
  await user.click(button);
  await user.type(screen.getByLabelText("Mật khẩu điều khiển"), "local-password");
  await user.click(screen.getByRole("button", { name: "Xác nhận" }));
  await screen.findByRole("status");
  await user.click(button);
  expect((await screen.findByRole("alert")).textContent).toContain("Mật khẩu không đúng");
  expect((screen.getByLabelText("Mật khẩu điều khiển") as HTMLInputElement).value).toBe("");
  expect(screen.queryByRole("button", { name: "Khóa điều khiển" })).toBeNull();
});
