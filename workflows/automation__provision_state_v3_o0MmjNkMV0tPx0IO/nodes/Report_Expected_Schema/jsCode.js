const REPORT_STATUS = Object.freeze({
  reportType: 'expected_schema_reference',
  schemaStatus: 'not_validated_by_existence_probe',
  tableCreationStatus: 'not_performed',
});

function buildExpectedSchemaReport(buildItems) {
  return buildItems.map(({ json }) => ({
    json: {
      tableName: json.tableName,
      columnsJson: json.columnsJson,
      columnCount: json.columnCount,
      ...REPORT_STATUS,
    },
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildExpectedSchemaReport };
}

if (typeof $ !== 'undefined') {
  return buildExpectedSchemaReport($('Build Provisioning Manifest').all());
}
