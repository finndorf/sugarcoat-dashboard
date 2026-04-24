const REPO   = 'finndorf/sugarcoat-dashboard';
const FILE   = 'index.html';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const MONTH_NAME = {
  January:1, February:2, March:3, April:4, May:5, June:6,
  July:7, August:8, September:9, October:10, November:11, December:12,
};

// --- CSV / file parsers (mirrors update.js logic) ---

function parseCSVLine(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
    else cur += c;
  }
  cols.push(cur);
  return cols;
}

function parsePalomaDate(str) {
  const parts = str.trim().split(' ');
  const m = MONTH_NAME[parts[0]];
  const yr = parts[2];
  if (!m || !yr) return null;
  return `${yr}-${String(m).padStart(2, '0')}`;
}

function parsePalomaText(text) {
  const out = {};
  const lines = text.split('\n');
  const header = parseCSVLine(lines[0].replace(/^﻿/, ''));
  const orderNumIdx = header.indexOf('Order number');
  const paidAtIdx   = header.indexOf('Paid at');
  const netIdx      = header.indexOf('Net');
  const seen = new Set();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    const orderNum = cols[orderNumIdx];
    if (!orderNum || seen.has(orderNum)) continue;
    seen.add(orderNum);
    const month = parsePalomaDate(cols[paidAtIdx] || '');
    if (!month) continue;
    const net = parseFloat(cols[netIdx]);
    if (!isNaN(net)) out[month] = (out[month] || 0) + net;
  }
  for (const m of Object.keys(out)) out[m] = Math.round(out[m]);
  return out;
}

function parseSquareText(text) {
  const out = {};
  const lines = text.split('\n');
  const header = parseCSVLine(lines[0].replace(/^﻿/, ''));
  const dateIdx     = header.indexOf('Date');
  const netSalesIdx = header.indexOf('Net Sales');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    const date = cols[dateIdx] || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const month = date.slice(0, 7);
    const net = parseFloat((cols[netSalesIdx] || '').replace(/[$,]/g, ''));
    if (!isNaN(net)) out[month] = (out[month] || 0) + net;
  }
  for (const m of Object.keys(out)) out[m] = Math.round(out[m]);
  return out;
}

function parseQuickBooksText(text) {
  const out = {};
  const lines = text.split('\n');
  const headerIdx = lines.findIndex(l => l.includes('Transaction date'));
  if (headerIdx === -1) return out;
  const header = parseCSVLine(lines[headerIdx]);
  const dateIdx = header.indexOf('Transaction date');
  const amtIdx  = header.indexOf('Amount');
  const nameIdx = header.indexOf('Name');
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    const date = (cols[dateIdx] || '').trim();
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) continue;
    if ((cols[nameIdx] || '').includes('Shopify')) continue;
    const [mo, , yr] = date.split('/');
    const month = `${yr}-${mo}`;
    const amt = parseFloat((cols[amtIdx] || '').replace(/[$,]/g, ''));
    if (!isNaN(amt)) out[month] = (out[month] || 0) + amt;
  }
  for (const m of Object.keys(out)) out[m] = Math.round(out[m]);
  return out;
}

// --- GitHub API helpers ---

function ghUrl(filePath) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${REPO}/contents/${encoded}`;
}

async function fetchRepoFileText(filePath, ghHeaders) {
  const res = await fetch(ghUrl(filePath), { headers: ghHeaders });
  if (!res.ok) return null;
  const { content } = await res.json();
  return Buffer.from(content, 'base64').toString('utf8');
}

async function fetchRepoDir(dirPath, ghHeaders) {
  const res = await fetch(ghUrl(dirPath), { headers: ghHeaders });
  if (!res.ok) return [];
  return res.json();
}

async function loadAndMerge(dirPath, parseFn, ghHeaders) {
  const merged = {};
  const files = await fetchRepoDir(dirPath, ghHeaders);
  await Promise.all(
    files.filter(f => f.name.endsWith('.csv')).map(async f => {
      const text = await fetchRepoFileText(f.path, ghHeaders);
      if (!text) return;
      for (const [m, v] of Object.entries(parseFn(text)))
        merged[m] = (merged[m] || 0) + v;
    })
  );
  return merged;
}

// --- Block helpers ---

function fmtObj(obj) {
  const e = Object.entries(obj);
  return e.length ? '{' + e.map(([k,v]) => `'${k}':${v}`).join(',') + '}' : '{}';
}

function buildBlock(allMonths, dataIG, dataWeb, dataIP, wwag) {
  const first = allMonths[0], last = allMonths[allMonths.length - 1];
  const [fy,fm] = first.split('-'), [ly,lm] = last.split('-');
  const range = `${MONTHS[+fm-1]} ${fy} – ${MONTHS[+lm-1]} ${ly}`;
  return {
    block: [
      '// BEGIN_DATA — updated by: node update.js',
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

  // Fetch current index.html and non-Shopify source files in parallel
  const [indexRes, paloma, square, qb] = await Promise.all([
    fetch(ghUrl(FILE), { headers: ghHeaders }),
    loadAndMerge('data/paloma',     parsePalomaText,     ghHeaders),
    loadAndMerge('data/square',     parseSquareText,     ghHeaders),
    loadAndMerge('data/quickbooks', parseQuickBooksText, ghHeaders),
  ]);

  if (!indexRes.ok) return res.status(500).json({ error: 'Failed to fetch index.html from GitHub' });
  const { content: b64, sha } = await indexRes.json();
  const html = Buffer.from(b64, 'base64').toString('utf8');

  function extractObj(varName) {
    const m = html.match(new RegExp(`const ${varName}\\s*=\\s*(\\{[^;]*\\})`));
    if (!m) return {};
    try { return JSON.parse(m[1].replace(/'/g,'"').replace(/([0-9]{4}-[0-9]{2}):/g,'"$1":')); } catch { return {}; }
  }

  let wwag = extractObj('wwag');
  if (wwagOverride) Object.assign(wwag, wwagOverride);

  // For months in the Shopify upload, recompute from all sources.
  // Months not in the upload are left as-is from the existing index.html.
  const dataIG  = extractObj('dataIG');
  const dataWeb = extractObj('dataWeb');
  const dataIP  = extractObj('dataIP');

  for (const m of Object.keys(byMonth || {})) {
    const ig = (byMonth[m].ig || 0) + (paloma[m] || 0);
    if (ig) dataIG[m] = ig; else delete dataIG[m];
    if (byMonth[m].web) dataWeb[m] = byMonth[m].web; else delete dataWeb[m];
    const ip = (byMonth[m].ip || 0) + (square[m] || 0) + (qb[m] || 0);
    if (ip) dataIP[m] = ip; else delete dataIP[m];
  }

  const allMonths = [...new Set([
    ...Object.keys(dataIG), ...Object.keys(dataWeb),
    ...Object.keys(dataIP), ...Object.keys(wwag),
  ])].sort();

  const { block, range } = buildBlock(allMonths, dataIG, dataWeb, dataIP, wwag);

  let updated = html.replace(/\/\/ BEGIN_DATA[\s\S]*?\/\/ END_DATA/, block);
  updated = updated.replace(
    /(Instagram · Website · In-person · WWAG.*?·\s*)([A-Z][a-z]+ \d{4} – [A-Z][a-z]+ \d{4})/,
    `$1${range}`
  );

  const putRes = await fetch(ghUrl(FILE), {
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
