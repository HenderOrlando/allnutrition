-- Commercial data: recipients and preparations have no provider or device secrets.
CREATE TABLE allnutrition.shipping_recipients (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX shipping_recipients_recent ON allnutrition.shipping_recipients(updated_at DESC,id);
CREATE TABLE allnutrition.shipping_preparations (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES allnutrition.orders(id) ON DELETE RESTRICT,
  shipment_id TEXT UNIQUE REFERENCES allnutrition.shipments(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(shipment_id,order_id) REFERENCES allnutrition.shipments(id,order_id) ON DELETE RESTRICT
);
CREATE INDEX shipping_preparations_recent ON allnutrition.shipping_preparations(updated_at DESC,id);
CREATE INDEX shipping_preparations_order ON allnutrition.shipping_preparations(order_id,updated_at DESC,id);

-- Operational data: kept out of portable commercial backups.
CREATE TABLE allnutrition.shipping_novelty_sync (
  connection_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('production','test')),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 2147483647),
  next_sequence TEXT NOT NULL CHECK(next_sequence IN ('open','resolved')),
  next_at TEXT NOT NULL,
  checked_at TEXT,
  last_success_at TEXT,
  error_code TEXT,
  lease_id TEXT,
  lease_until TEXT,
  CHECK((lease_id IS NULL)=(lease_until IS NULL)),
  PRIMARY KEY(connection_id,environment,generation)
);
CREATE TABLE allnutrition.shipping_novelty_cursors (
  connection_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sequence TEXT NOT NULL CHECK(sequence IN ('open','resolved')),
  page INTEGER NOT NULL CHECK(page>=1),
  initialized INTEGER NOT NULL CHECK(initialized IN (0,1)),
  PRIMARY KEY(connection_id,environment,generation,sequence),
  FOREIGN KEY(connection_id,environment,generation) REFERENCES allnutrition.shipping_novelty_sync(connection_id,environment,generation) ON DELETE CASCADE
);
CREATE TABLE allnutrition.shipping_novelties (
  connection_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL,
  guide_id TEXT NOT NULL,
  novelty_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','review','resolved')),
  revision INTEGER NOT NULL CHECK(revision>=1),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(connection_id,environment,generation,guide_id,novelty_id),
  FOREIGN KEY(connection_id,environment,generation) REFERENCES allnutrition.shipping_novelty_sync(connection_id,environment,generation) ON DELETE CASCADE
);
CREATE INDEX shipping_novelties_recent ON allnutrition.shipping_novelties(connection_id,environment,generation,updated_at DESC,guide_id,novelty_id);
CREATE INDEX shipping_novelties_state ON allnutrition.shipping_novelties(connection_id,environment,generation,state,updated_at DESC,guide_id,novelty_id);
CREATE TABLE allnutrition.shipping_novelty_events (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL,
  guide_id TEXT NOT NULL,
  novelty_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  created_at TEXT NOT NULL,
  UNIQUE(connection_id,environment,generation,guide_id,novelty_id,revision),
  FOREIGN KEY(connection_id,environment,generation,guide_id,novelty_id) REFERENCES allnutrition.shipping_novelties(connection_id,environment,generation,guide_id,novelty_id) ON DELETE CASCADE
);
CREATE INDEX shipping_novelty_events_recent ON allnutrition.shipping_novelty_events(connection_id,environment,generation,created_at DESC,id);
CREATE TABLE allnutrition.shipping_novelty_reads (
  user_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES allnutrition.shipping_novelty_events(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY(user_id,event_id)
);
CREATE INDEX shipping_novelty_reads_event ON allnutrition.shipping_novelty_reads(event_id);
CREATE TABLE allnutrition.shipping_push_vapid (
  id INTEGER PRIMARY KEY CHECK(id=1),
  public_key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE allnutrition.shipping_push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK(environment IN ('production','test')),
  endpoint_hash TEXT NOT NULL UNIQUE CHECK(length(endpoint_hash)=64),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT
);
CREATE INDEX shipping_push_subscriptions_active ON allnutrition.shipping_push_subscriptions(environment,user_id) WHERE disabled_at IS NULL;
CREATE TABLE allnutrition.shipping_push_deliveries (
  event_id TEXT NOT NULL REFERENCES allnutrition.shipping_novelty_events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES allnutrition.shipping_push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','sent','discarded')),
  attempts INTEGER NOT NULL CHECK(attempts>=0),
  next_at TEXT NOT NULL,
  lease_id TEXT,
  lease_until TEXT,
  CHECK((lease_id IS NULL)=(lease_until IS NULL)),
  PRIMARY KEY(event_id,subscription_id)
);
CREATE INDEX shipping_push_deliveries_due ON allnutrition.shipping_push_deliveries(next_at,event_id,subscription_id) WHERE state='pending';
CREATE INDEX shipping_push_deliveries_device ON allnutrition.shipping_push_deliveries(subscription_id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='allnutrition_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON allnutrition.shipping_recipients, allnutrition.shipping_preparations,
      allnutrition.shipping_novelty_sync, allnutrition.shipping_novelty_cursors, allnutrition.shipping_novelties,
      allnutrition.shipping_novelty_events, allnutrition.shipping_novelty_reads, allnutrition.shipping_push_vapid,
      allnutrition.shipping_push_subscriptions, allnutrition.shipping_push_deliveries TO allnutrition_app;
  END IF;
END $$;
