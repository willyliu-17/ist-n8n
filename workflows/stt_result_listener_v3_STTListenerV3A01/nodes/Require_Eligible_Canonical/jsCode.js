const rows = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length);
const ALLOWED_CHANNELS = new Set(['C0A4JJJKJMD', 'C09F0SYG57D']);
const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
if (canonical.length !== 1 || canonical[0].canonicalRowID !== String(canonical[0].id)) throw new Error('Expected exactly one canonical row');
const row = canonical[0];
const terminal = ['completed', 'failed', 'timed_out'];
if (!terminal.includes(row.status) || row.presentationStatus !== 'pending') throw new Error('Canonical attempt is not presentation eligible');
if (!ALLOWED_CHANNELS.has(row.channel) || !row.threadTS || !row.processingMessageTS) throw new Error('Invalid persisted Slack routing');
const currentAttempt = Number(row.presentationAttempt || 0);
if (!Number.isInteger(currentAttempt) || currentAttempt < 0 || currentAttempt >= 3) throw new Error('Invalid presentation attempt');
return [{ json: {
  ...row,
  presentationMode: row.status === 'completed' && String(row.dialogue || '').trim() ? 'full' : 'message_only',
  expectedPresentationAttempt: currentAttempt,
  nextPresentationAttempt: currentAttempt + 1,
} }];
