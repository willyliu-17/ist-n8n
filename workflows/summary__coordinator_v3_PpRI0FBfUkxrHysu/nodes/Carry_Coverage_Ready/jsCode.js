return $input.all().map(({ json }) => ({ json: { ...json, __planCarrier: true, __planPhase: 'coverage', __planAction: json.action } }));
