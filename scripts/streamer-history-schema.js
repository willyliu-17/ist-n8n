const { TABLES, CATEGORY_TABLE } = require('./streamer-history-core');
const common = ['reconciliationStatus', 'canonicalRowID', 'updatedAtIso'];
const strings = fields => [...fields, ...common].map(name => ({ name, type: 'string' }));
module.exports = {
  [TABLES.events]: strings(['eventKey', 'identityVersion', 'userID', 'orderedStreamsJson', 'firstSeenAtIso', 'lastSeenAtIso']),
  [TABLES.streams]: strings(['eventStreamKey', 'eventKey', 'userID', 'streamID', 'role', 'beginTime', 'endTime', 'deviceModel', 'deviceType', 'appVersion', 'osVersion', 'region', 'streamMode', 'isOBS']),
  [TABLES.analyses]: strings(['analysisKey', 'eventKey', 'userID', 'sourceRequestKey', 'sourceRowID', 'sourceChannel', 'requestCreatedAtIso', 'sourceType', 'analysisScopeJson', 'aiCategoriesJson', 'reportJson', 'summaryMarkdown', 'resultFingerprint', 'evidenceCompleteness', 'evidenceRef', 'evidenceHash', 'promptVersion', 'modelVersion', 'taxonomyVersion', 'triggerTS', 'triggerLink', 'linkKind', 'summaryMessageTS', 'summaryUploadID']),
  [TABLES.state]: strings(['stateKey', 'recordType', 'userID', 'eventKey', 'sourceRequestKey', 'requestCreatedAtIso', 'sourceUpdatedAtIso', 'sourceStatus', 'triggerTS', 'triggerLink', 'linkKind', 'channel', 'threadTS', 'watermarkUpdatedAtIso', 'deliveryStatus', 'deliveryToken', 'deliveryMessageTS', 'runID', 'triggerKind']),
  [TABLES.reviews]: strings(['reviewID', 'eventKey', 'analysisKey', 'userID', 'reviewType', 'humanCategoriesJson', 'reviewerID', 'reviewedAt', 'reviewSource', 'supersedesReviewID', 'reviewSchemaVersion']),
  [CATEGORY_TABLE]: strings(['categoryKey', 'analysisKey', 'eventKey', 'userID', 'category', 'sourceRequestKey', 'sourceType', 'triggerKind', 'sourceChannel', 'requestCreatedAtIso', 'requestDateTW', 'summaryMessageAtIso', 'summaryMessageDateTW', 'summaryCompletedAtIso', 'completionTimeEvidence', 'sourceStatus', 'orderedStreamsJson', 'currentStreamID', 'analysisScopeJson', 'evidenceCompleteness']),
};
