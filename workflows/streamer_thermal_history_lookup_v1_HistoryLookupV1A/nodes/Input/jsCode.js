if ($input.all().length !== 1) throw new Error('history_expected_single_input');
const raw=$input.first().json;const payload=raw.payload||raw;
const input=payload; if(typeof input.userID!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.userID))throw new Error('history_invalid_user_id');return [{json:input}];
