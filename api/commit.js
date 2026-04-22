const REPO   = 'finndorf/sugarcoat-dashboard';
const FILE   = 'index.html';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtObj(obj) {
  const e = Object.entries(obj);
  return e.length ? '{' + e.map(([k,v]) => `'${k}':${v}`).join(',') + '}' : '{}';
}

function buildBlock(allMonths, dataIG, dataWeb, dataIP, wwag) {
  const first = allMonths[0], last = allMonths[allMonths.length - 1];
  const [fy,fm] = first.split('-'), [ly,lm] = last.split('-');
  const range = `${MONTHS[+fm-1]} ${fy} \u2013 ${MONTHS[+lm-1]} ${ly}`;
  return {
    block: [
      '// BEGIN_DATA \u2014 updated by: node update.js',
      `const ALL_MONTHS=${JSON.stringify(allMonths)};`,
      `const dataIG  =${fmtObj(dataIG)};`,
      `const dataWeb =${fmtObj(dataWeb)};`,
      `const dataIP  =${fmtObj(dataIP)};`,
      `const wwag    =${fmtObj(wwag)};`,
      '// END_DATA',
    ].join('\n'),
    range,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { secret, byMonth, wwag: wwagOverride } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Invalid password' });

  const token = process.env.GITHUB_TOKEN;
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

  // Fetch current index.html
  const getRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, { headers: ghHeaders });
  if (!getRes.ok) return res.status(500).json({ error: 'Failed to fetch file from GitHub' });
  const { content: b64, sha } = await getRes.json();
  const html = Buffer.from(b64, 'base64').toString('utf8');

  // Extract existing wwag
  let wwag = {};
  const wwagMatch = html.match(/const wwag\s*=\s*(\{[^;]+\})/);
  if (wwagMatch) {
    try { wwag = JSON.parse(wwagMatch[1].replace(/'/g,'"').replace(/([0-9]{4}-[0-9]{2}):/g,'"$1":')); } catch {}
  }
  if (wwagOverride) Object.assign(wwag, wwagOverride);

  // Build data objects
  const allMonths = [...new Set([...Object.keys(byMonth), ...Object.keys(wwag)])].sort();
  const dataIG = {}, dataWeb = {}, dataIP = {};
  for (const m of allMonths) {
    if (byMonth[m]?.ig)  dataIG[m]  = byMonth[m].ig;
    if (byMonth[m]?.web) dataWeb[m] = byMonth[m].web;
    if (byMonth[m]?.ip)  dataIP[m]  = byMonth[m].ip;
  }

  const { block, range } = buildBlock(allMonths, dataIG, dataWeb, dataIP, wwag);

  // Replace data block and date range
  let updated = html.replace(/\/\/ BEGIN_DATA[\s\S]*?\/\/ END_DATA/, block);
  updated = updated.replace(
    /(Instagram \u00b7 Website \u00b7 In-person \u00b7 WWAG.*?\u00b7\s*)([A-Z][a-z]+ \d{4} \u2013 [A-Z][a-z]+ \d{4})/,
    `$1${range}`
  );

  // Commit to GitHub
  const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
    method: 'PUT',
    headers: ghHeaders,
    body: JSON.stringify({
      message: `Update dashboard data — ${new Date().toISOString().slice(0,10)}`,
      content: Buffer.from(updated).toString('base64'),
      sha,
    }),
  });

  if (!putRes.ok) {
    const err = await putRes.json();
    return res.status(500).json({ error: err.message || 'GitHub commit failed' });
  }

  res.json({ success: true, months: allMonths.length, range });
}
