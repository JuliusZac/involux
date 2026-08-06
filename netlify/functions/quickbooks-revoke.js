const https = require('https');
const { sb, enc } = require('./lib/sb');
const { verifyRequest, AuthError } = require('./lib/auth');
const { json, originOk } = require('./lib/http');

const REVOKE_HOST = 'developer.api.intuit.com';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (!originOk(event)) return json(403, { error: 'Forbidden' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let email;
  try {
    ({ email } = await verifyRequest(event));
  } catch (err) {
    return json(err instanceof AuthError ? err.statusCode : 401, { error: err.message });
  }

  let business_id;
  try {
    ({ business_id } = JSON.parse(event.body || '{}'));
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (!business_id) return json(400, { error: 'Missing business_id' });

  try {
    const bizRows = await sb(`businesses?id=eq.${enc(business_id)}&select=user_email`);
    const biz = Array.isArray(bizRows) && bizRows[0];
    if (!biz || biz.user_email !== email) return json(403, { error: 'Not found or not yours' });

    const connRows = await sb(`quickbooks_connections?business_id=eq.${enc(business_id)}&select=refresh_token`);
    const refresh_token = Array.isArray(connRows) && connRows[0] && connRows[0].refresh_token;

    if (refresh_token) await revoke(refresh_token);

    await sb(`quickbooks_connections?business_id=eq.${enc(business_id)}`, { method: 'DELETE' });
    return json(200, { success: true });
  } catch (err) {
    console.error('QuickBooks revoke error:', err.message);
    return json(500, { error: 'Internal server error' });
  }
};

function revoke(refresh_token) {
  const clientId     = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret  = process.env.QUICKBOOKS_CLIENT_SECRET;
  const credentials   = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body          = JSON.stringify({ token: refresh_token });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: REVOKE_HOST,
      path:     '/v2/oauth2/tokens/revoke',
      method:   'POST',
      headers: {
        'Authorization':  `Basic ${credentials}`,
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) console.warn(`QuickBooks revoke returned ${res.statusCode}: ${data}`);
        else console.log('QuickBooks token revoked successfully');
        resolve();
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
