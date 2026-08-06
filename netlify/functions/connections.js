const { sb, enc } = require('./lib/sb');
const { verifyRequest, AuthError } = require('./lib/auth');
const { json, originOk } = require('./lib/http');

// Safe columns per provider — access_token/refresh_token are never listed
// here and never leave the server.
const SAFE_COLUMNS = {
  quickbooks: 'realm_id,created_at,needs_reconnect',
  xero: 'tenant_id,created_at,needs_reconnect,chart_of_accounts',
  freshbooks: 'account_id,created_at,needs_reconnect',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (!originOk(event)) return json(403, { error: 'Forbidden' });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  let email;
  try {
    ({ email } = await verifyRequest(event));
  } catch (err) {
    return json(err instanceof AuthError ? err.statusCode : 401, { error: err.message });
  }

  const { provider, business_id } = event.queryStringParameters || {};
  const columns = SAFE_COLUMNS[provider];
  if (!columns) return json(400, { error: 'Unknown provider' });
  if (!business_id) return json(400, { error: 'Missing business_id' });

  try {
    const bizRows = await sb(`businesses?id=eq.${enc(business_id)}&select=user_email`);
    const biz = Array.isArray(bizRows) && bizRows[0];
    if (!biz || biz.user_email !== email) return json(403, { error: 'Not found or not yours' });

    const rows = await sb(`${provider}_connections?business_id=eq.${enc(business_id)}&select=${columns}`);
    return json(200, rows);
  } catch (err) {
    console.error('connections error:', err.message);
    return json(500, { error: 'Internal server error' });
  }
};
