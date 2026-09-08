const { repairClass, candidateKey, scanTimeIso } = $input.first().json;
if (!['retry_materialization', 'presentation_lease'].includes(repairClass)) throw new Error('Unsupported repair class');
if (typeof candidateKey !== 'string' || candidateKey === '') throw new Error('candidateKey is required');
if (typeof scanTimeIso !== 'string' || !Number.isFinite(Date.parse(scanTimeIso)) || new Date(Date.parse(scanTimeIso)).toISOString() !== scanTimeIso) throw new Error('scanTimeIso must be a canonical ISO timestamp');
return [{ json: { kind: 'candidate', repairClass, attemptKey: candidateKey, nowIso: scanTimeIso, __repairGroupKey: `attempt:${candidateKey}` } }];