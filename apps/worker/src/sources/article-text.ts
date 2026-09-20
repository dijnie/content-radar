import { HttpError } from "./http-client";
import { cleanText, type AdapterContext } from "./source-adapter";

const BLOCKS = "p, h1, h2, h3, li, blockquote, pre";
const CHROME = "nav, aside, footer, header, form, script, style, noscript, template";
/** An <article> or <main> body shorter than this is not trusted as the full text. */
const MIN_FOCUSED_LENGTH = 500;

/** Below this, the chrome-free text is not trusted either and everything on the page is used. */
const MIN_CLEAN_LENGTH = 200;

/**
 * Streaming extraction with HTMLRewriter, no DOM. Text is gathered per block
 * element; when the page has an <article> or <main> with enough text, only
 * blocks inside it are used, otherwise blocks outside page chrome.
 *
 * It never relies on end tags to close a block. HTML lets <p> and <li> omit
 * them and the rewriter does not synthesise the missing ones, so a block ends
 * when the next block starts, and once more at the end of the document. For the
 * same reason an unclosed <nav> must not swallow the page: a focus element
 * resets the chrome state, and text inside chrome is still kept as a last resort.
 */
export async function extractArticleText(html: string): Promise<string> {
  const focused: string[] = [];
  const clean: string[] = [];
  const everything: string[] = [];
  let focusDepth = 0;
  let chromeDepth = 0;
  let current: { text: string; focused: boolean; chrome: boolean } | null = null;

  const flush = () => {
    const block = current;
    current = null;
    const text = block ? cleanText(block.text) : "";
    if (!block || !text) return;
    everything.push(text);
    if (!block.chrome) clean.push(text);
    if (block.focused && !block.chrome) focused.push(text);
  };
  /** End tags are used when they come, and never waited for. */
  const onEnd = (element: Element, handler: () => void) => {
    try {
      element.onEndTag(handler);
    } catch {
      // Void elements have no end tag.
    }
  };

  const rewriter = new HTMLRewriter()
    .on("article, main, [role='main']", {
      element(element) {
        flush();
        focusDepth++;
        // Real article markup does not sit inside navigation; an open count here means an unclosed tag.
        chromeDepth = 0;
        onEnd(element, () => void (flush(), (focusDepth = Math.max(0, focusDepth - 1))));
      },
    })
    .on(CHROME, {
      element(element) {
        flush();
        chromeDepth++;
        onEnd(element, () => void (flush(), (chromeDepth = Math.max(0, chromeDepth - 1))));
      },
    })
    .on(BLOCKS, {
      element(element) {
        flush();
        current = { text: "", focused: focusDepth > 0, chrome: chromeDepth > 0 };
        onEnd(element, flush);
      },
      text(chunk) {
        if (current) current.text += chunk.text;
      },
    });

  await rewriter.transform(new Response(html)).arrayBuffer();
  flush();
  const focusedText = focused.join("\n");
  if (focusedText.length >= MIN_FOCUSED_LENGTH) return focusedText;
  const chromeFree = clean.join("\n");
  return chromeFree.length >= MIN_CLEAN_LENGTH || everything.length === clean.length ? chromeFree : everything.join("\n");
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
