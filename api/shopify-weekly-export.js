const REPO   = 'finndorf/sugarcoat-dashboard';
const FILE   = 'index.html';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const IG  = new Set(['Draft Orders', 'IG Live Sales', 'Sugar Live Invoicer', 'Facebook & Instagram']);
const WEB = new Set(['Online Store', 'Shop']);
const IP  = new Set(['Point of Sale', 'Shopify Mobile for iPhone']);

function fmtObj(obj) {
  const e = Object.entries(obj);
  return e.length ? '{' + e.map(([k,v]) => `'${k}':${v}`).join(',') + '}' : '{}';
}

export default async function handler(req, res) {
  // Allow Vercel cron (GET) or manual trigger via POST with secret
  if (req.method === 'POST' && req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN, GITHUB_TOKEN } = process.env;

  // Query ShopifyQL — note: query not mutation
  const shopifyql = 'FROM sales SHOW net_sales GROUP BY month, sales_channel SINCE 2025-01-01 ORDER BY month ASC';
  const gqlRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
    body: JSON.stringify({
      query: `query { shopifyqlQuery(query: ${JSON.stringify(shopifyql)}) {
        __typename
        ... on TableResponse { tableData { rowData columns { name dataType } } }
        ... on ParseErrorResponse { parseErrors { code message } }
      }}`,
    }),
  });

  const result = await gqlRes.json();
  const tableData = result.data?.shopifyqlQuery?.tableData;
  if (!tableData) return res.status(500).json({ error: 'ShopifyQL failed', detail: result });

  // Process rows into byMonth
  const { columns, rowData } = tableData;
  const mi = columns.findIndex(c => c.name === 'month');
  const ci = columns.findIndex(c => c.name === 'sales_channel');
  const ni = columns.findIndex(c => c.name === 'net_sales');

  const byMonth = {};
  for (const row of rowData) {
    const month   = row[mi].slice(0, 7);
    const channel = row[ci];
    const amount  = Math.round(parseFloat(row[ni]));
    if (!byMonth[month]) byMonth[month] = { ig: 0, web: 0, ip: 0 };
    if (IG.has(channel))       byMonth[month].ig  += amount;
    else if (WEB.has(channel)) byMonth[month].web += amount;
    else if (IP.has(channel))  byMonth[month].ip  += amount;
  }

  // Fetch current index.html from GitHub
  const ghHeaders = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
  const getRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, { headers: ghHeaders });
  if (!getRes.ok) return res.status(500).json({ error: 'Failed to fetch file from GitHub' });
  const { content: b64, sha } = await getRes.json();
  const html = Buffer.from(b64, 'base64').toString('utf8');

  // Preserve existing wwag
  let wwag = {};
  const wwagMatch = html.match(/const wwag\s*=\s*(\{[^;]+\})/);
  if (wwagMatch) {
    try { wwag = JSON.parse(wwagMatch[1].replace(/'/g,'"').replace(/([0-9]{4}-[0-9]{2}):/g,'"$1":')); } catch {}
  }

  // Build and replace data block
  const allMonths = [...new Set([...Object.keys(byMonth), ...Object.keys(wwag)])].sort();
  const dataIG = {}, dataWeb = {}, dataIP = {};
  for (const m of allMonths) {
    if (byMonth[m]?.ig)  dataIG[m]  = byMonth[m].ig;
    if (byMonth[m]?.web) dataWeb[m] = byMonth[m].web;
    if (byMonth[m]?.ip)  dataIP[m]  = byMonth[m].ip;
  }

  const first = allMonths[0], last = allMonths[allMonths.length - 1];
  const [fy,fm] = first.split('-'), [ly,lm] = last.split('-');
  const range = `${MONTHS[+fm-1]} ${fy} \u2013 ${MONTHS[+lm-1]} ${ly}`;

  const block = [
    '// BEGIN_DATA \u2014 updated by: node update.js',
    `const ALL_MONTHS=${JSON.stringify(allMonths)};`,
    `const dataIG  =${fmtObj(dataIG)};`,
    `const dataWeb =${fmtObj(dataWeb)};`,
    `const dataIP  =${fmtObj(dataIP)};`,
    `const wwag    =${fmtObj(wwag)};`,
    '// END_DATA',
  ].join('\n');

  let updated = html.replace(/\/\/ BEGIN_DATA[\s\S]*?\/\/ END_DATA/, block);
  updated = updated.replace(
    /(Instagram \u00b7 Website \u00b7 In-person \u00b7 WWAG.*?\u00b7\s*)([A-Z][a-z]+ \d{4} \u2013 [A-Z][a-z]+ \d{4})/,
    `$1${range}`
  );

  const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`, {
    method: 'PUT',
    headers: ghHeaders,
    body: JSON.stringify({
      message: `Auto-update dashboard data — ${new Date().toISOString().slice(0,10)}`,
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
