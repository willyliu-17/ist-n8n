const rows = $input.all().map((i) => i.json);
const total = rows.length;
const successCount = rows.reduce((acc, row) => acc + Number(row.success || 0), 0);
const categoryMatchCount = rows.reduce((acc, row) => acc + Number(row.category_match || 0), 0);
const keywordHitCount = rows.reduce((acc, row) => acc + Number(row.keyword_hit || 0), 0);

return [{
  json: {
    total,
    successCount,
    successRate: total > 0 ? successCount / total : 0,
    categoryMatchCount,
    categoryMatchRate: total > 0 ? categoryMatchCount / total : 0,
    keywordHitCount,
    keywordHitRate: total > 0 ? keywordHitCount / total : 0,
    rows,
  },
}];