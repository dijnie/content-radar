import { HttpError } from "./http-client";
import { cleanText, type AdapterContext } from "./source-adapter";

const BLOCKS = "p, h1, h2, h3, li, blockquote, pre";
const CHROME = "nav, aside, footer, header, form, script, style, noscript, template";
/** An <article> or <main> body shorter than this is not trusted as the full text. */
const MIN_FOCUSED_LENGTH = 500;

/**
 * Streaming extraction with HTMLRewriter, no DOM. Text is gathered from block
 * elements outside page chrome; when the page has an <article> or <main>, only
 * blocks inside it are used.
 */
export async function extractArticleText(html: string): Promise<string> {
  const focused: string[] = [];
  const all: string[] = [];
  let focusDepth = 0;
  let chromeDepth = 0;
  let current: { text: string; focused: boolean } | null = null;

  const rewriter = new HTMLRewriter()
    .on("article, main, [role='main']", {
      element(element) {
        focusDepth++;
        element.onEndTag(() => void focusDepth--);
      },
    })
    .on(CHROME, {
      element(element) {
        chromeDepth++;
        element.onEndTag(() => void chromeDepth--);
      },
    })
    .on(BLOCKS, {
      element(element) {
        if (chromeDepth > 0 || current) return;
        const block = { text: "", focused: focusDepth > 0 };
        current = block;
        element.onEndTag(() => {
          const text = cleanText(block.text);
          if (text) {
            all.push(text);
            if (block.focused) focused.push(text);
          }
          current = null;
        });
      },
      text(chunk) {
        if (current) current.text += chunk.text;
      },
    });

  await rewriter.transform(new Response(html)).arrayBuffer();
  const focusedText = focused.join("\n");
  return focusedText.length >= MIN_FOCUSED_LENGTH ? focusedText : all.join("\n");
}

/** Downloads an article within the poll's budget. Returns null when it cannot be had. */
export async function fetchArticleText(url: string, ctx: AdapterContext): Promise<string | null> {
  if (ctx.articleBudget.remaining <= 0) return null;
  ctx.articleBudget.remaining--;
  try {
    const { text: html, headers } = await ctx.fetchText(url, { maxBytes: 1_000_000, timeoutMs: 10_000 });
    if (!/html/i.test(headers.get("Content-Type") ?? "text/html")) return null;
    return (await extractArticleText(html)) || null;
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}
