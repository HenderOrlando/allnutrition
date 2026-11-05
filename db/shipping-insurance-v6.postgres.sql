ALTER TABLE allnutrition.expenses DROP CONSTRAINT expenses_category_check;
ALTER TABLE allnutrition.expenses ADD CONSTRAINT expenses_category_check
  CHECK(category IN ('shipping_out','shipping_return','shipping_insurance','platform_fee','commission','salary','bonus','other'));
