-- Business v3 is applied inside the shared migrator's transaction.
CREATE TABLE IF NOT EXISTS business_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL CHECK(length(trim(name))>0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platforms (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL CHECK(length(trim(name))>0), name_key TEXT NOT NULL UNIQUE CHECK(length(name_key)>0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_sources (
  id TEXT PRIMARY KEY NOT NULL, platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(trim(name))>0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(id,platform_id), UNIQUE(platform_id,name)
);
CREATE TABLE IF NOT EXISTS product_costs (
  id TEXT PRIMARY KEY NOT NULL, product_id TEXT NOT NULL REFERENCES records(id) ON DELETE RESTRICT, effective_on TEXT NOT NULL,
  unit_cost_minor INTEGER CHECK(unit_cost_minor IS NULL OR (typeof(unit_cost_minor)='integer' AND unit_cost_minor BETWEEN 0 AND 10000000000000)),
  recorded_at TEXT NOT NULL, actor_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(product_id,effective_on)
);
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY NOT NULL, order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT,
  platform_id TEXT REFERENCES platforms(id) ON DELETE RESTRICT, source_id TEXT REFERENCES platform_sources(id) ON DELETE RESTRICT,
  external_id TEXT, identity_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('label_created','collected','in_transit','out_for_delivery','delivered','incident','return_in_transit','returned','cancelled','unknown')),
  carrier TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '', source_as_of TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(source_id IS NULL OR platform_id IS NOT NULL), FOREIGN KEY(source_id,platform_id) REFERENCES platform_sources(id,platform_id) ON DELETE RESTRICT,
  UNIQUE(id,order_id)
);
CREATE TABLE IF NOT EXISTS shipment_events (
  id TEXT PRIMARY KEY NOT NULL, shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE RESTRICT, external_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('label_created','collected','in_transit','out_for_delivery','delivered','incident','return_in_transit','returned','cancelled','unknown')),
  occurred_at TEXT, occurred_on TEXT, recorded_at TEXT NOT NULL, source_as_of TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), CHECK(occurred_at IS NULL OR occurred_on IS NULL)
);
CREATE TABLE IF NOT EXISTS import_profiles (
  id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES platform_sources(id) ON DELETE RESTRICT, name TEXT NOT NULL CHECK(length(trim(name))>0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(id,source_id)
);
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES platform_sources(id) ON DELETE RESTRICT, profile_id TEXT REFERENCES import_profiles(id) ON DELETE RESTRICT,
  file_hash TEXT, filename TEXT, file_bytes_base64 TEXT,
  state TEXT NOT NULL CHECK(state IN ('uploaded','previewing','review','queued','applying','completed','completed_with_errors','failed','expired')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), CHECK(file_bytes_base64 IS NULL OR length(file_bytes_base64)<=13981016),
  FOREIGN KEY(profile_id,source_id) REFERENCES import_profiles(id,source_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS import_revisions (
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT, revision INTEGER NOT NULL CHECK(revision>=1),
  preview_hash TEXT NOT NULL, accepted_at TEXT NOT NULL, actor_id TEXT NOT NULL, recorded_at TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), PRIMARY KEY(batch_id,revision)
);
CREATE TABLE IF NOT EXISTS import_rows (
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE RESTRICT, sheet TEXT NOT NULL, row_number INTEGER NOT NULL CHECK(row_number>=1),
  entity_key TEXT, state TEXT NOT NULL CHECK(state IN ('pending','new','updated','unchanged','conflict','rejected','ready','skipped','applied')),
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(batch_id,sheet,row_number)
);
CREATE TABLE IF NOT EXISTS external_links (
  source_id TEXT NOT NULL REFERENCES platform_sources(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('order','product','person','shipment','collection','settlement')), external_key TEXT NOT NULL CHECK(length(external_key)>0), internal_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(source_id,entity_type,external_key)
);
CREATE TABLE IF NOT EXISTS cash_accounts (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL CHECK(length(trim(name))>0), type TEXT NOT NULL CHECK(type IN ('cash','bank','wallet')), opening_on TEXT NOT NULL,
  responsible_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cash_entries (
  id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES cash_accounts(id) ON DELETE RESTRICT, effective_on TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN -10000000000000 AND 10000000000000),
  kind TEXT NOT NULL CHECK(kind IN ('opening','collection','refund','settlement','expense_payment','payroll_payment','advance','income','owner_funding','other_non_sale','transfer','adjustment','recovery','reversal')),
  source_type TEXT NOT NULL, source_id TEXT NOT NULL, transfer_id TEXT, reversal_of TEXT UNIQUE REFERENCES cash_entries(id) ON DELETE RESTRICT,
  recorded_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), CHECK(amount_minor<>0 OR kind='opening')
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_opening_once ON cash_entries(account_id) WHERE kind='opening';
CREATE TABLE IF NOT EXISTS cash_closings (
  id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES cash_accounts(id) ON DELETE RESTRICT, closing_on TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
  state TEXT NOT NULL CHECK(state IN ('closed','reopened')),
  expected_minor INTEGER NOT NULL CHECK(typeof(expected_minor)='integer' AND expected_minor BETWEEN -10000000000000 AND 10000000000000),
  counted_minor INTEGER NOT NULL CHECK(typeof(counted_minor)='integer' AND counted_minor BETWEEN -10000000000000 AND 10000000000000),
  difference_minor INTEGER NOT NULL CHECK(typeof(difference_minor)='integer' AND difference_minor BETWEEN -10000000000000 AND 10000000000000),
  responsible_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT, recorded_at TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(account_id,closing_on,revision), CHECK(difference_minor=counted_minor-expected_minor)
);
CREATE TABLE IF NOT EXISTS order_collections (
  id TEXT PRIMARY KEY NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT, shipment_id TEXT REFERENCES shipments(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('receipt','refund','reversal')), holder TEXT NOT NULL CHECK(holder IN ('business','platform','legacy')),
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 1 AND 10000000000000), occurred_on TEXT,
  cash_entry_id TEXT UNIQUE REFERENCES cash_entries(id) ON DELETE RESTRICT, reversal_of TEXT UNIQUE REFERENCES order_collections(id) ON DELETE RESTRICT,
  external_key TEXT UNIQUE, recorded_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),
  FOREIGN KEY(shipment_id,order_id) REFERENCES shipments(id,order_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES platform_sources(id) ON DELETE RESTRICT, external_key TEXT UNIQUE, reported_on TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','partial','confirmed')),
  net_minor INTEGER NOT NULL CHECK(typeof(net_minor)='integer' AND net_minor BETWEEN -10000000000000 AND 10000000000000),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settlement_receipts (
  id TEXT PRIMARY KEY NOT NULL, settlement_id TEXT NOT NULL REFERENCES settlements(id) ON DELETE RESTRICT, received_on TEXT NOT NULL,
  account_id TEXT REFERENCES cash_accounts(id) ON DELETE RESTRICT,
  net_minor INTEGER NOT NULL CHECK(typeof(net_minor)='integer' AND net_minor BETWEEN -10000000000000 AND 10000000000000),
  cash_entry_id TEXT UNIQUE REFERENCES cash_entries(id) ON DELETE RESTRICT, external_key TEXT UNIQUE,
  reversal_of TEXT UNIQUE REFERENCES settlement_receipts(id) ON DELETE RESTRICT, recorded_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),
  CHECK((net_minor=0 AND cash_entry_id IS NULL) OR (net_minor<>0 AND cash_entry_id IS NOT NULL AND account_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY NOT NULL, category TEXT NOT NULL CHECK(category IN ('shipping_out','shipping_return','platform_fee','commission','salary','bonus','other')),
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN -10000000000000 AND 10000000000000), incurred_on TEXT,
  person_id TEXT REFERENCES people(id) ON DELETE RESTRICT, order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT, shipment_id TEXT REFERENCES shipments(id) ON DELETE RESTRICT,
  source_key TEXT UNIQUE, version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), recorded_at TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(amount_minor>=0 OR source_key IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS expense_payments (
  id TEXT PRIMARY KEY NOT NULL, expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('payment','recovery','reversal')), cash_entry_id TEXT REFERENCES cash_entries(id) ON DELETE RESTRICT,
  settlement_receipt_id TEXT REFERENCES settlement_receipts(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN -10000000000000 AND 10000000000000 AND amount_minor<>0),
  reversal_of TEXT UNIQUE REFERENCES expense_payments(id) ON DELETE RESTRICT, recorded_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),
  CHECK((cash_entry_id IS NOT NULL AND settlement_receipt_id IS NULL) OR (cash_entry_id IS NULL AND settlement_receipt_id IS NOT NULL)),
  CHECK((kind='payment' AND amount_minor>0 AND reversal_of IS NULL) OR (kind='recovery' AND amount_minor<0 AND reversal_of IS NULL) OR (kind='reversal' AND reversal_of IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS order_returns (
  id TEXT PRIMARY KEY NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT, occurred_on TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  kind TEXT NOT NULL CHECK(kind IN ('return','cancellation')), source_key TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), recorded_at TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payroll_periods (
  id TEXT PRIMARY KEY NOT NULL, person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT, start_on TEXT NOT NULL, end_on_exclusive TEXT NOT NULL, due_on TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','confirmed','partial','paid')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(person_id,start_on,end_on_exclusive), CHECK(start_on<end_on_exclusive)
);
CREATE TABLE IF NOT EXISTS payroll_allocations (
  id TEXT PRIMARY KEY NOT NULL, payroll_id TEXT NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK(source_type IN ('expense','advance')), source_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN -10000000000000 AND 10000000000000 AND amount_minor<>0),
  recorded_at TEXT NOT NULL, UNIQUE(payroll_id,source_type,source_id)
);
CREATE TABLE IF NOT EXISTS payroll_offsets (
  id TEXT PRIMARY KEY NOT NULL, payroll_id TEXT NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  debit_expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT, credit_expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 1 AND 10000000000000),
  reversal_of TEXT UNIQUE REFERENCES payroll_offsets(id) ON DELETE RESTRICT, recorded_at TEXT NOT NULL, CHECK(debit_expense_id<>credit_expense_id)
);
CREATE TABLE IF NOT EXISTS commission_entries (
  id TEXT PRIMARY KEY NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT, person_id TEXT NOT NULL REFERENCES people(id) ON DELETE RESTRICT, earned_on TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN -10000000000000 AND 10000000000000), source_key TEXT NOT NULL UNIQUE,
  expense_id TEXT NOT NULL UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT, rule_snapshot TEXT NOT NULL CHECK(json_valid(rule_snapshot)), recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_snapshots (
  id TEXT PRIMARY KEY NOT NULL, query_key TEXT NOT NULL, period TEXT NOT NULL CHECK(period IN ('day','week','month','quarter','halfyear','year')),
  start_on TEXT NOT NULL, end_on_exclusive TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), generated_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('current','superseded','stale')), stale_since TEXT, data_revision INTEGER NOT NULL CHECK(data_revision>=0), fact_hash TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(query_key,revision), CHECK(start_on<end_on_exclusive)
);
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('shipment_label_stale','shipment_no_update','shipment_overdue','shipment_incident','platform_not_updated','settlement_overdue','cash_below_minimum','cash_difference','cash_close_missing','business_data_missing')),
  scope_key TEXT NOT NULL DEFAULT 'global', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(type,scope_key)
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY NOT NULL, rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE RESTRICT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, episode INTEGER NOT NULL CHECK(episode>=1),
  state TEXT NOT NULL CHECK(state IN ('open','acknowledged','resolved')), severity TEXT NOT NULL CHECK(severity IN ('critical','warning','info')),
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, responsible_id TEXT REFERENCES people(id) ON DELETE RESTRICT,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(rule_id,entity_type,entity_id,episode)
);
CREATE TABLE IF NOT EXISTS business_audit (
  id TEXT PRIMARY KEY NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, actor_id TEXT NOT NULL, recorded_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE IF NOT EXISTS business_requests (
  scope TEXT NOT NULL, request_id TEXT NOT NULL, actor_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(scope,request_id)
);
CREATE TABLE IF NOT EXISTS job_runs (
  key TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')), lease_token TEXT, lease_until TEXT, started_at TEXT, finished_at TEXT, error_code TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS shipments_order_status ON shipments(order_id,status);
CREATE INDEX IF NOT EXISTS shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS shipments_tracking ON shipments(carrier,tracking);
CREATE INDEX IF NOT EXISTS shipment_events_dates ON shipment_events(shipment_id,occurred_on,occurred_at,recorded_at);
CREATE INDEX IF NOT EXISTS expenses_date_category ON expenses(incurred_on,category);
CREATE INDEX IF NOT EXISTS expenses_order ON expenses(order_id);
CREATE INDEX IF NOT EXISTS expenses_shipment ON expenses(shipment_id);
CREATE INDEX IF NOT EXISTS collections_order_date ON order_collections(order_id,occurred_on);
CREATE INDEX IF NOT EXISTS cash_account_date ON cash_entries(account_id,effective_on);
CREATE INDEX IF NOT EXISTS reports_period_start ON report_snapshots(period,start_on);
CREATE INDEX IF NOT EXISTS alerts_state_responsible ON alerts(state,responsible_id);
CREATE INDEX IF NOT EXISTS import_batches_state ON import_batches(state,created_at);
CREATE INDEX IF NOT EXISTS import_rows_entity ON import_rows(batch_id,entity_key,state);
CREATE INDEX IF NOT EXISTS business_audit_entity ON business_audit(entity_type,entity_id,recorded_at);
