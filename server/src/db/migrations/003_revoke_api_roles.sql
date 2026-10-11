-- Defence in depth for hosted Supabase (complements 002_enable_rls.sql).
-- Supabase grants its REST-API roles (anon, authenticated) full privileges on every public table,
-- including TRUNCATE, which RLS does not cover. This app never uses the REST API, so those roles
-- get no privileges at all, now or on tables created later. No-op where the roles don't exist
-- (local PGlite / plain PostgreSQL).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END
$$;
