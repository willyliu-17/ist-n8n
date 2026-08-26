const rows = $input.all().map((item) => item.json).filter((row) => row && Object.keys(row).length);
const canonical = rows.filter((row) => row.reconciliationStatus === 'canonical');
if (canonical.length !== 1 || canonical[0].canonicalRowID !== String(canonical[0].id)) throw new Error('Expected exactly one canonical row');
const row = canonical[0];
if (row.status !== 'completed' || !String(row.dialogue || '').trim() || row.presentationStatus !== 'pending') throw new Error('Canonical attempt is not presentation eligible');
if (row.channel !== 'C0A4JJJKJMD' || !row.threadTS || !row.processingMessageTS) throw new Error('Invalid persisted Slack routing');
const currentAttempt = Number(row.presentationAttempt || 0);
if (!Number.isInteger(currentAttempt) || currentAttempt < 0 || currentAttempt >= 3) throw new Error('Invalid presentation attempt');
return [{ json: { ...row, expectedPresentationAttempt: currentAttempt, nextPresentationAttempt: currentAttempt + 1 } }];
