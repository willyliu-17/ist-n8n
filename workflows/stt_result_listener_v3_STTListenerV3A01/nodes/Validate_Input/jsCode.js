const attemptKey = $input.first().json.attemptKey;
if (typeof attemptKey !== 'string' || !attemptKey.trim() || attemptKey !== attemptKey.trim()) throw new Error('Invalid attemptKey input');
return [{ json: { attemptKey } }];
