return $input.all().map(({ json }) => ({ json: { ...json, __planCarrier: true, __planPhase: 'initial', __planAction: json.action } }));
