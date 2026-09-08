const input = $('Validate Retry Candidate Input').first().json;
return [{ json: { repairClass: input.repairClass, candidateKey: input.attemptKey, result: 'noop', nextAttemptKey: '' } }];