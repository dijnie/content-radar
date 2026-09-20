import { canonicalizeUrl } from "./canonical-url";
import { parseFeed } from "./feed-parser";
import { FEED_ENTRIES_PER_POLL, mapFeedEntry } from "./rss-feed";
import { cleanText, type AdapterContext, type NormalizedItem, type PollResult, type SourceAdapter } from "./source-adapter";

const API_HOST = "api.github.com";
const SEARCH_PREFIX = "search:";
const SEARCH_RESULTS = 10;
/** Trending proxy: repositories pushed within this window, ordered by stars. */
const TRENDING_WINDOW_DAYS = 7;

interface SearchRepo {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count?: number;
  pushed_at: string;
  created_at: string;
  language: string | null;
  topics?: string[];
  owner: { login: string };
}

function mapRepo(repo: SearchRepo, ctx: AdapterContext): NormalizedItem {
  const url = canonicalizeUrl(repo.html_url) ?? repo.html_url;
  const facts = [repo.language, `${repo.stargazers_count} stars`, (repo.topics ?? []).slice(0, 8).join(", ")].filter(Boolean).join(" · ");
  return {
    platform: "github",
    externalId: `repo:${repo.id}`,
    url,
    canonicalUrl: url,
    links: [],
    author: { platform: "github", handle: repo.owner.login, displayName: null },
    kind: "post",
    parentExternalId: null,
    title: cleanText(repo.full_name),
    text: cleanText([repo.full_name, repo.description, facts].filter(Boolean).join("\n")),
    lang: "en",
    // A repository surfaces when it starts trending, not when it was created.
    publishedAt: Math.min(ctx.now, Math.floor(Date.parse(repo.pushed_at) / 1000) || ctx.now),
    raw: repo,
  };
}

async function pollSearch(query: string, ctx: AdapterContext): Promise<PollResult> {
  const since = new Date((ctx.now - TRENDING_WINDOW_DAYS * 86_400) * 1000).toISOString().slice(0, 10);
  const url = new URL(`https://${API_HOST}/search/repositories`);
  url.searchParams.set("q", `${query} pushed:>${since}`);
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(SEARCH_RESULTS));
  // The token goes to api.github.com only; the HTTP client drops it on any cross-host redirect.
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (ctx.githubToken) headers.Authorization = `Bearer ${ctx.githubToken}`;
  const { items } = await ctx.fetchJson<{ items: SearchRepo[] }>(url, { headers });
  return {
    items: items.map((repo) => mapRepo(repo, ctx)),
    metrics: items.map((repo) => ({ externalId: `repo:${repo.id}`, likes: repo.stargazers_count, reposts: repo.forks_count ?? null })),
  };
}

/** `releases.atom` is served by github.com and does not count against the REST rate limit. */
async function pollReleases(source: { id: number; key: string }, ctx: AdapterContext): Promise<PollResult> {
  const { text: xml } = await ctx.fetchText(`https://github.com/${source.key}/releases.atom`);
  const items: NormalizedItem[] = [];
  for (const entry of parseFeed(xml, FEED_ENTRIES_PER_POLL).entries) {
    const item = await mapFeedEntry({ ...entry, title: `${source.key} ${entry.title}` }, source, "release", ctx);
    if (item) items.push(item);
  }
  return { items, metrics: [] };
}

export const githubAdapter: SourceAdapter = {
  type: "github",
  poll(source, ctx) {
    return source.key.startsWith(SEARCH_PREFIX) ? pollSearch(source.key.slice(SEARCH_PREFIX.length), ctx) : pollReleases(source, ctx);
  },
};
