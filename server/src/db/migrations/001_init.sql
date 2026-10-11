-- ChennaiProperties AI — initial schema. Runs on PostgreSQL 15+ and PGlite.

CREATE TABLE properties (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_code        text NOT NULL UNIQUE,
  title               text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  transaction_type    text NOT NULL CHECK (transaction_type IN ('rent', 'sale')),
  property_type       text NOT NULL CHECK (property_type IN ('apartment', 'independent_house', 'villa', 'plot', 'commercial', 'other')),
  locality            text NOT NULL,
  city                text NOT NULL DEFAULT 'Chennai',
  address_public      text,
  latitude            double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude           double precision CHECK (longitude BETWEEN -180 AND 180),
  bedrooms            integer CHECK (bedrooms BETWEEN 0 AND 20),
  bathrooms           integer CHECK (bathrooms BETWEEN 0 AND 20),
  area_sqft           integer CHECK (area_sqft > 0),
  price_amount        integer NOT NULL CHECK (price_amount > 0),
  price_period        text NOT NULL CHECK (price_period IN ('monthly', 'total', 'per_sqft', 'negotiable')),
  currency            text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  furnishing          text NOT NULL DEFAULT 'unknown' CHECK (furnishing IN ('unfurnished', 'semi_furnished', 'furnished', 'unknown')),
  amenities           text[] NOT NULL DEFAULT '{}',
  parking             text NOT NULL DEFAULT 'unknown' CHECK (parking IN ('available', 'not_available', 'unknown')),
  pet_policy          text NOT NULL DEFAULT 'unknown' CHECK (pet_policy IN ('allowed', 'not_allowed', 'case_by_case', 'unknown')),
  availability_status text NOT NULL DEFAULT 'available' CHECK (availability_status IN ('available', 'pending_confirmation', 'unavailable', 'deactivated')),
  description         text,
  source_type         text NOT NULL DEFAULT 'manual' CHECK (source_type IN ('demo_seed', 'manual', 'csv_import')),
  is_demo             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deactivated_at      timestamptz,
  CHECK ((availability_status = 'deactivated') = (deactivated_at IS NOT NULL))
);
CREATE INDEX properties_search_idx ON properties (transaction_type, availability_status, locality);
CREATE INDEX properties_price_idx ON properties (price_amount);
CREATE INDEX properties_bedrooms_idx ON properties (bedrooms);

CREATE TABLE property_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties (id) ON DELETE CASCADE,
  image_url   text NOT NULL CHECK (image_url ~ '^(https?://|/)[^\s]+$'),
  alt_text    text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX property_images_property_idx ON property_images (property_id, sort_order);

CREATE TABLE customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_channel   text NOT NULL CHECK (external_channel IN ('web', 'whatsapp')),
  external_user_id   text NOT NULL,
  display_name       text,
  phone              text,
  preferred_language text,
  consent_status     text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown', 'granted', 'withdrawn')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_contact_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (external_channel, external_user_id)
);

CREATE TABLE conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  channel            text NOT NULL CHECK (channel IN ('web', 'whatsapp')),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  agent_takeover     boolean NOT NULL DEFAULT false,
  -- sha256 of the anonymous web session token; null for channels that authenticate differently.
  session_token_hash text UNIQUE,
  -- Ordered property IDs from the latest result set, used to resolve "the second one".
  last_result_ids    uuid[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  last_message_at    timestamptz
);
CREATE INDEX conversations_customer_idx ON conversations (customer_id);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  provider_message_id text,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type        text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'system')),
  body                text NOT NULL,
  metadata_json       jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX messages_provider_id_uniq ON messages (conversation_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE customer_requirements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL UNIQUE REFERENCES conversations (id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  transaction_type  text CHECK (transaction_type IN ('rent', 'sale')),
  locality_terms    text[] NOT NULL DEFAULT '{}',
  budget_min        integer CHECK (budget_min >= 0),
  budget_max        integer CHECK (budget_max > 0),
  bedrooms          integer CHECK (bedrooms BETWEEN 0 AND 20),
  property_type     text CHECK (property_type IN ('apartment', 'independent_house', 'villa', 'plot', 'commercial', 'other')),
  furnishing        text CHECK (furnishing IN ('unfurnished', 'semi_furnished', 'furnished')),
  parking_required  boolean,
  pets_required     boolean,
  amenities         text[] NOT NULL DEFAULT '{}',
  extra_preferences jsonb NOT NULL DEFAULT '{}',
  confidence_json   jsonb NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shortlists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  property_id     uuid NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, conversation_id, property_id)
);

CREATE TABLE leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  conversation_id    uuid REFERENCES conversations (id) ON DELETE SET NULL,
  -- RESTRICT: listings are deactivated, never deleted, so historical lead links stay valid.
  property_id        uuid REFERENCES properties (id) ON DELETE RESTRICT,
  enquiry_type       text NOT NULL CHECK (enquiry_type IN ('callback', 'site_visit', 'general')),
  status             text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'visit_requested', 'qualified', 'closed', 'spam')),
  -- Customer's requested time only. Nothing in this system confirms a visit.
  preferred_visit_at timestamptz,
  preferred_time_text text,
  assigned_agent     text,
  notes              text,
  idempotency_key    text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_status_idx ON leads (status, created_at DESC);

CREATE TABLE admin_users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_provider    text NOT NULL DEFAULT 'local',
  auth_provider_id text NOT NULL,
  email            text NOT NULL UNIQUE,
  display_name     text NOT NULL,
  role             text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'agent')),
  -- scrypt hash (local provider only). Never plaintext.
  password_hash    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz,
  UNIQUE (auth_provider, auth_provider_id)
);

CREATE TABLE admin_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type   text NOT NULL CHECK (actor_type IN ('admin', 'customer', 'system')),
  actor_id     text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  details_json jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);

-- Configured business facts the assistant may quote. Unknown topics are escalated.
CREATE TABLE business_faqs (
  key        text PRIMARY KEY,
  question   text NOT NULL,
  answer     text NOT NULL,
  is_demo    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
