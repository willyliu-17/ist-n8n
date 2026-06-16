/**
 * n8n Code Node
 *
 * Input:
 * - Paste Slack message URLs
 *
 * Output:
 * - [{ channel, ts }]
 *   ready for Slack "Delete Message" node
 */

const messageUrls = `https://17media.slack.com/archives/C09F0SYG57D/p1772703390506069
https://17media.slack.com/archives/C09F0SYG57D/p1772703390684799
https://17media.slack.com/archives/C09F0SYG57D/p1772703453774639
https://17media.slack.com/archives/C09F0SYG57D/p1772703543322569
https://17media.slack.com/archives/C09F0SYG57D/p1772703656673359
https://17media.slack.com/archives/C09F0SYG57D/p1772703687184609
https://17media.slack.com/archives/C09F0SYG57D/p1772703719225809
https://17media.slack.com/archives/C09F0SYG57D/p1772703770278999
https://17media.slack.com/archives/C09F0SYG57D/p1772703803510249
https://17media.slack.com/archives/C09F0SYG57D/p1772703834160699
https://17media.slack.com/archives/C09F0SYG57D/p1772703868984719
https://17media.slack.com/archives/C09F0SYG57D/p1772703925834889
https://17media.slack.com/archives/C09F0SYG57D/p1772703964000279
`.trim().split('\n');

function parseSlackTs(pValue) {
  // p1766454683545999 → 1766454683.545999
  const raw = pValue.slice(1); // remove 'p'
  return `${raw.slice(0, 10)}.${raw.slice(10)}`;
}

const results = [];

for (const url of messageUrls) {
  const match = url.match(/archives\/([^/]+)\/(p\d+)/);
  if (!match) continue;

  const channel = match[1];
  const pValue = match[2];
  const ts = parseSlackTs(pValue);

  results.push({
    json: {
      channel,
      ts,
    }
  });
}

return results;