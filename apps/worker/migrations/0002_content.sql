-- Crawled items, the URLs they point at, and engagement snapshots.

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  platform TEXT NOT NULL CHECK (platform IN ('x', 'hn', 'rss', 'github')),
  -- X and HN: the platform's own id. RSS and GitHub: '<source_id>:<sha256 of guid>',
  -- so one feed can never touch another feed's rows.
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  author_id INTEGER REFERENCES authors(id),
  title TEXT,
  text_excerpt TEXT NOT NULL DEFAULT '',
  lang TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('post', 'reply', 'repost', 'quote', 'article', 'story', 'comment', 'release')),
  parent_external_id TEXT,
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  raw_r2_key TEXT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'filtered_out', 'queued', 'extracted', 'irrelevant', 'failed')),
  filter_reason TEXT,
  topic_hint TEXT,
  ingest_mode TEXT NOT NULL DEFAULT 'live' CHECK (ingest_mode IN ('live', 'backfill')),
  -- Time of the most recent wake-up message sent for this item.
  queued_at INTEGER,
  enqueue_attempts INTEGER NOT NULL DEFAULT 0,
  claims_returned INTEGER,
  claims_accepted INTEGER,
  UNIQUE (platform, external_id)
);
CREATE INDEX items_backlog ON items(status, ingest_mode, queued_at);
CREATE INDEX items_source_published ON items(source_id, published_at);
CREATE INDEX items_author_published ON items(author_id, published_at);
CREATE INDEX items_parent ON items(platform, parent_external_id);
CREATE INDEX items_canonical_url ON items(canonical_url);

CREATE TABLE item_links (
  item_id INTEGER NOT NULL REFERENCES items(id),
  canonical_url TEXT NOT NULL,
  PRIMARY KEY (item_id, canonical_url)
);
CREATE INDEX item_links_url ON item_links(canonical_url);

CREATE TABLE item_metrics (
  item_id INTEGER NOT NULL REFERENCES items(id),
  captured_at INTEGER NOT NULL,
  likes INTEGER,
  reposts INTEGER,
  replies INTEGER,
  views INTEGER,
  bookmarks INTEGER,
  quotes INTEGER,
  points INTEGER,
  comments INTEGER,
  PRIMARY KEY (item_id, captured_at)
);
