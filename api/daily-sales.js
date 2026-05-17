// Returns yesterday's sales by channel: Shopify (IG, Website, In-person POS) + WWAG.
// Used by sugarcoat-home to power the "Yesterday" section on the Sales page.
// Square is no longer a data source.
//
// GET /api/daily-sales?secret=<ADMIN_SECRET>

const IG_CH  = new Set(['Draft Orders', 'IG Live Sales', 'Sugar Live Invoicer', 'Facebook & Instagram']);
const WEB_CH = new Set(['Online Store', 'Shop']);
const IP_CH  = new Set(['Point of Sale', 'Shopify Mobile for iPhone']);

const SHOPIFY_API_VER = '2025-10';

// Returns YYYY-MM-DD for today + offsetDays in America/Chicago timezone.
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

async function getShopifyToken(domain, clientId, clientSecret) {
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Shopify token exchange failed (${res.status})`);
  const { access_token } = await res.json();
  if (!access_token) throw new Error('No Shopify access_token');
  return access_token;
}

// Returns { ig, web, ip } for yesterday from Shopify ShopifyQL.
async function fetchShopifyDaily(domain, clientId, clientSecret, yesterday, today) {
  const token = await getShopifyToken(domain, clientId, clientSecret);
  const shopifyqlQuery = `FROM sales SHOW net_sales GROUP BY day, sales_channel SINCE ${yesterday} UNTIL ${today} ORDER BY day ASC`;

  const gqlRes = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VER}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: `{ shopifyqlQuery(query: ${JSON.stringify(shopifyqlQuery)}) { parseErrors tableData { columns { name dataType } rows } } }` }),
  });
  if (!gqlRes.ok) throw new Error(`Shopify GraphQL failed: ${gqlRes.status}`);

  const gql = await gqlRes.json();
  if (gql.errors?.length) throw new Error(gql.errors[0].message);

  const { parseErrors, tableData } = gql.data?.shopifyqlQuery ?? {};
  if (parseErrors?.length) throw new Error(`ShopifyQL: ${JSON.stringify(parseErrors[0])}`);

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
  return byChannel;
}

// Returns yesterday's WWAG total from Mall-Central, or 0 if no sales, or null on error.
async function fetchWWAGDaily(dsc, vendor, password, yesterday) {
  const [yr, mo, dy] = yesterday.split('-');
  const dateFormatted = `${mo}/${dy}/${yr}`; // MM/DD/YYYY as used in the CSV

  const form = new URLSearchParams({
    dsc, vendor, password,
    dates: 'YTD',
    sort_by: 'Date',
    repeatvisit: '0',
    last_dsc: '', last_vendor: '', sponsor: '',
  });
  const reportRes = await fetch('https://www.mall-central.com/cgi-bin/mc-report.cgi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    body: form.toString(),
  });
  if (!reportRes.ok) return null;
  const html = await reportRes.text();

  const match = html.match(/excel[/\\]+excel_wwag_\d+_\w+\.csv/i);
  if (!match) return 0; // no WWAG sales recorded (not an error)

  const csvRes = await fetch(`https://www.mall-central.com/${match[0].replace(/\\/g, '/')}`);
  if (!csvRes.ok) return null;
  const csvText = await csvRes.text();

  let total = 0;
  for (const line of csvText.split('\n').slice(1)) {
    const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
    if (cols[0] !== dateFormatted) continue;
    const amt = parseFloat(cols[8]);
    if (!isNaN(amt)) total += amt;
  }
  return Math.round(total);
}

export default async function handler(req, res) {
  const secret = req.method === 'GET' ? req.query?.secret : req.body?.secret;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    SHOPIFY_STORE_DOMAIN: domain,
    SHOPIFY_CLIENT_ID: clientId,
    SHOPIFY_CLIENT_SECRET: clientSecret,
    MALL_CENTRAL_DSC: dsc,
    MALL_CENTRAL_VENDOR: vendor,
    MALL_CENTRAL_PASSWORD: password,
  } = process.env;

  if (!domain || !clientId || !clientSecret) {
    return res.status(500).json({ error: 'Missing Shopify env vars' });
  }

  const yesterday = localDate(-1);
  const today     = localDate(0);

  const [shopify, wwag] = await Promise.all([
    fetchShopifyDaily(domain, clientId, clientSecret, yesterday, today).catch(() => null),
    (dsc && vendor && password)
      ? fetchWWAGDaily(dsc, vendor, password, yesterday).catch(() => null)
      : Promise.resolve(null),
  ]);

  const byChannel = {
    ig:   shopify?.ig  ?? 0,
    web:  shopify?.web ?? 0,
    ip:   shopify?.ip  ?? 0,
    wwag: wwag         ?? 0,
  };
  const total = byChannel.ig + byChannel.web + byChannel.ip + byChannel.wwag;

  return res.json({ date: yesterday, byChannel, total, asOf: new Date().toISOString() });
}
