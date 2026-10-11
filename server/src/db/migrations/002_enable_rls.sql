-- Hosted Supabase exposes the public schema through its REST API (PostgREST) to anyone with the
-- project's anon/publishable key. This app never uses that API: only the Express server talks to
-- the database, as the table owner (which bypasses RLS). Enabling RLS with no policies therefore
-- denies all REST-API access while leaving the server unaffected.
ALTER TABLE properties            ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_images       ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages              ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE shortlists            ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_faqs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations     ENABLE ROW LEVEL SECURITY;
