function expandDispatch(plan) {
  if (!plan || plan.transitionAction !== 'waiting_stt' || !Array.isArray(plan.dispatchAttempts)) return [];
  return plan.dispatchAttempts.map(({ attemptKey }) => ({ json: { attemptKey } }));
}

if (typeof module !== 'undefined' && module.exports) module.exports = { expandDispatch };

if (typeof $input !== 'undefined') return expandDispatch($input.first().json);
