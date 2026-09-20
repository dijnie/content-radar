export const PLATFORMS = ["x", "hn", "rss", "github"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/** X and GitHub handles are case-insensitive on their platforms. */
export function normalizeHandle(platform: Platform, handle: string): string {
  const trimmed = handle.trim().replace(/^@/, "");
  return platform === "x" || platform === "github" ? trimmed.toLowerCase() : trimmed;
}
