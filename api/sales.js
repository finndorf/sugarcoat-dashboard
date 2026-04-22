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

  const gqlRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': tokenData.access_token,
    },
    body: JSON.stringify({ query: '{ shop { name plan { displayName } } }' }),
  });

  const data = await gqlRes.json();
  res.json({ tokenScope, data });
}
