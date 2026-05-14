// Triggered by Vercel cron daily at 01:00 UTC (7–8 PM CT year-round, after Mall-Central's 6:15 PM update)
// Manual trigger: POST /api/fetch-wwag with body { "secret": "<ADMIN_SECRET>" }

const REPO = 'finndorf/sugarcoat-dashboard';
const FILE = 'index.html';

function parseWWAGCSV(text) {
  const out = {};
  for (const line of text.split('\n').slice(1)) {
    const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
    const date = cols[0];
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) continue;
    const [mo, , yr] = date.split('/');
    const month = `${yr}-${mo}`;
    const amt = parseFloat(cols[8]);
    if (!isNaN(amt)) out[month] = (out[month] || 0) + amt;
  }
  for (const m of Object.keys(out)) out[m] = Math.round(out[m]);
  return out;
}

function fmtObj(obj) {
  const e = Object.entries(obj);
  return e.length ? '{' + e.map(([k, v]) => `'${k}':${v}`).join(',') + '}' : '{}';
}

function ghUrl(path) {
  return `https://api.github.com/repos/${REPO}/contents/${path}`;
}

export default async function handler(req, res) {
  const isCron = req.headers['x-vercel-cron'] === '1';
  const isManual = req.method === 'POST' && req.body?.secret === process.env.ADMIN_SECRET;
  if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  const { MALL_CENTRAL_DSC: dsc, MALL_CENTRAL_VENDOR: vendor, MALL_CENTRAL_PASSWORD: password, GITHUB_TOKEN: token } = process.env;
  if (!dsc || !vendor || !password || !token) {
    return res.status(500).json({ error: 'Missing env vars: MALL_CENTRAL_DSC, MALL_CENTRAL_VENDOR, MALL_CENTRAL_PASSWORD, GITHUB_TOKEN' });
  }

  // 1. POST to Mall-Central — generates a temporary CSV download link
  const form = new URLSearchParams({
    dsc, vendor, password,
    dates: 'YTD',
    sort_by: 'Date',
    repeatvisit: '0',
    last_dsc: '',
    last_vendor: '',
    sponsor: '',
  });
  const reportRes = await fetch('https://www.mall-central.com/cgi-bin/mc-report.cgi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    body: form.toString(),
  });
  if (!reportRes.ok) return res.status(502).json({ error: `Mall-Central returned ${reportRes.status}` });
  const html = await reportRes.text();

  // 2. Extract the CSV link — Mall-Central uses backslashes: ..\excel\excel_wwag_36_TOKEN.csv
  const match = html.match(/excel[/\\]+excel_wwag_\d+_\w+\.csv/i);
  if (!match) return res.status(502).json({ error: 'CSV link not found in Mall-Central response — check credentials or no YTD sales available' });
  const csvPath = match[0].replace(/\\/g, '/');

  // 3. Download the CSV immediately (before the 10-min expiry)
  const csvRes = await fetch(`https://www.mall-central.com/${csvPath}`);
  if (!csvRes.ok) return res.status(502).json({ error: `CSV download failed: ${csvRes.status}` });
  const csvText = await csvRes.text();

  // 4. Parse WWAG sales by month
  const newWwag = parseWWAGCSV(csvText);
  if (!Object.keys(newWwag).length) return res.status(502).json({ error: 'No WWAG data parsed from CSV' });

  // 5. Fetch current index.html from GitHub
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const indexRes = await fetch(ghUrl(FILE), { headers: ghHeaders });
  if (!indexRes.ok) return res.status(500).json({ error: 'Failed to fetch index.html from GitHub' });
  const { content: b64, sha } = await indexRes.json();
  const indexHtml = Buffer.from(b64, 'base64').toString('utf8');

  // 6. Extract existing wwag and merge — YTD data overwrites current-year months,
  //    prior-year months already in the dashboard are preserved
  const wwagMatch = indexHtml.match(/const wwag\s*=\s*(\{[^;]*\})/);
  let wwag = {};
  if (wwagMatch) {
    try { wwag = JSON.parse(wwagMatch[1].replace(/'/g, '"').replace(/([0-9]{4}-[0-9]{2}):/g, '"$1":')); } catch {}
  }
  Object.assign(wwag, newWwag);

  // 7. Splice the updated wwag line back into the data block
  const WWAG_RE = /(const wwag\s*=\s*)[^;]+;/;
  if (!WWAG_RE.test(indexHtml)) return res.status(500).json({ error: 'Could not locate wwag variable in index.html' });
  const updated = indexHtml.replace(WWAG_RE, `$1${fmtObj(wwag)};`);
  if (updated === indexHtml) {
    return res.json({ success: true, noChange: true, months: Object.keys(newWwag).sort(), date: new Date().toISOString().slice(0, 10) });
  }

  // 8. Commit to GitHub — Vercel auto-redeploys on push
  const today = new Date().toISOString().slice(0, 10);
  const putRes = await fetch(ghUrl(FILE), {
    method: 'PUT',
    headers: ghHeaders,
    body: JSON.stringify({
      message: `Auto-update WWAG data — ${today}`,
      content: Buffer.from(updated).toString('base64'),
      sha,
    }),
  });

  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    return res.status(500).json({ error: err.message || 'GitHub commit failed' });
  }

  res.json({ success: true, months: Object.keys(newWwag).sort(), updated: Object.keys(newWwag).length, date: today });
}
