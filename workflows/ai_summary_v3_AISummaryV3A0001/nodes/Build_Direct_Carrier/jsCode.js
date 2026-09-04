return $input.all().map(({ json }) => ({ json: { kind: 'carrier', input: json, requestKey: json.requestKey } }));
