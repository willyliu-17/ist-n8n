const V3_WORKFLOW_INVENTORY = Object.freeze([
    ['Automation: provision state v3', 'workflows/automation_provision_state_v3_AutomationProvV3A1'],
    ['Stream Metadata: resolve by IDs v3', 'workflows/stream_metadata_resolve_by_ids_v3_StreamMetaV3A001'],
    ['STT: dispatch attempt v3', 'workflows/stt_dispatch_attempt_v3_STTDispatchV3A01'],
    ['STT: callback ingress v3', 'workflows/stt_callback_ingress_v3_STTCallbackV3A1'],
    ['STT result listener v3', 'workflows/stt_result_listener_v3_STTListenerV3A01'],
    ['Req STT process v3', 'workflows/req_stt_process_v3_ReqSTTProcessV3A'],
    ['Summary: orchestrate request v3', 'workflows/summary_orchestrate_request_v3_SummaryOrchV3A01'],
    ['AI SUMMARY v3', 'workflows/ai_summary_v3_AISummaryV3A0001'],
    ['Summary: coordinator v3', 'workflows/summary_coordinator_v3_SummaryCoordV3A1'],
    ['Automation: retry and repair v3', 'workflows/automation_retry_and_repair_v3_AutoRepairV3A001'],
    ['Automation: error handler v3', 'workflows/automation_error_handler_v3_AutomationErrorV3A1'],
    ['Query Steam Logs v3', 'workflows/query_steam_logs_v3_QueryLogsV3A0001'],
    ['Tencent realtime VDS v3', 'workflows/tencent_realtime_vds_v3_TencentVDSV3A001'],
    ['Collect suspect streamID v3', 'workflows/collect_suspect_streamid_v3_CollectSuspectV3'],
    ['IST bot entry v3', 'workflows/ist_bot_entry_v3_IstBotEntryV3A01']
].map(tuple => Object.freeze(tuple)));

module.exports = { V3_WORKFLOW_INVENTORY };
