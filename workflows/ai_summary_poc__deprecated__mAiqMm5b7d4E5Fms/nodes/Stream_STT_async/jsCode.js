// n8n Function node — Stream Command Normalizer
// Supports both Manual (Slack Command) and Auto (Workflow Trigger)

function normalizeOne(item) {
  // 1. Get Slack Bot Message Info (Current Item)
  // This contains the 'ts' of the "Processing..." message we just sent.
  const slackData = item.json || {};
  const lastMsgTs = slackData.ts;

  // 2. Get Config Data (From Upstream Node "Normalize Inputs")
  // We use the helper function $() to access the specific previous node's data
  // because the Slack node output overwrote the streamID info in the main flow.
  const configData = $('Normalize Inputs').item.json || {};

  // 3. Determine Core Parameters
  let streamid = (configData.streamid_input || '').toString().trim();
  
  // Safety check
  if (!streamid) {
    return {
      json: {
        error: true,
        message: 'Missing streamid for stt:stream',
        debug_slack: slackData,
        debug_config: configData
      },
    };
  }

  // 4. Determine Logic Mode (fromStart vs fromEnd)
  let mode = 'fromEnd'; // Default
  let mins = configData.mins_input ? Number(configData.mins_input) : 5;

  const rawMode = (configData.mode_input || '').toLowerCase();
  if (rawMode === 'first' || rawMode === 'fromstart') {
    mode = 'fromStart';
  } else if (rawMode === 'last' || rawMode === 'fromend') {
    mode = 'fromEnd';
  }

  // 5. Construct URL
  const urlPath = `/stream/${encodeURIComponent(streamid)}/stt`;

  // 6. Construct Output for HTTP Request
  return {
    json: {
      urlPath,
      streamid,
      method: 'POST',
      sttDomain: '35.206.206.41:8080',
      segment: {
        mode,
        durationMinutes: mins
      },
      webhook: {
        url: $execution.resumeUrl,
        context: {
          // --- CRITICAL FOR UPDATE MECHANISM ---
          // We pass the Bot's message TS as 'last_msg_ts'.
          // The Listener will use this to overwrite the "Processing..." message.
          last_msg_ts: lastMsgTs, 
          
          // This ensures the Listener replies to the correct thread (Parent Thread)
          event_ts: configData.thread_ts_input,
          channel: configData.channel_input,
          
          // Pass-through metadata
          client_msg_id: configData.client_msg_id,
          ts: configData.ts, // Original user trigger TS
          routeKey: configData.routeKey,
          group: configData.group,
          action: configData.action,
          mode_input: configData.mode_input,
          mins_input: configData.mins_input,
          streamid_input: configData.streamid_input,
          logFileID: configData.logFileID
        }
      }
    },
  };
}

const out = [];
// Loop handling
// Note: This assumes 1-to-1 execution. If batching, logic needs 'itemIndex'.
for (const it of items) {
  const r = normalizeOne(it);
  if (r) out.push(r);
}
return out;