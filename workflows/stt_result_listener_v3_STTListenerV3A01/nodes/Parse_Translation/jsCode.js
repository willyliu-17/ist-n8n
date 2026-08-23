const response = $input.first().json;
const text = response?.content?.parts?.[0]?.text;
if (typeof text !== 'string' || !text.trim()) throw new Error('Gemini translation response is empty or malformed');
return [{ json: { ...$('Guard Side Effect Owner').first().json, translatedDialogue: text.trim() } }];
