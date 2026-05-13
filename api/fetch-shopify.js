// Triggered by Vercel cron daily at 08:10 UTC (≈3 AM CT summer / 2 AM CT winter)
// Manual trigger: POST /api/fetch-shopify with body { "secret": "<ADMIN_SECRET>" }
// Fetches YTD sales by channel from Shopify, then hands off to /api/commit for
// Paloma/Square/QB merging, GitHub commit, and Vercel redeploy.

const IG_CH  = new Set(['Draft Orders', 'IG Live Sales', 'Sugar Live Invoicer', 'Facebook & Instagram']);
const WEB_CH = new Set(['Online Store', 'Shop']);
const IP_CH  = new Set(['Point of Sale', 'Shopify Mobile for iPhone']);

const SHOPIFY_API_VER = '2025-10';

// ShopifyQL: net sales by channel by month, current year to date
const SHOPIFYQL = 'FROM sales SHOW net_sales GROUP BY month, sales_channel SINCE startOfYear(0y) UNTIL today ORDER BY month ASC';

async function getShopifyToken(domain, clientId, clientSecret) {
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Shopify token exchange failed (${res.status})`);
  const { access_token } = await res.json();
  if (!access_token) throw new Error('No access_token returned by Shopify');
  return access_token;
}

export default async function handler(req, res) {
  const isCron = req.headers['x-vercel-cron'] === '1';
  const isManual = req.method === 'POST' && req.body?.secret === process.env.ADMIN_SECRET;
  if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  const { SHOPIFY_STORE_DOMAIN: domain, SHOPIFY_CLIENT_ID: clientId, SHOPIFY_CLIENT_SECRET: clientSecret, ADMIN_SECRET: secret } = process.env;
  if (!domain || !clientId || !clientSecret || !secret) {
    return res.status(500).json({ error: 'Missing env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, ADMIN_SECRET' });
  }

  // 1. Obtain a short-lived Shopify access token via client_credentials
  let token;
  try {
    token = await getShopifyToken(domain, clientId, clientSecret);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  // 2. Run the ShopifyQL query
  const gqlRes = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VER}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: `{ shopifyqlQuery(query: ${JSON.stringify(SHOPIFYQL)}) { parseErrors tableData { columns { name dataType } rows } } }` }),
  });
  if (!gqlRes.ok) return res.status(502).json({ error: `Shopify GraphQL request failed: ${gqlRes.status}` });

  const gql = await gqlRes.json();
  if (gql.errors?.length) return res.status(502).json({ error: gql.errors[0].message });

  const { parseErrors, tableData } = gql.data?.shopifyqlQuery ?? {};
  if (parseErrors?.length) return res.status(502).json({ error: `ShopifyQL error: ${JSON.stringify(parseErrors[0])}` });
  if (!tableData?.rows?.length) return res.status(502).json({ error: 'ShopifyQL returned no rows' });

  // 3. Transform rows into byMonth — same shape the admin upload page sends to /api/commit
  //    { "2026-01": { ig: 0, web: 0, ip: 0 }, ... }
  const byMonth = {};
  for (const row of tableData.rows) {
    const m = row.month.slice(0, 7); // "2026-01-01" → "2026-01"
    const ch = row.sales_channel;
    const amt = Math.round(parseFloat(row.net_sales) || 0);
    if (!byMonth[m]) byMonth[m] = { ig: 0, web: 0, ip: 0 };
    if (IG_CH.has(ch))       byMonth[m].ig  += amt;
    else if (WEB_CH.has(ch)) byMonth[m].web += amt;
    else if (IP_CH.has(ch))  byMonth[m].ip  += amt;
  }
  if (!Object.keys(byMonth).length) return res.status(502).json({ error: 'No recognised sales channels in ShopifyQL response' });

  // 4. Delegate to /api/commit — it handles Paloma/Square/QB merging, GitHub commit, Vercel redeploy
  const commitRes = await fetch('https://sugarcoat-dashboard.vercel.app/api/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, byMonth }),
  });
  const commitJson = await commitRes.json();
  if (!commitRes.ok) return res.status(500).json({ error: commitJson.error || 'Commit failed' });

  res.json({ success: true, shopifyMonths: Object.keys(byMonth).sort(), ...commitJson });
}
