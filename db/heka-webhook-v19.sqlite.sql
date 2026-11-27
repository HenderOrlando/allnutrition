ALTER TABLE heka_api_settings ADD COLUMN webhook_ciphertext TEXT;
ALTER TABLE heka_api_settings ADD COLUMN webhook_iv TEXT;
ALTER TABLE heka_api_settings ADD COLUMN webhook_auth_tag TEXT;
ALTER TABLE heka_api_settings ADD COLUMN webhook_revision TEXT;
ALTER TABLE heka_api_settings ADD COLUMN webhook_generation INTEGER;

ALTER TABLE shipping_novelty_sync ADD COLUMN webhook_verified_revision TEXT;
ALTER TABLE shipping_novelty_sync ADD COLUMN webhook_verified_at TEXT;
ALTER TABLE shipping_novelty_sync ADD COLUMN sweep_open_done INTEGER NOT NULL DEFAULT 0 CHECK(sweep_open_done IN (0,1));
ALTER TABLE shipping_novelty_sync ADD COLUMN sweep_resolved_done INTEGER NOT NULL DEFAULT 0 CHECK(sweep_resolved_done IN (0,1));
ALTER TABLE shipping_novelty_sync ADD COLUMN guide_page INTEGER NOT NULL DEFAULT 1 CHECK(guide_page BETWEEN 1 AND 10000);
ALTER TABLE shipping_novelty_sync ADD COLUMN guide_next_at TEXT;

CREATE TABLE shipping_guide_observations (
  connection_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL,
  guide_id TEXT NOT NULL,
  guide_number TEXT NOT NULL,
  carrier TEXT,
  provider_status TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(connection_id,environment,generation,guide_id),
  FOREIGN KEY(connection_id,environment,generation) REFERENCES shipping_novelty_sync(connection_id,environment,generation) ON DELETE CASCADE
);
