return $input.all().map(({ json }) => ({ json: { ...json, __planCarrier: true, __planPhase: 'claim', __planAction: json.action } }));
