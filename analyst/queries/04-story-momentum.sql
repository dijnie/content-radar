-- Which stories are growing, and which are fading (ratio below 1)?
SELECT story_id, label_text, headline_vi, status, score, claims_7d, claims_prev_21d, ratio
FROM v_story_momentum ORDER BY ratio DESC LIMIT 30;
