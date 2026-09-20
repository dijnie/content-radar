export const PLATFORMS = ["x", "hn", "rss", "github"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** X and GitHub handles are case-insensitive on their platforms. */
export function normalizeHandle(platform: Platform, handle: string): string {
  const trimmed = handle.trim().replace(/^@/, "");
  return platform === "x" || platform === "github" ? trimmed.toLowerCase() : trimmed;
}
