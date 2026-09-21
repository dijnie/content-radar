import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Story } from "../types";
import { safeUrl } from "./card-actions";
import { formatTime, StoryCard } from "./story-card";

afterEach(cleanup);

const claim = (claimId: number, role: Story["claims"][number]["role"], textVi: string) => ({ claimId, role, textVi, quote: "141 tps", author: "luongnv89", platform: "x", url: `https://x.com/a/status/${claimId}`, publishedAt: 0 });

const READY: Story = {
  id: 2, label: "deepseek v4 flash", headline: "Theo phép đo của luongnv89, deepseek v4 flash chạy đủ nhanh cho vai trò subagent.", headlineSource: "llm", status: "ready", score: 78.6,
  independentSources: 2, questions: ["Đo trên phần cứng nào?", "Ai đo?", "Có lặp lại được không?", "Chi phí thật là bao nhiêu?"], hasCounter: true, topics: ["ai"], userState: "inbox", alive: true,
  lastClaimAt: Date.UTC(2026, 8, 11, 13, 39) / 1000,
  claims: [claim(1, "evidence", "luongnv89 tự đo và ghi 141 tps."), claim(2, "counter", "yinsenw_ nhận xét API bên thứ ba kém ổn định."), claim(3, "context", "LangChain đo trên dữ liệu hai tuần.")],
  claimCount: 5, links: [{ url: "https://x.com/a/status/1", author: "luongnv89", platform: "x" }, { url: "https://x.com/a/status/2", author: "yinsenw_", platform: "x" }],
};
const LEAD: Story = { ...READY, id: 1, label: "deepseek", status: "lead", score: 85.4, independentSources: 1, hasCounter: false, questions: ["a?", "b?", "c?"], headlineSource: "fallback", claims: [READY.claims[0]!], claimCount: 1, links: [READY.links[0]!] };

describe("StoryCard", () => {
  it("shows every part of the READY card spec", () => {
    render(<StoryCard story={READY} timeZone="Asia/Ho_Chi_Minh" onAction={() => {}} />);
    const card = screen.getByRole("article", { name: /deepseek v4 flash chạy đủ nhanh/ });
    expect(within(card).getByRole("heading", { name: "deepseek v4 flash" })).toBeTruthy();
    expect(within(card).getByText("READY")).toBeTruthy();
    expect(within(card).getByLabelText("score 78.6").textContent).toBe("78.6");
    expect(within(card).getAllByRole("listitem").slice(0, 3).map((item) => item.textContent)).toEqual([
      "EVIDENCEluongnv89 tự đo và ghi 141 tps.", "COUNTERyinsenw_ nhận xét API bên thứ ba kém ổn định.", "CONTEXTLangChain đo trên dữ liệu hai tuần.",
    ]);
    expect(within(card).getByText("2 independent sources")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "4 questions to verify" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(card).getByText("counterpoint")).toBeTruthy();
    expect(within(card).getByText("+2 more claims")).toBeTruthy();
    expect(within(card).getByText("11 Sep 2026, 20:39 ICT")).toBeTruthy();
    expect(within(card).queryByText("chưa tổng hợp")).toBeNull();
    for (const name of ["Save", "Dismiss", "Written"]) expect(within(card).getByRole("button", { name })).toBeTruthy();
  });

  it("shows a LEAD card: singular wording, no counterpoint chip, and the fallback-headline note", () => {
    render(<StoryCard story={LEAD} timeZone="Asia/Ho_Chi_Minh" onAction={() => {}} />);
    expect(screen.getByText("LEAD")).toBeTruthy();
    expect(screen.getByText("1 independent source")).toBeTruthy();
    expect(screen.getByRole("button", { name: "3 questions to verify" })).toBeTruthy();
    expect(screen.queryByText("counterpoint")).toBeNull();
    expect(screen.getByText("chưa tổng hợp")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Link" });
    expect(link.getAttribute("href")).toBe("https://x.com/a/status/1");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("opens a list of sources when there are several, and reports actions, all by keyboard", async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<StoryCard story={READY} timeZone="UTC" onAction={onAction} />);

    await user.tab(); // questions count
    await user.tab(); // Link
    expect(document.activeElement?.textContent).toContain("Link");
    await user.keyboard("{Enter}");
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["https://x.com/a/status/1", "https://x.com/a/status/2"]);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Written" }));
    expect(onAction.mock.calls.map(([story, action]) => [story.id, action])).toEqual([[2, "save"], [2, "written"]]);
  });

  it("opens and closes verification questions from their count with the keyboard", async () => {
    const user = userEvent.setup();
    render(<StoryCard story={READY} timeZone="UTC" onAction={() => {}} />);
    const toggle = screen.getByRole("button", { name: "4 questions to verify" });
    const questions = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(questions?.hidden).toBe(true);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(questions?.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(questions?.textContent).toContain(READY.questions[0]);
    await user.keyboard(" ");
    expect(questions?.hidden).toBe(true);
  });

  it("dismisses source links with Escape, outside click, or focus leaving the list", async () => {
    const user = userEvent.setup();
    render(<StoryCard story={READY} timeZone="UTC" onAction={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Link" });
    await user.click(trigger);
    await user.tab();
    expect(document.activeElement?.getAttribute("href")).toBe(READY.links[0]?.url);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("list", { name: "Original sources" })).toBeNull();
    await user.click(trigger);
    await user.click(screen.getByRole("heading", { name: READY.label! }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await user.click(trigger);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Save");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("offers Restore instead of Save and Dismiss once a story left the inbox", () => {
    render(<StoryCard story={{ ...READY, userState: "dismissed" }} timeZone="UTC" onAction={() => {}} />);
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Written" })).toBeNull();
  });

  it("renders crawled text as text and drops links that are not http(s)", () => {
    const hostile: Story = { ...LEAD, headline: '<img src=x onerror="alert(1)"> headline', links: [{ url: "javascript:alert(1)", author: "x", platform: "x" }] };
    const { container } = render(<StoryCard story={hostile} timeZone="UTC" onAction={() => {}} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("formatTime", () => {
  it("formats in the configured zone", () => {
    expect(formatTime(Date.UTC(2026, 8, 11, 3, 3) / 1000, "Asia/Ho_Chi_Minh")).toBe("11 Sep 2026, 10:03 ICT");
    expect(formatTime(Date.UTC(2026, 8, 11, 3, 3) / 1000, "UTC")).toBe("11 Sep 2026, 03:03 UTC");
  });
});
