UPDATE users
SET soul_node_id = (
    SELECT nodes.id FROM nodes
    WHERE nodes.user_id = users.id
    ORDER BY nodes.inserted_at, nodes.id
    LIMIT 1
)
WHERE soul_node_id IS NULL
  AND slack_id NOT LIKE 'system:%'
  AND EXISTS (SELECT 1 FROM nodes WHERE nodes.user_id = users.id);
