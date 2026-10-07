if ($input.all().length !== 1) throw new Error('history_expected_single_input');
const raw=$input.first().json;const payload=raw.payload||raw;
return [{json:{startedAtIso:new Date().toISOString(),mode:payload.mode||'incremental'}}];
