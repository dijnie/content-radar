-- The way back to sources. Parameter: :story_id. Every claim you cite must come with its url from here.
SELECT claim_id, role, kind, text_vi, quote, author, platform, url, published_at, has_numbers, first_hand, derived_from_claim_id, derivation_reason
FROM v_story_evidence WHERE story_id = :story_id ORDER BY published_at;
