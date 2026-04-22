export default async function handler(req, res) {
  const { code, shop } = req.query;

  if (!code) return res.status(400).send('Missing code');

  const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code }),
  });

  const data = await tokenRes.json();

  if (!data.access_token) {
    return res.status(500).send(`Token exchange failed: ${JSON.stringify(data)}`);
  }

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><body style="font-family:monospace;padding:2rem;max-width:600px">
    <h2>Success</h2>
    <p>Add this as <strong>SHOPIFY_ACCESS_TOKEN</strong> in Vercel environment variables:</p>
    <input onclick="this.select()" readonly style="width:100%;padding:.5rem;font-size:13px" value="${data.access_token}" />
    <p style="color:#666;font-size:12px">Scope: ${data.scope}</p>
  </body></html>`);
}
