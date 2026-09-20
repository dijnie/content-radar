import { cosine, normalizeEntity, resolveMention, type NearestEntity } from "@radar/core";
import { chunkedBatch } from "../db/batch";
import { addAlias, createEntity, type EntityType } from "../db/entities-repo";
import type { LlmMessage } from "../llm/messages";
import type { JobContext } from "./job-context";
import { loadEntityVectors, putVectors } from "./vector-store";

const MENTIONS_PER_RUN = 2000;
const ADJUDICATIONS_PER_MESSAGE = 20;
const ENTITY_TYPES = new Set<string>(["org", "person", "product", "model", "paper", "repo", "concept", "other"]);

interface KnownEntity {
  id: number;
  normalizedName: string;
  vector: Float32Array;
}

/**
 * Resolves every unresolved mention, cheapest rule first: exact alias, then
 * embedding similarity, and an LLM verdict only for the ambiguous band. An
 * ambiguous mention gets a provisional entity straight away, so its claims can
 * cluster now and simply re-link when the verdict arrives.
 */
export async function resolveEntitiesStep(ctx: JobContext): Promise<{ resolved: number; adjudicationsQueued: number }> {
  const { db, now } = ctx;
  const { results: groups } = await db
    .prepare("SELECT normalized, MIN(surface) AS surface, MIN(surface_type) AS surface_type FROM entity_mentions WHERE entity_id IS NULL GROUP BY normalized ORDER BY normalized LIMIT ?")
    .bind(MENTIONS_PER_RUN)
    .all<{ normalized: string; surface: string; surface_type: string | null }>();

  let resolved = 0;
  if (groups.length > 0) {
    const aliases = new Map((await db.prepare("SELECT alias_normalized, entity_id FROM entity_aliases").all<{ alias_normalized: string; entity_id: number }>()).results.map((row) => [row.alias_normalized, row.entity_id]));
    const matrix = await loadEntityVectors(db);
    const names = new Map((await db.prepare("SELECT id, canonical_name FROM entities").all<{ id: number; canonical_name: string }>()).results.map((row) => [row.id, normalizeEntity(row.canonical_name)]));
    const known: KnownEntity[] = matrix.ids.map((id, index) => ({ id, normalizedName: names.get(id) ?? "", vector: matrix.data.subarray(index * matrix.dims, (index + 1) * matrix.dims) }));

    const unknown = groups.filter((group) => !aliases.has(group.normalized));
    const embedded = unknown.length > 0 ? await ctx.embed(unknown.map((group) => group.surface)) : [];
    const vectorOf = new Map(unknown.map((group, index) => [group.normalized, embedded[index]!]));

    for (const group of groups) {
      const aliasHit = aliases.get(group.normalized) ?? null;
      const vector = vectorOf.get(group.normalized);
      let nearest: NearestEntity | null = null;
      if (aliasHit === null && vector) {
        for (const entity of known) {
          const value = cosine(vector, entity.vector);
          if (!nearest || value > nearest.cosine) nearest = { entityId: entity.id, normalizedName: entity.normalizedName, cosine: value };
        }
      }
      const decision = resolveMention(group.normalized, aliasHit, nearest, ctx.params);
      const type = (ENTITY_TYPES.has(group.surface_type ?? "") ? group.surface_type : "other") as EntityType;

      let entityId: number;
      let resolvedBy: "alias" | "embedding" | "new" | "adjudication";
      let provisional = false;
      if (decision.action === "alias") {
        entityId = decision.entityId;
        resolvedBy = decision.addAlias ? "embedding" : "alias";
        if (decision.addAlias) await addAlias(db, entityId, group.normalized, "embedding", nearest?.cosine ?? 1).run();
      } else {
        provisional = decision.action === "adjudicate";
        resolvedBy = provisional ? "adjudication" : "new";
        entityId = await createEntity(db, { canonicalName: group.surface, type, provisional, createdAt: now });
        await addAlias(db, entityId, group.normalized, "embedding").run();
        if (vector) {
          await putVectors(db, "entity_embeddings", [{ id: entityId, vector }], now);
          // Later mentions in this same run can already match the entity just created.
          known.push({ id: entityId, normalizedName: group.normalized, vector });
        }
        if (decision.action === "adjudicate") {
          await db
            .prepare(
              `INSERT INTO entity_adjudications (mention_normalized, provisional_entity_id, candidate_entity_id, similarity) VALUES (?, ?, ?, ?)
               ON CONFLICT(mention_normalized) DO NOTHING`,
            )
            .bind(group.normalized, entityId, decision.candidateEntityId, decision.similarity)
            .run();
        }
      }
      aliases.set(group.normalized, entityId);
      await db
        .prepare("UPDATE entity_mentions SET entity_id = ?, resolved_by = ?, provisional = ? WHERE normalized = ? AND entity_id IS NULL")
        .bind(entityId, resolvedBy, provisional ? 1 : 0, group.normalized)
        .run();
      resolved++;
    }
  }

  // Ledger first: rows are marked queued, then the wake-ups go out in groups of twenty.
  const { results: pending } = await db.prepare("SELECT id FROM entity_adjudications WHERE status = 'pending' ORDER BY id LIMIT 200").all<{ id: number }>();
  for (let start = 0; start < pending.length; start += ADJUDICATIONS_PER_MESSAGE) {
    const ids = pending.slice(start, start + ADJUDICATIONS_PER_MESSAGE).map((row) => row.id);
    await chunkedBatch(db, ids.map((id) => db.prepare("UPDATE entity_adjudications SET status = 'queued' WHERE id = ? AND status = 'pending'").bind(id)));
    await ctx.env.LLM_QUEUE.send({ kind: "adjudicate", adjudicationIds: ids } satisfies LlmMessage);
  }
  return { resolved, adjudicationsQueued: pending.length };
}
