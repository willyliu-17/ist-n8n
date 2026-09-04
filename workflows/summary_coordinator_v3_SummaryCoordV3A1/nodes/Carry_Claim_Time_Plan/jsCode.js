return $input.all().map(({ json }) => ({ json: { ...json, __planCarrier: true, __planPhase: 'claim-time', __planAction: json.action } }));
