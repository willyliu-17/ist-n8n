const input = $input.first().json;
const markdown = String(input.row && input.row.summaryMarkdown || '');
if (!markdown) throw new Error('missing persisted summary markdown');
return [{ json: input, binary: { data: { data: Buffer.from(markdown, 'utf8').toString('base64'), fileName: `summary-${input.input.requestKey}.md`, mimeType: 'text/markdown' } } }];
