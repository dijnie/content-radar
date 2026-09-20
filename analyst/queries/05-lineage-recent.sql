-- Where is the conversation moving? Splits, merges, births, deaths and revivals of the last 14 days.
SELECT at, type, story_id, label_text, headline_vi, related_story_id, related_label_text, jaccard
FROM v_lineage_recent ORDER BY at DESC LIMIT 60;
