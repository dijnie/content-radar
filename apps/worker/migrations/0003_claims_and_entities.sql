-- Claims extracted by the LLM, entities and their aliases, and embeddings.

CREATE TABLE entities (
  id INTEGER PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('org', 'person', 'product', 'model', 'paper', 'repo', 'concept', 'other')),
  parent_entity_id INTEGER REFERENCES entities(id),
  provisional INTEGER NOT NULL DEFAULT 0 CHECK (provisional IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX entities_parent ON entities(parent_entity_id);

CREATE TABLE entity_aliases (
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  alias_normalized TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'embedding', 'llm')),
  confidence REAL NOT NULL DEFAULT 1
);
CREATE INDEX entity_aliases_entity ON entity_aliases(entity_id);

CREATE TABLE entity_relations (
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  related_entity_id INTEGER NOT NULL REFERENCES entities(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('version_of', 'successor_of')),
  PRIMARY KEY (entity_id, related_entity_id, relation_type)
);

CREATE TABLE entity_adjudications (
  id INTEGER PRIMARY KEY,
  mention_normalized TEXT NOT NULL UNIQUE,
  provisional_entity_id INTEGER NOT NULL REFERENCES entities(id),
  candidate_entity_id INTEGER NOT NULL REFERENCES entities(id),
  similarity REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'decided')),
  decision TEXT CHECK (decision IN ('same', 'version_of', 'different')),
  decided_at INTEGER
);
CREATE INDEX entity_adjudications_status ON entity_adjudications(status);

CREATE TABLE entity_embeddings (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(id),
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE claims (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  author_id INTEGER REFERENCES authors(id),
  kind TEXT NOT NULL CHECK (kind IN ('measurement', 'experience', 'announcement', 'report', 'opinion')),
  text_vi TEXT NOT NULL,
  text_en TEXT NOT NULL,
  quote TEXT NOT NULL CHECK (LENGTH(quote) <= 300),
  has_numbers INTEGER NOT NULL DEFAULT 0 CHECK (has_numbers IN (0, 1)),
  first_hand INTEGER NOT NULL DEFAULT 0 CHECK (first_hand IN (0, 1)),
  topics_json TEXT NOT NULL DEFAULT '[]',
  published_at INTEGER NOT NULL,
  -- sha256 of the normalized quote.
  content_hash TEXT NOT NULL,
  derived_from_claim_id INTEGER REFERENCES claims(id),
  -- NULL until the relation step has examined the claim.
  derivation_reason TEXT,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  llm_call_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (item_id, content_hash)
);
CREATE INDEX claims_published ON claims(published_at);
CREATE INDEX claims_author ON claims(author_id);
CREATE INDEX claims_underived ON claims(derivation_reason) WHERE derivation_reason IS NULL;

CREATE TABLE entity_mentions (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  surface TEXT NOT NULL,
  normalized TEXT NOT NULL,
  surface_type TEXT,
  entity_id INTEGER REFERENCES entities(id),
  resolved_by TEXT CHECK (resolved_by IN ('alias', 'embedding', 'new', 'adjudication')),
  provisional INTEGER NOT NULL DEFAULT 0 CHECK (provisional IN (0, 1))
);
CREATE INDEX entity_mentions_claim ON entity_mentions(claim_id);
CREATE INDEX entity_mentions_entity ON entity_mentions(entity_id);
CREATE INDEX entity_mentions_unresolved ON entity_mentions(id) WHERE entity_id IS NULL;

CREATE TABLE claim_embeddings (
  claim_id INTEGER PRIMARY KEY REFERENCES claims(id),
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
