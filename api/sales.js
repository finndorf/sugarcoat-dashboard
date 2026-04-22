export default async function handler(req, res) {
  const { SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;

  const tokenRes = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'read_analytics',
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return res.status(500).json({ error: 'Token fetch failed', detail: tokenData });
  }
  // Temporary: expose token scope for debugging
  const tokenScope = tokenData.scope;

  const shopifyql = 'FROM sales SHOW net_sales GROUP BY month, sales_channel SINCE 2025-01-01 UNTIL 2026-04-30 ORDER BY month ASC';

  const gqlRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': tokenData.access_token,
    },
    body: JSON.stringify({
      query: `mutation { shopifyqlQuery(query: ${JSON.stringify(shopifyql)}) {
        __typename
        ... on TableResponse { tableData { rowData columns { name dataType } } }
        ... on ParseErrorResponse { parseErrors { code message } }
      }}`,
    }),
  });

  const data = await gqlRes.json();
  res.setHeader('Cache-Control', 's-maxage=3600');
  res.json({ tokenScope, data });
}
