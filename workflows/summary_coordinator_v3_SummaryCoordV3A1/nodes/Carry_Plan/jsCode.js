return $input.all().map(({ json }) => ({ json: { ...json, __planCarrier: true } }));
