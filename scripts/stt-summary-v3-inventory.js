const V3_WORKFLOW_INVENTORY = Object.freeze([
    ['Automation: provision state v3', 'workflows/automation_provision_state_v3_AutomationProvV3A1'],
    ['Stream Metadata: resolve by IDs v3', 'workflows/stream_metadata_resolve_by_ids_v3_StreamMetaV3A001'],
    ['STT: dispatch attempt v3', 'workflows/stt_dispatch_attempt_v3_STTDispatchV3A01'],
    ['STT: callback ingress v3', 'workflows/stt_callback_ingress_v3_STTCallbackV3A1'],
    ['STT result listener v3', 'workflows/stt_result_listener_v3_STTListenerV3A01'],
    ['Req STT process v3', 'workflows/req_stt_process_v3_chbKeywMnVJ9Pdt0'],
    ['Summary: orchestrate request v3', 'workflows/summary_orchestrate_request_v3_SummaryOrchV3A01'],
    ['AI SUMMARY v3', 'workflows/ai_summary_v3_AISummaryV3A0001'],
    ['Summary: coordinator v3', 'workflows/summary_coordinator_v3_SummaryCoordV3A1'],
    ['Repair: process candidate v3', 'workflows/repair_process_candidate_v3_RepairCandidateV3A1'],
    ['Automation: retry and repair v3', 'workflows/automation_retry_and_repair_v3_AutoRepairV3A001'],
    ['Automation: error handler v3', 'workflows/automation_error_handler_v3_AutomationErrorV3A1'],
    ['Query Steam Logs v3', 'workflows/query_steam_logs_v3_QueryLogsV3A0001'],
    ['Tencent realtime VDS v3', 'workflows/tencent_realtime_vds_v3_TencentVDSV3A001'],
    ['Collect suspect streamID v3', 'workflows/collect_suspect_streamid_v3_CollectSuspectV3'],
    ['IST bot entry v3', 'workflows/ist_bot_entry_v3_IstBotEntryV3A01'],
    ['IST bot Slack ingress v3', 'workflows/ist_bot_slack_ingress_v3_IstBotSlackIngressV3A1']
].map(tuple => Object.freeze(tuple)));

const V3_DATA_TABLE_NAMES = Object.freeze([
    'suspect_stt_candidates_v3',
    'stt_jobs_v3',
    'summary_requests_v3',
    'automation_errors_v3'
]);

const V3_TENCENT_CALLBACK_EXCLUSION =
    'workflows/tencent_realtime_vds_v3_TencentVDSV3A001';

const V3_EXTERNAL_WORKFLOW_DEPENDENCIES = Object.freeze([
    Object.freeze(['AI SUMMARY Inference SubWF', 'm8VcIoclFE2lVKrl']),
    Object.freeze(['Debug STT service', 'sPQaAHyeLVGdi7oA']),
    Object.freeze(['IST bot entry', 'd1Wg25BLsuGR6mAB'])
]);

const V3_OFFLINE_TEST_FILES = Object.freeze([
    'scripts/deploy-utils.test.js',
    'scripts/stt-summary-v3-offline.test.js',
    'scripts/single-stream-summary-v3.test.js',
    'workflows/automation_provision_state_v3_AutomationProvV3A1/tests/contracts.test.js',
    'workflows/stream_metadata_resolve_by_ids_v3_StreamMetaV3A001/tests/resolver.test.js',
    'workflows/stt_dispatch_attempt_v3_STTDispatchV3A01/tests/dispatcher.test.js',
    'workflows/stt_callback_ingress_v3_STTCallbackV3A1/tests/callback.test.js',
    'workflows/stt_result_listener_v3_STTListenerV3A01/tests/presentation.test.js',
    'workflows/req_stt_process_v3_chbKeywMnVJ9Pdt0/tests/adapter.test.js',
    'workflows/summary_orchestrate_request_v3_SummaryOrchV3A01/tests/orchestrator.test.js',
    'workflows/summary_coordinator_v3_SummaryCoordV3A1/tests/coordinator.test.js',
    'workflows/automation_error_handler_v3_AutomationErrorV3A1/tests/error-handler.test.js',
    'workflows/automation_retry_and_repair_v3_AutoRepairV3A001/tests/repair.test.js',
    'workflows/repair_process_candidate_v3_RepairCandidateV3A1/tests/processor.test.js',
    'workflows/ai_summary_inference_subwf_m8VcIoclFE2lVKrl/tests/inference.test.js',
    'workflows/ai_summary_inference_subwf_m8VcIoclFE2lVKrl/tests/long-dialogue.test.js',
    'workflows/ai_summary_v3_AISummaryV3A0001/tests/summary.test.js',
    'workflows/ai_summary_v3_AISummaryV3A0001/tests/scope-status.test.js',
    'workflows/query_steam_logs_v3_QueryLogsV3A0001/tests/delivery-order.test.js',
    'workflows/collect_suspect_streamid_v3_CollectSuspectV3/tests/routing.test.js',
    'workflows/ist_bot_entry_v3_IstBotEntryV3A01/tests/routing.test.js',
    'workflows/ist_bot_entry_d1Wg25BLsuGR6mAB/tests/routing.test.js',
    'workflows/ist_bot_slack_ingress_v3_IstBotSlackIngressV3A1/tests/routing.test.js'
]);

module.exports = {
    V3_WORKFLOW_INVENTORY,
    V3_DATA_TABLE_NAMES,
    V3_TENCENT_CALLBACK_EXCLUSION,
    V3_EXTERNAL_WORKFLOW_DEPENDENCIES,
    V3_OFFLINE_TEST_FILES
};
