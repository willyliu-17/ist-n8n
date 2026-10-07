if ($input.all().length !== 1) throw new Error('history_expected_single_input');
const raw=$input.first().json;const payload=raw.payload||raw;
const c=payload;if(!['C09F0SYG57D','C0A4JJJKJMD'].includes(c.channel)||c.positionals?.length!==1||Object.keys(c.args||{}).length||!/^\d{10,}\.\d{6}$/.test(c.thread_ts||''))throw new Error('history_invalid_command');return [{json:{userID:c.positionals[0],channel:c.channel,threadTS:c.thread_ts}}];
