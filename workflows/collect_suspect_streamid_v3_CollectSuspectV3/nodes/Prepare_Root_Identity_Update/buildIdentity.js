function buildRootIdentityUpdates(rows, queryConfig) {
  const candidates = new Map();
  const escape = value => String(value == null || value === '' ? '未取得' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const { candidate, stream } of rows) {
    if (stream?.role !== 'current') continue;
    if (!candidate?.candidateKey || !['C09F0SYG57D', 'C0A4JJJKJMD'].includes(candidate.channel)
      || !/^\d{10,}\.\d{6}$/.test(candidate.threadTS || '') || String(candidate.streamID) !== String(stream.liveStreamID)) {
      throw new Error('history_root_identity_mismatch');
    }
    if (candidates.has(candidate.candidateKey)) throw new Error('history_duplicate_root_identity');
    const context = stream.streamContext || {};
    if (context.liveStreamID && String(context.liveStreamID) !== String(candidate.streamID)) throw new Error('history_root_context_mismatch');
    const sources = JSON.parse(candidate.sourcesJson);
    const keywords = sources.some(s => s === 'commentCaptionKeyword' || s === 'captionKeyword') ? '\nHit Keywords: ' + escape(queryConfig.searchKeywords) : '';
    const conditions = sources.includes('endByNewStream') ? '\nHit Conditions: Prev endByNewStream + Restart in 60s + Contracted TW streamer' : '';
    candidates.set(candidate.candidateKey, {
      channel: candidate.channel,
      threadTS: candidate.threadTS,
      text: '自動化檢測詳情\nuserID: ' + escape(context.userID) + '\nopenID: ' + escape(context.openID)
        + '\nStreamID: ' + escape(candidate.streamID) + '\n來源: ' + sources.map(escape).join(', ')
        + keywords + conditions + (candidate.prevStreamID ? '\nPrevStreamID: ' + escape(candidate.prevStreamID) : ''),
    });
  }
  return [...candidates.values()];
}
if (typeof module !== 'undefined') module.exports = { buildRootIdentityUpdates };
if (typeof $input !== 'undefined') {
  return buildRootIdentityUpdates($input.all().map(i => i.json), $('Build Candidate Query Config').first().json).map(json => ({ json }));
}
