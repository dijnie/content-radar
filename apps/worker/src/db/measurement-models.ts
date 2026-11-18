import { measurementSubject } from "@radar/core";

/** Use resolved identities so aliases of the same model compare equal. Requires the outer claims alias c. */
export const MEASUREMENT_MODELS_SQL = `CASE WHEN c.kind = 'measurement' THEN
  (SELECT json_group_array(DISTINCT m.entity_id) FROM entity_mentions m
   WHERE m.claim_id = c.id AND m.surface_type = 'model' AND m.entity_id IS NOT NULL) END`;

export function storedMeasurement(text: string, models: string | null) {
  return models === null ? null : measurementSubject(text, JSON.parse(models) as number[]);
}
