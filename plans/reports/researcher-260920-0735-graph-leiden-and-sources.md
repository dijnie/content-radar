# Research: Graph/Clustering Method and Public Source Access for Content Radar

Date: 2026-09-20. Scope: contract in `brainstorm-260920-0730-content-radar-contract.md`, Part A (graph/clustering) and Part B (source access), questions 1-10. All npm/GitHub data pulled live today via `npm view`, GitHub REST API, and direct HTTP probes; web search used for anything not directly inspectable. This is research only; no product code was written.

## TL;DR recommendation

- **Leiden library**: `ngraph.leiden` (anvaka) as primary — only option with both modularity and CPM, weighted edges, seeded RNG, credible maintainer. Fallback: `leiden-ts` (weaker adoption but the most rigorously tested source I inspected). Safety net if both misbehave: `graphology-communities-louvain` (mature, 148k dl/week) plus a cheap post-hoc well-connectedness split.
- **Graph model**: claim-claim similarity graph (embedding cosine + IDF-weighted shared-entity boost, sliding time window), clustered with Leiden/CPM, not raw entity co-occurrence.
- **Identity tracking**: two-threshold Jaccard matching between snapshot community member-sets (Greene et al. 2010 style), with a lookback window before declaring death.
- **Scoring**: transparent weighted linear sum of six normalized sub-scores, default weights 0.30/0.20/0.15/0.10/0.15/0.10, calibrated later against the analyst's Save/Dismiss/Written actions logged in D1.
- **Sources**: FxTwitter timeline API is solid and Workers-friendly; Nitter is now confirmed dead (X Corp cease-and-desist, Aug 2026), removing it as a fallback entirely. Reddit's free/no-account path effectively closed in 2026 (`.json` returns 403, OAuth self-service closed Nov 2025) — this is now the weakest link in the source list, not a settled fallback. HN and GitHub unauthenticated access both verified live and workable within their documented/observed limits.

---

## Part A — Graph and clustering

### Q1. JS/TS Leiden library evaluation

| Package | Published | Downloads/wk | GitHub stars | License | Weighted | Resolution param | Quality fn | Seeded RNG | Workers-ready |
|---|---|---|---|---|---|---|---|---|---|
| `leiden-ts` | 0.1.0, 2026-04-26 (single release) | 363 | 2 | MIT | Yes (Float64Array weights) | Yes | Modularity only (CPM "planned") | Yes, xoshiro128** | Yes (zero runtime deps, dual ESM/CJS) |
| `@aflsolutions/graphology-communities-leiden` | 1.1.1, ~2026-05 | 3,041 | 1 | MIT | Yes (`weighted` flag) | Yes | Modularity only | Via injectable `rng` param | Yes (deps are pure-JS graphology-ecosystem packages) |
| `ngraph.leiden` | 0.3.0, ~2026-06 | 1,230 | 3 | MIT | Yes (`linkWeight` fn) | Yes (CPM gamma) | Modularity **and** CPM | Yes, `randomSeed` default 42 | Yes for the library import; CLI `bin` uses Node `fs`, so import the module entry point, not the bin |
| `graphology-communities-louvain` (fallback) | 2.0.2, official graphology monorepo | 148,092 | (part of graphology, high adoption) | MIT | Yes | Yes | Modularity only, Louvain not Leiden | Via injectable `rng` | Yes |

Details and provenance:

- **`leiden-ts`** (github.com/crodesrepos/leiden-ts): solo maintainer, repo created 2026-04-26, only 4 commits, 2 stars. Its "0 open issues" README-style claim is stale — the live GitHub API shows 7 open issues, but all seven are Dependabot version-bump PRs, not real bugs. Despite the thin adoption, the source tree is unusually rigorous for its size: property-based tests (`fast-check`), a `bench/compare` harness that cross-validates output against a Python `graspologic` reference implementation on karate-club, football, and LFR benchmark graphs, with checked-in reference outputs. Zero runtime dependencies, `engines.node >= 20.10` is just an npm metadata hint and does not block the Workers runtime. No CPM support yet.
- **`@aflsolutions/graphology-communities-leiden`**: an unofficial third-party repackage of the `communities-leiden` directory that has existed inside the official `graphology` monorepo since at least mid-2025 but was never published under the official `graphology-communities-leiden` name. The upstream GitHub issue asking why ([graphology/graphology#543](https://github.com/graphology/graphology/issues/543), opened 2025-05-29) has no maintainer response as of this research — i.e., the official Leiden support has been stalled for well over a year. The aflsolutions fork's algorithm code is therefore likely the real graphology-authored implementation, but its packaging, versioning, and future syncing with upstream are not officially maintained. Its own README claims a `maxIterations` cap gives "5-10x faster runtime for <2% modularity loss" on 100k+ node graphs — this is an unverified vendor claim I could not independently confirm.
- **`ngraph.leiden`** (github.com/anvaka/ngraph.leiden): by anvaka, the established maintainer of the widely-used `ngraph.*` graph/visualization ecosystem — the strongest maintainer credibility signal of the three despite low star count (young package, created 2025-08). Supports both modularity and CPM, which matters for Q2's hub-entity problem. Depends on `ngraph.fromdot`/`ngraph.todot`/`ngraph.random`, all pure-JS string (de)serializers; Node `fs` is only touched by the CLI binary, not the importable API.
- **Fallback — `graphology-communities-louvain`**: official, extremely mature (148k downloads/week), zero non-graphology dependencies, weighted + resolution + seedable RNG. It runs Louvain, not Leiden, so it lacks Leiden's guarantee that every community is internally well-connected; pair it with a cheap post-check (split any community whose induced subgraph has more than one connected component) to approximate that guarantee if this library is used as the safety net.

**Recommendation**: primary `ngraph.leiden` (best feature match, most credible maintainer); fallback `leiden-ts` (best-tested code, but modularity-only and single-maintainer risk); `graphology-communities-louvain` as the safety net if both Leiden libraries misbehave in production, given its adoption and stability. Because all three Leiden options are young and low-adoption, regardless of which is chosen, validate it against `leiden-ts`'s own public `bench/compare/ref` fixtures (karate club, football, LFR, all with Python-`graspologic` reference outputs) as an acceptance test before trusting it for lineage-critical clustering.

**In-house minimal Leiden cost, if all three are unfit**: the algorithm (local-moving phase + refinement phase that splits ill-connected sub-communities + aggregation, per Traag, Waltman & van Eck, 2019) is well-specified with full pseudocode in the original paper and is not large — a correct minimal implementation (local move, refine, aggregate, modularity/CPM quality function, one seeded PRNG such as `xoshiro128**` or `mulberry32`, ~20 lines) is realistically 300-600 lines of TypeScript. At the project's expected scale (thousands, not millions, of nodes per run) this is buildable and property-testable by one developer in roughly 2-4 focused days, reusing `leiden-ts`'s public reference fixtures as a correctness oracle rather than deriving new ones.

### Q2. Graph model for claim clustering

| Model | Fit for short social posts | Hub-entity risk | Complexity |
|---|---|---|---|
| (a) Entity co-occurrence | Weak — collapses distinct events that merely share an entity | High — "OpenAI"/"LLM" glue everything | Low |
| (b) Claim-claim similarity (embedding cosine kNN + shared-entity boost) | Strong — a "story" is naturally a set of claims about the same event, so claims are the right node unit | Moderate, controllable via IDF-weighting and time window | Medium (needs embeddings + kNN) |
| (c) Bipartite claim-entity, projected or clustered directly | Correct in principle but no ready-made JS library does direct bipartite Leiden; projecting is mathematically the same weighting problem as (a)/(b) with extra engineering | Same as (a) once projected | High |

**Recommendation**: model (b), claim-claim graph. Nodes are claims; edge weight = `w1 * cosine(embedding_i, embedding_j) + w2 * idf_weighted_entity_overlap(i, j)`, edges only created within a sliding time window (e.g., 72h-7 days depending on topic; this is also the natural place to implement time decay, since older claims simply fall out of the window rather than needing a separate decay term in the edge weight). IDF-weighting the entity-overlap term (down-weighting entities that appear in many claims, e.g. "AI", "LLM", the way TF-IDF down-weights common words) is the direct fix for the hub-entity glue problem, combined with excluding a small manually curated stopword-entity list from the boost term entirely. Prefer **CPM over modularity** as the quality function for the chosen Leiden library: CPM has no global resolution limit (its density threshold gamma is a local, tunable parameter), so a tuned gamma naturally resists the loosely-connected giant communities that a hub entity would otherwise cause under modularity. `ngraph.leiden` is the only surveyed library offering CPM. As general guidance, run Leiden at a few gamma values and check community-count stability rather than trusting a single gamma=1 modularity number.

Sources: [From Louvain to Leiden: guaranteeing well-connected communities](https://arxiv.org/pdf/1810.08473) (Traag, Waltman, van Eck 2019 — origin paper, CPM vs. modularity discussion); [Well-Connected Communities in Real-World and Synthetic Networks](https://arxiv.org/pdf/2303.02813); [Embed2Detect: Temporally Clustered Embedded Words for Event Detection in Social Media](https://arxiv.org/pdf/2006.05908) (co-occurrence-based event detection precedent); [Named Entity-Driven Graph Smoothing to Enhance Pretrained Document Embeddings in Clustering Tasks](https://doi.org/10.1145/3805712.3809879).

### Q3. Stable community identity across runs

None of the three surveyed JS Leiden libraries document an "initial partition" warm-start parameter (the way Python `leidenalg` supports `initial_membership`) — this should be re-checked against the exact chosen library's API once selected, but as surveyed, warm-starting is not directly available, so identity must be recovered by **post-hoc matching**, per Greene et al. (2010), "Tracking the Evolution of Communities in Dynamic Social Networks" (ASONAM'10). Concrete, solo-developer-implementable algorithm:

1. After each run, store each community as a member-id set (claim ids or canonical entity ids) tagged with a `snapshot_id`.
2. For every new community `C_new` at time t, compute Jaccard similarity against every community `C_old` alive within the last K snapshots (K=2-3, so a lineage surviving one quiet run is not falsely killed). Only compare pairs that share at least one member, so this stays cheap even at scale.
3. Classify using two thresholds (defaults; treat as tunable config, calibrate later against real data):
   - Jaccard ≥ 0.5 and it is the mutually-best match on both sides → **CONTINUE** (carry forward the same `lineage_id`).
   - One `C_old` best-matches several `C_new` each at Jaccard ≥ 0.3 → **SPLIT** (new lineage ids for each child, `parent_lineage_id` set).
   - Several `C_old` all best-match one `C_new` at Jaccard ≥ 0.3 → **MERGE** (new lineage id, multiple `parent_lineage_id` rows).
   - Best match < 0.3 for all `C_old` → **BIRTH** (new lineage id).
   - A `C_old` with no qualifying match for more than K consecutive snapshots → **DEATH**.
4. Persist every event (`birth`/`split`/`merge`/`death`/`continue`) into the `community_lineage` table required by the contract's acceptance criteria.

This is the same two-tier scheme used in the practical dynamic-community-detection literature; see the survey for corroboration of the approach and typical threshold ranges. Source: [Tracking the Evolution of Communities in Dynamic Social Networks (Greene et al. 2010, PDF)](http://derekgreene.com/papers/greene10tracking.pdf); [Community Discovery in Dynamic Networks: a Survey](https://arxiv.org/pdf/1707.03186) (Rossetti & Cazabet, covers Palla et al. 2007 alternative and confirms Jaccard-matching is the standard practical baseline).

### Q4. Entity canonicalization on a budget

Proposed data model:

- `entities(id, canonical_name, type, parent_entity_id NULL, created_at)` — `parent_entity_id` links a version to its family (e.g. "DeepSeek V4 Flash" → family "DeepSeek").
- `entity_aliases(id, entity_id, alias_text, alias_normalized, source ENUM(manual, embedding, llm), confidence)`.
- `entity_relations(id, entity_id, related_entity_id, relation_type ENUM(version_of, successor_of))` — kept separate from `parent_entity_id` so "family" grouping (for display rollups) and "temporal succession" (V4 → V4.1) don't get conflated into one pointer; graph edges/clustering always use the specific canonical entity id, never the family id, so version-like entities stay distinct nodes as required.

Resolution ladder (cheapest first, matching the general industry pattern of scoped exact match → alias → embedding → LLM adjudication):

1. Normalize (lowercase, strip punctuation/diacritics, collapse whitespace).
2. Exact lookup in `entity_aliases` (deterministic, free) — this is where curated fixes like "MCP" ↔ "Model Context Protocol" live.
3. If no alias hit, embedding similarity search against existing canonical entity names/descriptions; take the top candidate.
4. Auto-accept as alias if similarity is very high (e.g. > 0.92, threshold to calibrate); auto-create as new distinct entity if very low (< 0.75); only the **ambiguous middle band** (0.75-0.92) is sent to Gemini for a single adjudication call ("same / parent-child-version / different"), which is the "LLM adjudication only for ambiguous pairs" budget constraint.

Sources: [Entity resolution · CocoIndex Docs](https://cocoindex.io/docs/ops/entity_resolution/) (embedding + LLM pair-resolver pattern); [Entity resolution with Elasticsearch & LLMs](https://www.elastic.co/search-labs/blog/entity-resolution-llm-elasticsearch) (similarity-gated LLM reconciliation, deterministic scoring preferred for explainability).

### Q5. Scoring formula

**Independent source, defined rigorously**: two claims count as independent sources only if all hold: (1) different author after author-alias resolution (the same person posting to X and to their own blog is one source, not two — maintain an author-alias table analogous to entity aliases); (2) neither is a repost/quote of the other (detect via FxTwitter's `reposted_by`/quote metadata, plus a near-duplicate-text fallback); (3) neither is an article whose evidence text links to or paraphrases the other's canonical URL as its cited origin. Implement via a `claims.derived_from_claim_id` column populated from platform metadata first, then near-duplicate/URL-citation detection; `independent_source_count` = number of distinct author-canonical-ids among claims in the story whose derivation chain resolves to distinct roots.

**Formula** (transparent weighted linear sum, scaled to 0-100, avoids an opaque ML model per the project's "deterministic core" constraint):

```
score = 100 * clip(0.30*S_sources + 0.20*S_velocity + 0.15*S_specificity
                    + 0.10*S_counter + 0.15*S_novelty + 0.10*S_recency, 0, 1)
```

- `S_sources = min(1, log2(1+independent_source_count) / log2(1+5))` — diminishing returns past ~5 sources.
- `S_velocity = sigmoid(robust_z)`, `robust_z = (engagement_rate - author_median) / (1.4826 * author_MAD)`, computed against that author's own trailing-N-post baseline (robust to the fact that different authors have wildly different absolute follower/engagement scales, and MAD-based scaling is standard practice for outlier-resistant baselining).
- `S_specificity` = rule-based fraction of evidence lines containing a number/measurement/benchmark name or a first-hand marker phrase ("we tested", "in our benchmark"), capped at 1.0.
- `S_counter` = 1 if the story has ≥1 COUNTER-labeled claim, else 0 (binary, matching the product spec's existing counterpoint flag).
- `S_novelty = 1 - max_cosine_similarity` of this story's centroid embedding against other **currently active, different-lineage** stories in the last 30 days (deliberately excludes the story's own historical snapshots, so an ongoing story is not penalized for continuing).
- `S_recency = exp(-lambda * hours_since_latest_claim)`, `lambda` tuned per topic for a configurable half-life (default ~48h).

**Calibration**: log every sub-score alongside the analyst's Save/Dismiss/Written action in D1; after accumulating enough labeled decisions (rough rule of thumb: 50-100), do an offline grid-search or simple logistic-regression fit over `w1..w6` against the labels, and check the result in as a new versioned constants file — a config-value change, not a learned-model artifact, keeping the deterministic-core constraint intact.

Source for the MAD-based robust z-score: [Robust Z-Score Method](https://cloudxlab.com/assessment/displayslide/6286/robust-z-score-method); [Robust z-score derivation, corrections and scaling](https://gps-orfeome.readthedocs.io/en/latest/zscores.html) (1.4826 consistency constant). Source for cross-source dedup precedent: [Story clustering, NewsBlur](https://blog.newsblur.com/2026/03/18/story-clustering/); [Optimizing News Aggregation: Clustering & Deduplication, Feedly Engineering](https://feedly.com/engineering/posts/reducing-clustering-latency).

---

## Part B — Source access

### Q6. X via FxTwitter / Syndication / Nitter

Live-probed today (2026-09-20) with an identifying User-Agent, a handful of GET requests total:

| Endpoint | Status | Notes |
|---|---|---|
| `GET api.fxtwitter.com/2/profile/{handle}/statuses` | 200 | Confirms contract's prior probe: 20 results/call, `cursor.top`/`cursor.bottom` for pagination. `results[]` fields include `type, url, id, text, raw_text, author, replies, reposts, likes, bookmarks, quotes, views, created_at, media, card, is_note_tweet, community_note, replying_to, reposted_by`. No `X-RateLimit-*` headers and no `Cache-Control` header were present on the response — no documented numeric quota found on `docs.fxembed.com` either; treat quota as unpublished and self-impose politeness (cache aggressively, back off on non-200). |
| `GET api.fxtwitter.com/{handle}/status/{id}` | 200 (tested against an old low-numbered id) | Confirms the per-tweet backfill endpoint works. |
| `GET fxtwitter.com/{handle}/feed.xml` | 200, valid RSS 2.0 | Correct RSS path (not `/rss`, which 302-redirects). |
| `GET cdn.syndication.twimg.com/tweet-result?id=..&token=..` | 404 without a valid token in this probe | Consistent with the contract's already-probed finding (favorite_count/conversation_count only); Syndication is an unofficial, reverse-engineered embed backend with no public documentation or ToS, and is inherently the most fragile of the four fallback tiers. |
| Nitter (`nitter.net`, `xcancel.com`) | Dead | **Update to the contract**: X Corp sent cease-and-desist letters to the Nitter project and public instances on 2026-08-24; `nitter.net` and `xcancel.com` both went offline days later. `xcancel.com`'s homepage has since reappeared but profile pages sit behind a bot-verification wall. Nitter should be **removed** as a fallback option, not just marked "unreachable in this probe" — it is now confirmed structurally gone, corroborating the contract's own "single point of failure" risk note. |

Self-hosting escape hatch: the project (renamed FxEmbed, MIT license, powers FxTwitter/FixupX/FxBluesky) is explicitly documented as self-hostable as a Cloudflare Worker (`github.com/FixTweet/FxTwitter`, docs at `docs.fxembed.com`); I could not pull the exact deploy-step content through automated fetching, but the self-hosting path's existence is confirmed. Cloudflare-Workers-egress-blocking of FxTwitter: **unverified** — no reports found either way, and since FxTwitter's own infrastructure runs on Cloudflare (observed `server: cloudflare` header), there is no structural reason it would block Cloudflare-origin traffic.

### Q7. Reddit without OAuth

**This materially changes the contract's assumption of a "no-account" fallback.** As of 2026, both of the previously-free-and-anonymous paths are gone:

- Reddit deprecated unauthenticated `.json` endpoints around 2026-05-28, now returning 403; multiple independent reports describe TLS-fingerprinting and datacenter/cloud-IP flagging as the enforcement mechanism (generic HTTP clients and hosts like GitHub Actions/Vercel are specifically called out as blocked even with correct headers), corroborated by Hacker News discussion threads from May 2026 (`item?id=48124291`, `item?id=48329557`).
- Self-service OAuth app registration closed under Reddit's official **Responsible Builder Policy** (`support.reddithelp.com/hc/en-us/articles/42728983564564`) since November 2025; new API access — including "personal hobby projects" — now requires a manual application with a reported 2-4 week approval turnaround, i.e., it is no longer a same-day, no-friction "free OAuth script app" as the user's stated preference assumes.
- The historically-quoted free tier (100 QPM per OAuth client) may still apply post-approval, but this is not independently confirmed in an official source for 2026.

**Could not directly re-probe**: this research sandbox's network egress blackholes `reddit.com` and `medium.com` at the DNS level (both resolve to `127.0.0.1` here), so the above is based entirely on external web-search corroboration (official Reddit Help Center policy page + several independent blog reports + HN threads), not a first-party live probe. This makes the contract's own open question #2 ("probe Reddit from an actual Worker") more urgent than a nice-to-have — recommend it be the very first phase-1 spike, since Reddit may need to be dropped from the v1 source list or replaced with a manually-approved OAuth app (which contradicts the "no accounts" preference and should go back to the user as a decision, not be resolved unilaterally here).

### Q8. Hacker News

Both live-probed successfully today:

- **Algolia HN Search API**: `GET hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points>20` returns 200 with `hits[]` containing `objectID, title, url, author, points, num_comments, created_at, created_at_i, story_id, children, _tags`. `tags=comment,story_<id>` (also live-tested) returns all comments under a story — the cheapest way to source counterpoint material, since HN commenters explicitly rebut claims. No documented numeric rate limit was found in the reachable docs (`hn.algolia.com/api`); it is a free, keyless, community-relied-upon service, so self-impose a modest polling cadence.
- **Official Firebase API**: `GET hacker-news.firebaseio.com/v0/item/{id}.json` live-tested, 200. Useful for polling a small, already-known set of ids for live vote counts, but Algolia is far cheaper for filtered/date-range discovery since it avoids one-request-per-id.

### Q9. GitHub

Live-probed via `api.github.com/rate_limit` today: unauthenticated **core = 60 requests/hour**, **search = 10 requests/minute** (matches GitHub's published documentation). A free classic or fine-grained Personal Access Token (no billing, no paid tier) raises core to **5,000/hour**; the search sub-limit only rises to 30/min even with a token — search has its own lower ceiling regardless of auth. `GET github.com/{owner}/{repo}/releases.atom` was live-tested (200) and does not count against the REST rate limit, making it the cheapest way to poll releases. GitHub has **no official trending API** (confirmed via search — no REST/GraphQL equivalent exists); the two workable options are (a) Search API sorted by stars with `created:>DATE`/`pushed:>DATE` qualifiers as a trending proxy (counts against the 10-30/min search limit), or (b) third-party mirrors that scrape `github.com/trending` themselves (e.g. `mshibanami/GitHubTrendingRSS`) — these are small, low-adoption hobby projects with the same fragility profile as the Leiden libraries in Q1; my direct probe of one candidate feed path 404'd, so exact file paths must be re-verified at implementation time. Treat any such mirror as a bonus source, not load-bearing. Note: using a free GitHub PAT requires a GitHub account, which technically conflicts with the "no accounts" source constraint — flagged as an open question rather than decided here, since it's arguably crawler infrastructure auth rather than a monitored "source" account.

### Q10. Blog/RSS starter list

All feeds below were live-probed today (HTTP 200 confirmed) unless noted. AI/labs (19):

| Feed | URL |
|---|---|
| OpenAI News | `openai.com/news/rss.xml` |
| Google DeepMind Blog | `deepmind.google/blog/rss.xml` |
| Google Research Blog | `blog.research.google/feeds/posts/default` |
| Hugging Face Blog | `huggingface.co/blog/feed.xml` |
| Stability AI News | `stability.ai/news?format=rss` |
| Cohere Blog | `cohere.com/blog/rss.xml` |
| Microsoft Research | `microsoft.com/en-us/research/feed/` |
| AWS ML Blog | `aws.amazon.com/blogs/machine-learning/feed/` |
| NVIDIA Blog | `blogs.nvidia.com/feed/` |
| Berkeley BAIR | `bair.berkeley.edu/blog/feed.xml` |
| MIT News (AI topic) | `news.mit.edu/rss/topic/artificial-intelligence2` |
| Together AI Blog | `together.ai/blog/rss.xml` |
| LangChain Blog | `blog.langchain.dev/rss/` |
| Simon Willison | `simonwillison.net/atom/everything/` |
| Interconnects (N. Lambert) | `interconnects.ai/feed` |
| Latent Space | `latent.space/feed` |
| Anthropic News (unofficial mirror, no official feed exists) | `tim-hilde.github.io/anthropic-rss/rss.xml` |
| Anthropic Engineering (unofficial mirror) | `conoro.github.io/anthropic-engineering-rss-feed/anthropic_engineering_rss.xml` |
| Meta AI, DeepSeek, Mistral | No RSS found (`ai.meta.com/blog/rss.xml`, `deepseek.com/rss.xml`, `mistral.ai/news/rss.xml` all 404) — monitor via their X/GitHub-releases channels instead. |

System Design / Backend (20, all live 200 except where noted):

| Feed | URL |
|---|---|
| Martin Fowler | `martinfowler.com/feed.atom` |
| AWS Architecture Blog | `aws.amazon.com/blogs/architecture/feed/` |
| Netflix Tech Blog | `netflixtechblog.com/feed` |
| Cloudflare Blog | `blog.cloudflare.com/rss/` |
| Discord Blog | `discord.com/blog/rss.xml` |
| Dropbox Tech | `dropbox.tech/feed` |
| Shopify Engineering | `shopify.engineering/blog.atom` |
| Spotify Engineering | `engineering.atspotify.com/feed/` |
| Slack Engineering | `slack.engineering/feed/` |
| GitHub Blog (Engineering) | `github.blog/engineering.atom` |
| Meta Engineering | `engineering.fb.com/feed/` |
| ByteByteGo | `blog.bytebytego.com/feed` |
| The Pragmatic Engineer | `blog.pragmaticengineer.com/feed` |
| InfoQ | `feed.infoq.com/` |
| Brendan Gregg | `brendangregg.com/blog/rss.xml` |
| Julia Evans | `jvns.ca/atom.xml` |
| Marc Brooker (AWS) | `brooker.co.za/blog/rss.xml` |
| All Things Distributed (Werner Vogels) | `allthingsdistributed.com/atom.xml` |
| Stripe Blog | `stripe.com/blog/feed.rss` |
| LinkedIn Engineering | `linkedin.com/blog/engineering/feed` |
| Uber Engineering | `uber.com/blog/engineering/rss/` returns HTTP 406 to a scripted client even with a browser User-Agent from this environment — likely bot/TLS-fingerprint filtering similar to Reddit's; needs testing from an actual Worker before relying on it. |
| High Scalability, Airbnb Engineering, Pinterest Engineering | Not reachable from this environment: `highscalability.com` feed path 404 (site may have moved/retired its feed), and Medium-hosted feeds (`medium.com/feed/...`) could not be tested at all — this sandbox blackholes `medium.com` at DNS level, same as `reddit.com`. Re-verify both from the real deployment environment. |

Most of the above return full article text in the feed (typical for tech/engineering blogs); a few (notably vendor news pages like OpenAI/NVIDIA) return summary-only and need full-text fetch. **Workers-friendly extraction**: use the native `HTMLRewriter` API first (streaming SAX-style parser, no DOM allocation, cheap on CPU/bundle size) — there is a purpose-built reimplementation of Mozilla's Readability using `HTMLRewriter` specifically for Workers (`github.com/akira108/html-rewriter-readability`). Fall back to a full DOM-based Readability port (`@mozilla/readability` + a lightweight DOM shim like `linkedom`) only for pages the HTMLRewriter heuristic extracts poorly, since that path buffers the whole document and costs meaningfully more CPU/bundle size per the community writeups found.

---

## Sources

- [leiden-ts on GitHub](https://github.com/crodesrepos/leiden-ts), npm `leiden-ts`, live GitHub API pull 2026-09-20.
- [@aflsolutions/graphology-communities-leiden on GitHub](https://github.com/aflsolutions/graphology-communities-leiden), npm registry, live pull 2026-09-20.
- [ngraph.leiden on GitHub](https://github.com/anvaka/ngraph.leiden), npm registry, live pull 2026-09-20.
- [graphology/graphology issue #543 — "Leiden communities?"](https://github.com/graphology/graphology/issues/543).
- [graphology-communities-louvain on npm](https://www.npmjs.com/package/graphology-communities-louvain), npm downloads API.
- [From Louvain to Leiden: guaranteeing well-connected communities (Traag, Waltman, van Eck 2019)](https://arxiv.org/pdf/1810.08473).
- [Well-Connected Communities in Real-World and Synthetic Networks](https://arxiv.org/pdf/2303.02813).
- [Tracking the Evolution of Communities in Dynamic Social Networks (Greene et al. 2010, PDF)](http://derekgreene.com/papers/greene10tracking.pdf).
- [Community Discovery in Dynamic Networks: a Survey](https://arxiv.org/pdf/1707.03186).
- [Entity resolution · CocoIndex Docs](https://cocoindex.io/docs/ops/entity_resolution/); [Elastic entity resolution with LLMs](https://www.elastic.co/search-labs/blog/entity-resolution-llm-elasticsearch).
- [Robust Z-Score Method, CloudxLab](https://cloudxlab.com/assessment/displayslide/6286/robust-z-score-method); [Robust z-score derivation, GPSW docs](https://gps-orfeome.readthedocs.io/en/latest/zscores.html).
- [Story clustering, NewsBlur Blog](https://blog.newsblur.com/2026/03/18/story-clustering/); [Feedly Engineering: reducing clustering latency](https://feedly.com/engineering/posts/reducing-clustering-latency).
- [FixTweet/FxTwitter on GitHub](https://github.com/FixTweet/FxTwitter); `docs.fxembed.com`; live probes of `api.fxtwitter.com`, `fxtwitter.com`, `cdn.syndication.twimg.com` on 2026-09-20.
- [Nitter cease-and-desist coverage aggregated via web search, Sept 2026]; Nitter Instance Health `status.d420.de`.
- [Reddit Responsible Builder Policy — official Reddit Help Center](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy); Hacker News threads `item?id=48124291`, `item?id=48329557` (May 2026); multiple third-party scraping-vendor blog posts on the 2026 `.json` deprecation (lower-authority, used only for corroborating detail, not as the primary claim).
- Live probes of `hn.algolia.com`, `hacker-news.firebaseio.com`, `api.github.com` on 2026-09-20.
- [html-rewriter-readability on GitHub](https://github.com/akira108/html-rewriter-readability); [HTMLRewriter · Cloudflare Workers docs](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/); [How To Use HTMLRewriter for Web Scraping](https://qwtel.com/posts/software/how-to-use-htmlrewriter-for-web-scraping/).
- Live reachability probes of ~40 candidate RSS feeds on 2026-09-20 (see Q10 table).

## Unverified / could not confirm

- Exact published rate limit (RPM/RPD) for FxTwitter's timeline API — no numeric quota found in accessible docs, and no rate-limit headers observed in a live probe.
- Whether Cloudflare Workers egress IPs specifically are blocked by FxTwitter, Reddit, or X's Syndication CDN — no direct reports found either way; the contract's own open question #2 (probe from a real Worker) remains the only way to know for Reddit and Syndication.
- Reddit's current `.json`/`.rss` blocking behavior could not be re-verified by direct probe from this research environment: `reddit.com` (and `medium.com`) resolve to `127.0.0.1` in this sandbox's network policy, so all Reddit findings rest on external web-search corroboration rather than a first-party check.
- Exact numeric rate limit for the Algolia HN Search API — no published ceiling found; treated as a free, keyless, community-relied-upon service.
- `@aflsolutions/graphology-communities-leiden`'s README performance claim ("5-10x faster, <2% quality loss with maxIterations:3 on 100k+ node graphs") — vendor-stated, not independently reproduced here.
- Exact file paths for third-party GitHub-trending RSS mirrors (one candidate 404'd on probe) — needs re-verification at implementation time.
- Uber Engineering's RSS feed returned HTTP 406 to every User-Agent tried here — unclear if this is bot-fingerprint blocking (like Reddit's) or something else; untested from an actual Cloudflare Worker.
- High Scalability's and any Medium-hosted engineering blogs' (Airbnb, Pinterest) current feed URLs — `medium.com` was unreachable from this sandbox, so these need re-verification from the real deployment environment.

## Unresolved questions

1. Reddit access now genuinely requires either a manually-approved OAuth app (2-4 week turnaround, breaking the "no accounts" preference) or being dropped from the v1 source list — this decision should go back to the user rather than being resolved unilaterally in this research.
2. Whether using a free GitHub Personal Access Token for the GitHub adapter (raises rate limit from 60/hour to 5,000/hour) is acceptable under the "no accounts" constraint, given it requires a (free) GitHub account as crawler infrastructure rather than a monitored source account.
3. Whether Cloudflare Workers egress IPs are treated differently (blocked or throttled) by Reddit, FxTwitter, or the Syndication CDN compared to the plain HTTPS probes run from this research environment — only answerable by deploying an actual Worker, as the contract already flags.
