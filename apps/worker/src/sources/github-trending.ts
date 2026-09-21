import type { RepositoryFacts } from "@radar/core";
import { htmlToText } from "./feed-parser";
import { cleanText, type AdapterContext, type NormalizedItem, type PollResult } from "./source-adapter";

interface TrendingRow { fullName: string; description: string; stars: number; starsToday: number; rank: number }

/** Read GitHub's daily ranking directly; repository search ordering is not a Trending rank. */
export function parseGithubTrending(html: string): TrendingRow[] {
  const articles = [...html.matchAll(/<article\b[^>]*class=["'][^"']*\bBox-row\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)];
  const rows: TrendingRow[] = [];
  for (const [index, article] of articles.entries()) {
    const body = article[1]!;
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(body)?.[1] ?? "";
    const fullName = /href=["']\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)["']/i.exec(heading)?.[1];
    const today = /([\d,]+)\s+stars? today/i.exec(htmlToText(body))?.[1];
    const starsLink = /<a\b[^>]*href=["'][^"']+\/stargazers["'][^>]*>([\s\S]*?)<\/a>/i.exec(body)?.[1];
    const stars = starsLink ? htmlToText(starsLink).replace(/[^\d]/g, "") : "";
    if (!fullName || !today || !stars) continue;
    rows.push({ fullName, stars: Number(stars), starsToday: Number(today.replaceAll(",", "")), rank: index + 1,
      description: cleanText(htmlToText(/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body)?.[1] ?? "")) });
  }
  if (!rows.length) throw new Error("github_trending_markup_unrecognised");
  return rows;
}

export async function pollGithubTrending(ctx: AdapterContext): Promise<PollResult> {
  const { text } = await ctx.fetchText("https://github.com/trending?since=daily");
  const rows = parseGithubTrending(text);
  const items: NormalizedItem[] = [];
  let metadataAvailable = true;
  for (const row of rows) {
    const repository: RepositoryFacts = { fullName: row.fullName, stars: row.stars, starsToday: row.starsToday, trendingRank: row.rank,
      forks: null, pushedAt: null, archived: null, license: null, capturedAt: ctx.now };
    if (metadataAvailable) {
      try {
        const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
        if (ctx.githubToken) headers.Authorization = `Bearer ${ctx.githubToken}`;
        const repo = await ctx.fetchJson<{ forks_count: number; pushed_at: string; archived: boolean; license: { spdx_id: string } | null }>(`https://api.github.com/repos/${row.fullName}`, { headers });
        repository.forks = repo.forks_count;
        repository.pushedAt = Math.floor(Date.parse(repo.pushed_at) / 1000) || null;
        repository.archived = repo.archived;
        repository.license = repo.license?.spdx_id ?? null;
      } catch {
        // Public HTML still supplies the ranking. Missing API-only facts remain unknown.
        metadataAvailable = false;
      }
    }
    const url = `https://github.com/${row.fullName}`;
    items.push({ platform: "github", externalId: `trending:${row.fullName.toLowerCase()}`, url, canonicalUrl: url, links: [],
      author: { platform: "github", handle: row.fullName.split("/")[0]!, displayName: null }, kind: "post", parentExternalId: null,
      title: row.fullName, text: cleanText(`${row.fullName}\n${row.description}`), lang: "en", publishedAt: ctx.now,
      raw: row, repository });
  }
  return { items, metrics: items.map((item) => ({ externalId: item.externalId, likes: item.repository!.stars, reposts: item.repository!.forks })) };
}
