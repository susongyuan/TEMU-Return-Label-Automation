let schemaInitPromise = null;

async function runSchemaInit(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS return_label_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      external_id VARCHAR(128) NULL DEFAULT NULL,
      job_id VARCHAR(64) NULL DEFAULT NULL,
      raw_order_no VARCHAR(128) NULL DEFAULT NULL,
      st_order_no VARCHAR(128) NULL DEFAULT NULL,
      order_no VARCHAR(128) NULL DEFAULT NULL,
      tracking_no VARCHAR(128) NULL DEFAULT NULL,
      platform VARCHAR(64) NULL DEFAULT NULL,
      platform_label VARCHAR(64) NULL DEFAULT NULL,
      store_name VARCHAR(128) NULL DEFAULT NULL,
      warehouse_source VARCHAR(64) NULL DEFAULT NULL,
      warehouse_order_no VARCHAR(128) NULL DEFAULT NULL,
      return_logistics_mode VARCHAR(32) NULL DEFAULT NULL,
      customer_return_tracking_no VARCHAR(128) NULL DEFAULT NULL,
      customer_return_carrier_name VARCHAR(128) NULL DEFAULT NULL,
      return_order_no VARCHAR(128) NULL DEFAULT NULL,
      label_no VARCHAR(128) NULL DEFAULT NULL,
      label_download_url TEXT NULL,
      status VARCHAR(64) NOT NULL,
      display_status VARCHAR(64) NULL DEFAULT NULL,
      message TEXT NULL,
      selected_logistics_json JSON NULL,
      steps_json JSON NULL,
      request_json JSON NULL,
      response_json JSON NULL,
      operator_key VARCHAR(64) NULL DEFAULT NULL,
      operator_name VARCHAR(64) NULL DEFAULT NULL,
      source VARCHAR(64) NOT NULL DEFAULT 'return-label-automation',
      updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uniq_return_label_history_external (external_id),
      KEY idx_return_label_history_created (created_at),
      KEY idx_return_label_history_order_created (order_no, created_at),
      KEY idx_return_label_history_raw_created (raw_order_no, created_at),
      KEY idx_return_label_history_st_created (st_order_no, created_at),
      KEY idx_return_label_history_tracking_created (tracking_no, created_at),
      KEY idx_return_label_history_status_created (status, created_at),
      KEY idx_return_label_history_platform_created (platform, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const columns = [
    ['job_id', "ALTER TABLE return_label_history ADD COLUMN job_id VARCHAR(64) NULL DEFAULT NULL AFTER external_id"],
    ['raw_order_no', "ALTER TABLE return_label_history ADD COLUMN raw_order_no VARCHAR(128) NULL DEFAULT NULL AFTER job_id"],
    ['st_order_no', "ALTER TABLE return_label_history ADD COLUMN st_order_no VARCHAR(128) NULL DEFAULT NULL AFTER raw_order_no"],
    ['platform_label', "ALTER TABLE return_label_history ADD COLUMN platform_label VARCHAR(64) NULL DEFAULT NULL AFTER platform"],
    ['warehouse_source', "ALTER TABLE return_label_history ADD COLUMN warehouse_source VARCHAR(64) NULL DEFAULT NULL AFTER store_name"],
    ['warehouse_order_no', "ALTER TABLE return_label_history ADD COLUMN warehouse_order_no VARCHAR(128) NULL DEFAULT NULL AFTER warehouse_source"],
    ['return_logistics_mode', "ALTER TABLE return_label_history ADD COLUMN return_logistics_mode VARCHAR(32) NULL DEFAULT NULL AFTER warehouse_order_no"],
    ['customer_return_tracking_no', "ALTER TABLE return_label_history ADD COLUMN customer_return_tracking_no VARCHAR(128) NULL DEFAULT NULL AFTER return_logistics_mode"],
    ['customer_return_carrier_name', "ALTER TABLE return_label_history ADD COLUMN customer_return_carrier_name VARCHAR(128) NULL DEFAULT NULL AFTER customer_return_tracking_no"],
    ['return_order_no', "ALTER TABLE return_label_history ADD COLUMN return_order_no VARCHAR(128) NULL DEFAULT NULL AFTER customer_return_carrier_name"],
    ['label_no', "ALTER TABLE return_label_history ADD COLUMN label_no VARCHAR(128) NULL DEFAULT NULL AFTER return_order_no"],
    ['label_download_url', "ALTER TABLE return_label_history ADD COLUMN label_download_url TEXT NULL AFTER label_no"],
    ['display_status', "ALTER TABLE return_label_history ADD COLUMN display_status VARCHAR(64) NULL DEFAULT NULL AFTER status"],
    ['selected_logistics_json', "ALTER TABLE return_label_history ADD COLUMN selected_logistics_json JSON NULL AFTER message"],
    ['steps_json', "ALTER TABLE return_label_history ADD COLUMN steps_json JSON NULL AFTER selected_logistics_json"],
    ['source', "ALTER TABLE return_label_history ADD COLUMN source VARCHAR(64) NOT NULL DEFAULT 'return-label-automation' AFTER operator_name"],
    ['updated_at', "ALTER TABLE return_label_history ADD COLUMN updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) AFTER source"]
  ];
  for (const [column, ddl] of columns) {
    const [matches] = await db.query(`SHOW COLUMNS FROM return_label_history LIKE '${column}'`);
    if (!matches.length) await db.query(ddl);
  }
}

async function initReturnLabelSchema(db) {
  if (!schemaInitPromise) {
    schemaInitPromise = runSchemaInit(db).catch(error => {
      schemaInitPromise = null;
      throw error;
    });
  }
  return schemaInitPromise;
}

module.exports = {
  initReturnLabelSchema
};
