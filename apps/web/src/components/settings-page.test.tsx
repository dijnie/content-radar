import { Buffer } from "node:buffer";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, it, expect, vi } from "vitest";
import { SettingsPage } from "./settings-page";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("unlocks, edits the embedding provider, saves and clears credentials on lock", async () => {
  const saved = { revision: 1, enabled: true, chatEndpoint: "https://chat.example/v1", chatModel: "chat", hasChatKey: true,
    embeddingEndpoint: "", embeddingModel: "vectors", hasEmbeddingKey: false };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(saved))
    .mockResolvedValueOnce(Response.json({ ...saved, revision: 2, embeddingEndpoint: "https://embed.example/v1", hasEmbeddingKey: true }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<SettingsPage />);
  await user.type(screen.getByLabelText("Password"), "mật khẩu: thử");
  await user.click(screen.getByRole("button", { name: "Unlock settings" }));
  await user.click(await screen.findByRole("checkbox", { name: "Use the chat endpoint and API key" }));
  await user.type(screen.getByLabelText("Embedding endpoint"), "https://embed.example/v1");
  await user.type(screen.getByLabelText("Embedding API key"), "example-key");
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByText("Settings saved.")).toBeTruthy();
  const [, init] = fetcher.mock.calls[1]!;
  expect(init?.headers).toMatchObject({ Authorization: "Basic " + Buffer.from("settings:mật khẩu: thử").toString("base64") });
  expect(JSON.parse(String(init?.body))).toMatchObject({ revision: 1, chatKey: "", embeddingKey: "example-key" });
  expect((screen.getByLabelText("Embedding API key") as HTMLInputElement).value).toBe("");
  await user.click(screen.getByRole("button", { name: "Lock settings" }));
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
});

it("shows an incorrect password and distinguishes a server error when loading settings", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: "invalid_password" }, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ error: "internal_error" }, { status: 500 })));
  const user = userEvent.setup();
  render(<SettingsPage />);
  await user.type(screen.getByLabelText("Password"), "test-password");
  await user.click(screen.getByRole("button", { name: "Unlock settings" }));
  expect(await screen.findByText("Incorrect password. Try again.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Unlock settings" }));
  expect(await screen.findByText("Could not load settings (HTTP 500).")).toBeTruthy();
});
