const FUZZY_MIN_TOKEN_SHARE = 0.9;
const FUZZY_WINDOW_SLACK = 1.3;
const FUZZY_MIN_TOKENS = 5;

/**
 * Canonical form for comparing a quote with its source: NFKC (which also folds
 * full-width punctuation and composes Vietnamese diacritics), one kind of quote
 * mark and dash, no control or zero-width characters, single spaces, lower case.
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, " ")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»「」『』]/g, '"')
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Longest common subsequence length, the number of quote tokens found in order. */
function tokensInOrder(quote: readonly string[], window: readonly string[]): number {
  let previous = new Array<number>(window.length + 1).fill(0);
  for (const token of quote) {
    const current = [0];
    for (let j = 1; j <= window.length; j++) {
      current[j] = token === window[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    previous = current;
  }
  return previous[window.length]!;
}

/**
 * True when the quote can be traced to the source: an exact substring after
 * normalization, or at least 90% of its tokens in order within one window.
 * The fuzzy path forgives a dropped word or a fixed typo, never a paraphrase
 * and never a changed number.
 */
export function quoteFoundIn(quote: string, source: string): boolean {
  const needle = normalizeForMatch(quote);
  const haystack = normalizeForMatch(source);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;

  const quoteTokens = needle.split(" ");
  if (quoteTokens.length < FUZZY_MIN_TOKENS) return false;
  const sourceTokens = haystack.split(" ");
  const windowSize = Math.ceil(quoteTokens.length * FUZZY_WINDOW_SLACK);
  const needed = Math.ceil(quoteTokens.length * FUZZY_MIN_TOKEN_SHARE);
  const anchors = new Set(quoteTokens.slice(0, 3));
  // Numbers are the evidence. A quote whose wording is 93% right but whose
  // figure is wrong must fail, so every digit-bearing token has to match exactly.
  const numbers = quoteTokens.filter((token) => /\d/.test(token));
  for (let start = 0; start < sourceTokens.length; start++) {
    if (!anchors.has(sourceTokens[start]!)) continue;
    const window = sourceTokens.slice(start, start + windowSize);
    if (numbers.some((token) => !window.includes(token))) continue;
    if (tokensInOrder(quoteTokens, window) >= needed) return true;
  }
  return false;
}
