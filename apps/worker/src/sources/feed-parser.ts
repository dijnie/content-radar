// Small RSS 2.0 / Atom reader. Workers have no DOM or XML parser, and feeds
// only need a handful of fields, so entries are cut out by tag and read with
// targeted patterns. Anything unrecognised is ignored rather than guessed.

export interface FeedEntry {
  guid: string;
  link: string;
  title: string;
  /** HTML or text body as published in the feed. */
  html: string;
  author: string | null;
  publishedAt: number | null;
}

export interface ParsedFeed {
  title: string;
  entries: FeedEntry[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? match;
    const point = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
  });
}

function unwrap(value: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  return cdata ? cdata[1]! : decodeEntities(value);
}

function tagText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return match ? unwrap(match[1]!).trim() : null;
}

function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((match) => match[1]!);
  const attr = (attrs: string, name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs)?.[1];
  const alternate = links.find((attrs) => (attr(attrs, "rel") ?? "alternate") === "alternate" && attr(attrs, "href"));
  const href = alternate ? attr(alternate, "href") : undefined;
  return href ? decodeEntities(href) : null;
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Visible text of an HTML fragment. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

export function hrefsIn(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((match) => decodeEntities(match[1]!));
}

export function parseFeed(xml: string, maxEntries: number): ParsedFeed {
  const isAtom = /<feed\b/i.test(xml) && !/<rss\b/i.test(xml);
  const tag = isAtom ? "entry" : "item";
  const blocks = [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))].slice(0, maxEntries);
  const head = xml.slice(0, blocks[0]?.index ?? xml.length);

  const entries: FeedEntry[] = [];
  for (const [, block] of blocks) {
    const link = isAtom ? atomLink(block!) : tagText(block!, "link");
    const guid = tagText(block!, isAtom ? "id" : "guid") ?? link;
    if (!link || !guid) continue;
    const authorBlock = isAtom ? tagText(block!, "author") : null;
    entries.push({
      guid,
      link,
      title: tagText(block!, "title") ?? "",
      html: tagText(block!, "content:encoded") ?? tagText(block!, "content") ?? tagText(block!, "description") ?? tagText(block!, "summary") ?? "",
      author: (authorBlock ? tagText(authorBlock, "name") : null) ?? tagText(block!, "dc:creator") ?? (isAtom ? null : tagText(block!, "author")),
      publishedAt: parseDate(tagText(block!, "published") ?? tagText(block!, "pubDate") ?? tagText(block!, "updated") ?? tagText(block!, "dc:date")),
    });
  }
  return { title: tagText(head, "title") ?? "", entries };
}
