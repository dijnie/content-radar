/**
 * Canonical key for an entity surface form: lower case, no diacritics, no
 * punctuation, single spaces. Dots and hyphens between alphanumerics survive,
 * so version strings such as "v4.1" or "gpt-4o" stay distinct from "v4" and "gpt 4".
 */
export function normalizeEntity(surface: string): string {
  return surface
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/(?<![\p{L}\p{N}])[.\-]|[.\-](?![\p{L}\p{N}])/gu, " ")
    .replace(/[^\p{L}\p{N}.\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
