const IG  = new Set(['Draft Orders', 'IG Live Sales', 'Sugar Live Invoicer', 'Facebook & Instagram']);
const WEB = new Set(['Online Store', 'Shop']);
const IP  = new Set(['Point of Sale', 'Shopify Mobile for iPhone']);

export default async function handler(req, res) {
  const { SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN } = process.env;

  const shopifyql = 'FROM sales SHOW net_sales GROUP BY month, sales_channel SINCE 2025-01-01 ORDER BY month ASC';

  const gqlRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({
      query: `mutation { shopifyqlQuery(query: ${JSON.stringify(shopifyql)}) {
        __typename
        ... on TableResponse { tableData { rowData columns { name dataType } } }
        ... on ParseErrorResponse { parseErrors { code message } }
      }}`,
    }),
  });

  const result = await gqlRes.json();
  const tableData = result.data?.shopifyqlQuery?.tableData;
  if (!tableData) return res.status(500).json(result);

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

  res.setHeader('Cache-Control', 's-maxage=3600');
  res.json(byMonth);
}
