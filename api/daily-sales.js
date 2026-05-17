// Returns yesterday's Shopify sales by channel (IG, Website, In-person POS).
// Used by sugarcoat-home to power the "Yesterday" section on the Sales page.
// WWAG and Square are excluded — those sources only have monthly data.
//
// GET /api/daily-sales?secret=<ADMIN_SECRET>

const IG_CH  = new Set(['Draft Orders', 'IG Live Sales', 'Sugar Live Invoicer', 'Facebook & Instagram']);
const WEB_CH = new Set(['Online Store', 'Shop']);
const IP_CH  = new Set(['Point of Sale', 'Shopify Mobile for iPhone']);

const SHOPIFY_API_VER = '2025-10';

async function getShopifyToken(domain, clientId, clientSecret) {
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const { access_token } = await res.json();
  if (!access_token) throw new Error('No access_token');
  return access_token;
}

// Returns YYYY-MM-DD for today + offsetDays, computed in America/Chicago timezone.
function localDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y   = parseInt(parts.find(p => p.type === 'year').value, 10);
  const mon = parseInt(parts.find(p => p.type === 'month').value, 10);
  const d   = parseInt(parts.find(p => p.type === 'day').value, 10);
  return new Date(Date.UTC(y, mon - 1, d + offsetDays, 12, 0, 0)).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const secret = req.method === 'GET' ? req.query?.secret : req.body?.secret;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { SHOPIFY_STORE_DOMAIN: domain, SHOPIFY_CLIENT_ID: clientId, SHOPIFY_CLIENT_SECRET: clientSecret } = process.env;
  if (!domain || !clientId || !clientSecret) {
    return res.status(500).json({ error: 'Missing Shopify env vars' });
  }

  const yesterday = localDate(-1);
  const today     = localDate(0);
  const shopifyqlQuery = `FROM sales SHOW net_sales GROUP BY day, sales_channel SINCE ${yesterday} UNTIL ${today} ORDER BY day ASC`;

  let token;
  try {
    token = await getShopifyToken(domain, clientId, clientSecret);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const gqlRes = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VER}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: `{ shopifyqlQuery(query: ${JSON.stringify(shopifyqlQuery)}) { parseErrors tableData { columns { name dataType } rows } } }` }),
  });

  if (!gqlRes.ok) return res.status(502).json({ error: `GraphQL failed: ${gqlRes.status}` });

  const gql = await gqlRes.json();
  if (gql.errors?.length) return res.status(502).json({ error: gql.errors[0].message });

  const { parseErrors, tableData } = gql.data?.shopifyqlQuery ?? {};
  if (parseErrors?.length) return res.status(502).json({ error: `ShopifyQL: ${JSON.stringify(parseErrors[0])}` });

  const byChannel = { ig: 0, web: 0, ip: 0 };

  if (tableData?.rows?.length) {
    for (const row of tableData.rows) {
      const ch  = row.sales_channel;
      const amt = Math.round(parseFloat(row.net_sales) || 0);
      if (IG_CH.has(ch))       byChannel.ig  += amt;
      else if (WEB_CH.has(ch)) byChannel.web += amt;
      else if (IP_CH.has(ch))  byChannel.ip  += amt;
    }
  }

  const total = byChannel.ig + byChannel.web + byChannel.ip;
  return res.json({ date: yesterday, byChannel, total, asOf: new Date().toISOString() });
}
