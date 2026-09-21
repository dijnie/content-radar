import { z } from "zod";
import { feedExternalId } from "../db/items-repo";
import { cleanText, type AdapterContext, type NormalizedItem, type PollResult } from "./source-adapter";

export const HUGGINGFACE_PAPERS_URL = "https://huggingface.co/api/daily_papers";
const paperSchema = z.object({
  paper: z.object({ id: z.string().regex(/^\d{4}\.\d{4,5}$/), title: z.string(), summary: z.string(), publishedAt: z.string(),
    authors: z.array(z.object({ name: z.string() })).default([]), upvotes: z.number().nonnegative().optional() }),
  numComments: z.number().nonnegative().optional(),
});

/** Public paper abstracts and discussion counts; never present abstracts as downloaded full papers. */
export async function pollHuggingfacePapers(sourceId: number, ctx: AdapterContext): Promise<PollResult> {
  const response = await ctx.fetchJson<unknown>(HUGGINGFACE_PAPERS_URL, { maxBytes: 5_000_000 });
  if (!Array.isArray(response)) throw new Error("huggingface_papers_invalid_response");
  const items: NormalizedItem[] = [];
  const metrics: PollResult["metrics"] = [];
  for (const raw of response.slice(0, 100)) {
    const parsed = paperSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { paper, numComments } = parsed.data;
    const publishedAt = Math.floor(Date.parse(paper.publishedAt) / 1000);
    if (!Number.isFinite(publishedAt) || publishedAt > ctx.now + 86400 || publishedAt < ctx.now - 90 * 86400) continue;
    const url = `https://huggingface.co/papers/${paper.id}`;
    const externalId = await feedExternalId(sourceId, paper.id);
    items.push({ platform: "rss", externalId, url, canonicalUrl: url, links: [`https://arxiv.org/abs/${paper.id}`],
      author: { platform: "rss", handle: `huggingface.co/papers/${paper.id}`, displayName: paper.authors.map((author) => author.name).join(", ").slice(0, 300) || null },
      kind: "article", parentExternalId: null, title: cleanText(paper.title),
      text: cleanText(`${paper.title}\n${paper.summary}`), lang: "en", publishedAt, summaryOnly: true, raw });
    metrics.push({ externalId, points: paper.upvotes ?? null, comments: numComments ?? null });
  }
  if (response.length && !items.length) throw new Error("huggingface_papers_no_valid_recent_items");
  return { items, metrics };
}
