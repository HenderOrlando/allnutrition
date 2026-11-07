-- Keep alerts.rule_id references intact while widening only the type CHECK.
-- The migrator verifies all foreign keys before clearing deferred counters.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE alert_rules_v9 (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('shipment_label_stale','shipment_no_update','shipment_overdue','shipment_incident','platform_not_updated','settlement_overdue','cash_below_minimum','cash_difference','cash_close_missing','business_data_missing','stock_low')),
  scope_key TEXT NOT NULL DEFAULT 'global', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(type,scope_key)
);
INSERT INTO alert_rules_v9(id,type,scope_key,enabled,version,data,created_at,updated_at)
  SELECT id,type,scope_key,enabled,version,data,created_at,updated_at FROM alert_rules;
DROP TABLE alert_rules;
ALTER TABLE alert_rules_v9 RENAME TO alert_rules;
