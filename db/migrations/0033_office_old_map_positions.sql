UPDATE office_layouts
SET width = 50, height = 32, updated_at = timezone('UTC'::text, now())
WHERE width = 60 AND height = 40 AND elements = '[]'::jsonb
  AND NOT EXISTS (SELECT 1 FROM desks WHERE desks.layout_id = office_layouts.id AND desks.x IS NOT NULL);

UPDATE desks
SET x = old.x, y = old.y, width = 8, height = 4, rotation = 0, updated_at = timezone('UTC'::text, now())
FROM (VALUES
    ('T1', 13, 5), ('T2', 23, 5), ('T3', 33, 5),
    ('T4', 13, 10), ('T5', 23, 10), ('T6', 33, 10),
    ('B1', 4, 20), ('B2', 13, 20),
    ('B3', 4, 25), ('B4', 13, 25),
    ('Agata', 28, 22), ('Franek', 38, 22)
) AS old(label, x, y)
WHERE desks.label = old.label AND desks.x IS NULL AND desks.y IS NULL;

UPDATE desks
SET equipment = array_replace(array_replace(equipment, 'mac_mini', 'mac mini'), 'no_monitor', 'brak monitora')
WHERE equipment && ARRAY['mac_mini', 'no_monitor']::varchar[];
