return $input.all().map(({ json }) => ({ json: { ...json, __planCarrier: true, __planPhase: 'pre-ai', __planAction: json.action } }));
