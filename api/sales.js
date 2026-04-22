const IG_CHANNELS  = new Set(['Draft Orders', 'IG Live Sales', 'Sugar Live Invoicer', 'Facebook & Instagram']);
const WEB_CHANNELS = new Set(['Online Store', 'Shop']);
const IP_CHANNELS  = new Set(['Point of Sale', 'Shopify Mobile for iPhone']);

export default async function handler(req, res) {
  const { SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;

  const tokenRes = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'read_analytics,read_orders,read_all_orders',
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return res.status(500).json({ error: 'Token fetch failed', detail: tokenData });
  }

  const byMonth = {};
  const seenChannels = new Set();
  let totalOrders = 0;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const after = cursor ? `, after: ${JSON.stringify(cursor)}` : '';
    const gqlRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': tokenData.access_token,
      },
      body: JSON.stringify({
        query: `{
          orders(first: 250, query: "created_at:>=2025-01-01"${after}) {
            edges {
              node {
                createdAt
                channelInformation { channelDefinition { channelName } }
                currentSubtotalPriceSet { shopMoney { amount } }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      }),
    });

    const result = await gqlRes.json();
    if (result.errors) return res.status(500).json({ error: result.errors });

    const { edges, pageInfo } = result.data.orders;

    for (const { node } of edges) {
      const month = node.createdAt.slice(0, 7);
      const channel = node.channelInformation?.channelDefinition?.channelName ?? '';
      const amount = parseFloat(node.currentSubtotalPriceSet.shopMoney.amount);
      seenChannels.add(channel);
      totalOrders++;

      if (!byMonth[month]) byMonth[month] = { ig: 0, web: 0, ip: 0 };

      if (IG_CHANNELS.has(channel))       byMonth[month].ig += amount;
      else if (WEB_CHANNELS.has(channel)) byMonth[month].web += amount;
      else if (IP_CHANNELS.has(channel))  byMonth[month].ip += amount;
    }

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  // Round to avoid floating point noise
  for (const m of Object.values(byMonth)) {
    m.ig  = Math.round(m.ig);
    m.web = Math.round(m.web);
    m.ip  = Math.round(m.ip);
  }

  res.setHeader('Cache-Control', 's-maxage=3600');
  res.json({ byMonth, debug: { seenChannels: [...seenChannels].sort(), totalOrders } });
}
