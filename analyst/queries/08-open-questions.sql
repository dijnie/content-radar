-- Verification questions of strong stories that no signal covers yet.
SELECT story_id, label_text, score, status, question FROM v_open_questions ORDER BY score DESC LIMIT 40;
