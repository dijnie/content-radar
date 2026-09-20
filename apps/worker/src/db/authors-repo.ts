import type { SourceType } from "./sources-repo";

export interface AuthorHandleInput {
  platform: SourceType;
  handle: string;
  displayName?: string | null;
  /** `author_key` of the configured source, linking this handle to a known author. */
  authorKey?: string | null;
}

/** X and GitHub handles are case-insensitive on their platforms. */
export function normalizeHandle(platform: SourceType, handle: string): string {
  const trimmed = handle.trim().replace(/^@/, "");
  return platform === "x" || platform === "github" ? trimmed.toLowerCase() : trimmed;
}

/**
 * Returns the author that owns the handle, creating the author and the handle
 * when needed. A handle already linked to an author is never re-linked.
 */
export async function upsertAuthorByHandle(db: D1Database, input: AuthorHandleInput): Promise<number> {
  const handle = normalizeHandle(input.platform, input.handle);
  const existing = await db
    .prepare("SELECT author_id FROM author_handles WHERE platform = ? AND handle = ?")
    .bind(input.platform, handle)
    .first<{ author_id: number }>();
  if (existing) return existing.author_id;

  const authorKey = input.authorKey ?? `${input.platform}:${handle}`;
  const author = await db
    .prepare(
      `INSERT INTO authors (author_key, canonical_name) VALUES (?, ?)
       ON CONFLICT(author_key) DO UPDATE SET canonical_name = canonical_name
       RETURNING id`,
    )
    .bind(authorKey, input.displayName?.trim() || handle)
    .first<{ id: number }>();
  if (!author) throw new Error(`could not upsert author ${authorKey}`);

  await db
    .prepare("INSERT INTO author_handles (author_id, platform, handle) VALUES (?, ?, ?) ON CONFLICT(platform, handle) DO NOTHING")
    .bind(author.id, input.platform, handle)
    .run();
  // A concurrent writer may have linked the handle first; the stored link wins.
  const linked = await db
    .prepare("SELECT author_id FROM author_handles WHERE platform = ? AND handle = ?")
    .bind(input.platform, handle)
    .first<{ author_id: number }>();
  return linked?.author_id ?? author.id;
}
