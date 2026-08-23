const row = $input.first().json;
const stage = !row.transcriptUploadID ? 'transcript' : !row.analysisUploadID ? 'analysis' : !row.processingMessageUpdatedAtIso ? 'message_update' : 'complete';
return [{ json: { ...row, presentationStage: stage } }];
