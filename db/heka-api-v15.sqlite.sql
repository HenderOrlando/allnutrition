-- Server-held credentials and the minimal no-replay journal for official Heka writes.
CREATE TABLE heka_api_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  environment TEXT NOT NULL CHECK(environment IN ('production','test')),
  ciphertext TEXT,
  iv TEXT,
  auth_tag TEXT,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((ciphertext IS NULL AND iv IS NULL AND auth_tag IS NULL) OR (ciphertext IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL))
);
CREATE TABLE heka_api_mutations (
  id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('production','test')),
  operation TEXT NOT NULL CHECK(operation IN ('createGuide','solveNovelty')),
  state TEXT NOT NULL CHECK(state IN ('sending','uncertain','succeeded','rejected')),
  actor_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  carrier TEXT,
  novelty_guide_id TEXT,
  novelty_id TEXT,
  solution_hash TEXT,
  credential_hash TEXT NOT NULL CHECK(length(credential_hash)=64),
  guide_id TEXT,
  guide_number TEXT,
  remote_status TEXT,
  error_code TEXT,
  lease_until TEXT,
  reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((operation='createGuide' AND carrier IS NOT NULL AND novelty_id IS NULL AND novelty_guide_id IS NULL AND solution_hash IS NULL) OR (operation='solveNovelty' AND carrier IS NULL AND novelty_id IS NOT NULL AND novelty_guide_id IS NOT NULL AND length(solution_hash)=64 AND solution_hash IS NOT NULL)),
  CHECK((state='sending')=(lease_until IS NOT NULL)),
  UNIQUE(environment,guide_id)
);
CREATE INDEX heka_api_mutations_pending ON heka_api_mutations(environment,operation,state,novelty_id);
CREATE INDEX heka_api_mutations_recency ON heka_api_mutations(created_at,id);

CREATE UNIQUE INDEX shipments_heka_link_identity ON shipments(id,order_id,carrier,tracking);
CREATE TABLE heka_api_order_links (
  guide_id TEXT PRIMARY KEY NOT NULL,
  carrier TEXT NOT NULL,
  guide_number TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  shipment_id TEXT NOT NULL UNIQUE,
  local_carrier TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  UNIQUE(carrier,guide_number),
  FOREIGN KEY(shipment_id,order_id,local_carrier,guide_number) REFERENCES shipments(id,order_id,carrier,tracking) ON DELETE RESTRICT
);
