-- Preserve children referencing expenses while replacing only its category CHECK.
-- The migrator checks all foreign keys before clearing deferred counters.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE expenses_v7 (
  id TEXT PRIMARY KEY NOT NULL, category TEXT NOT NULL CHECK(category IN ('shipping_out','shipping_return','shipping_insurance','platform_fee','commission','salary','bonus','advertising','operating','other')),
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN -10000000000000 AND 10000000000000), incurred_on TEXT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT, order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT, shipment_id TEXT REFERENCES shipments(id) ON DELETE RESTRICT,
  source_key TEXT UNIQUE, version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), recorded_at TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(amount_minor>=0 OR source_key IS NOT NULL)
);
INSERT INTO expenses_v7(id,category,amount_minor,incurred_on,person_id,order_id,shipment_id,source_key,version,recorded_at,data,created_at,updated_at)
  SELECT id,category,amount_minor,incurred_on,person_id,order_id,shipment_id,source_key,version,recorded_at,data,created_at,updated_at FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_v7 RENAME TO expenses;
CREATE INDEX expenses_date_category ON expenses(incurred_on,category);
CREATE INDEX expenses_order ON expenses(order_id);
CREATE INDEX expenses_shipment ON expenses(shipment_id);
