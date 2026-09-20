-- Is the data complete? A broken source looks exactly like a topic going quiet.
SELECT type, label, consecutive_failures, last_error, hours_since_ok
FROM v_source_health ORDER BY hours_since_ok DESC LIMIT 50;
