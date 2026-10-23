CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := timezone('UTC', now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.column_default IS NULL
      AND c.table_name NOT IN ('schema_migrations', 'ts_schema_migrations')
      AND c.table_name NOT LIKE 'oban_%'
      AND (
        (c.column_name = 'id' AND c.data_type = 'uuid')
        OR (c.column_name IN ('inserted_at', 'updated_at') AND c.data_type LIKE 'timestamp%')
      )
  LOOP
    IF col.column_name = 'id' THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DEFAULT gen_random_uuid()', col.table_name);
    ELSE
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT timezone(''UTC'', now())', col.table_name, col.column_name);
    END IF;
  END LOOP;

  FOR col IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'updated_at'
      AND c.table_name NOT LIKE 'oban_%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', col.table_name || '_set_updated_at', col.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      col.table_name || '_set_updated_at', col.table_name
    );
  END LOOP;
END
$$;
