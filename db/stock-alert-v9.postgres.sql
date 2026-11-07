ALTER TABLE allnutrition.alert_rules DROP CONSTRAINT alert_rules_type_check;
ALTER TABLE allnutrition.alert_rules ADD CONSTRAINT alert_rules_type_check CHECK(type IN ('shipment_label_stale','shipment_no_update','shipment_overdue','shipment_incident','platform_not_updated','settlement_overdue','cash_below_minimum','cash_difference','cash_close_missing','business_data_missing','stock_low'));
