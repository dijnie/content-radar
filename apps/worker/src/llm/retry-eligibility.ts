// Both the log and the retry endpoint check current work, even for an old attempt.
export const NEEDS_SYNTHESIS = `subject.alive = 1 AND subject.user_state != 'dismissed'
  AND subject.synthesized_hash IS NOT subject.members_hash
  AND EXISTS (SELECT 1 FROM story_claims sc WHERE sc.story_id = subject.id AND sc.active = 1)`;

export const RETRYABLE_ITEM_FAILURE = "filter_reason IN ('dead_letter','llm_rejected','enqueue_attempts_exceeded')";
