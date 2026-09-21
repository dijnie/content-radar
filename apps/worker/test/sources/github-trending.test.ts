import { describe, expect, it } from "vitest";
import { parseGithubTrending, pollGithubTrending } from "../../src/sources/github-trending";
import { fakeContext } from "./adapter-context";

const html = `<article class="Box-row"><h2><a href="/example/agent">example / agent</a></h2><p>Reusable agent tools</p>
  <a href="/example/agent/stargazers"><svg><path d="M123" /></svg>12,345</a><span>1,234 stars today</span></article>`;
describe("real daily trending facts", () => {
  it("takes rank from page order and ignores SVG path digits", () => {
    expect(parseGithubTrending(html)).toEqual([{ fullName: "example/agent", description: "Reusable agent tools", stars: 12345, starsToday: 1234, rank: 1 }]);
    expect(() => parseGithubTrending("<html>Access denied</html>")).toThrow("markup_unrecognised");
  });
  it("retains ranking and marks API-only facts missing on metadata failure", async () => {
    const { ctx, requests } = fakeContext({ "https://github.com/trending?since=daily": html }, { githubToken: "test-token" });
    const result = await pollGithubTrending(ctx);
    expect(result.items[0]?.repository).toMatchObject({ trendingRank: 1, starsToday: 1234, stars: 12345, pushedAt: null, archived: null, forks: null });
    expect(requests[0]!.headers.Authorization).toBeUndefined();
    expect(requests[1]!.headers.Authorization).toBe("Bearer test-token");
  });
});
