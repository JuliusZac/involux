const https = require('https');

const SB_URL     = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST = 'oauth.platform.intuit.com';
const QB_HOST    = process.env.QUICKBOOKS_ENVIRONMENT === 'production'
  ? 'quickbooks.api.intuit.com'
  : 'sandbox-quickbooks.api.intuit.com';

exports.handler = async (event) => {
  const { business_id } = event.queryStringParameters || {};
  if (!business_id) return json(400, { error: 'Missing business_id' });

  try {
    const conn = await getConnection(business_id);
    if (!conn) return json(404, { error: 'QuickBooks not connected' });

    let { access_token, refresh_token, realm_id, expires_at } = conn;
    if (new Date(expires_at) <= new Date(Date.now() + 5 * 60 * 1000)) {
      const r = await refreshToken(refresh_token);
      access_token  = r.access_token;
      refresh_token = r.refresh_token;
      await saveTokens(business_id, access_token, refresh_token,
        new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString());
    }

    const res = await qb(realm_id, access_token,
      `query?query=${encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 200")}&minorversion=65`);
    const accounts = (res.QueryResponse?.Account || [])
      .filter(a => a.Active !== false)
      .map(a => ({ id: a.Id, name: a.Name, type: a.AccountSubType || a.AccountType }));

    return json(200, { accounts });
  } catch (err) {
    console.error('QB accounts error:', err.message);
    return json(500, { error: err.message });
  }
};

function qb(realm_id, access_token, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: QB_HOST,
      path: `/v3/company/${realm_id}/${path}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`QB parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function enc(s) { return encodeURIComponent(s); }

function sb(path, opts = {}) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  const method = opts.method || 'GET';
  const payload = opts.body || null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SB_URL,
      path: `/rest/v1/${path}`,
      method,
      headers: {
        'apikey': key, 'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json', 'Accept': 'application/json',
        ...(opts.headers || {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Supabase ${res.statusCode}: ${data}`));
        resolve(data ? JSON.parse(data) : {});
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getConnection(business_id) {
  const data = await sb(`quickbooks_connections?business_id=eq.${enc(business_id)}&select=access_token,refresh_token,realm_id,expires_at`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function refreshToken(refresh_token) {
  const creds = Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64');
  const body  = new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKEN_HOST, path: '/oauth2/v1/tokens/bearer', method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function saveTokens(business_id, access_token, refresh_token, expires_at) {
  await sb(`quickbooks_connections?business_id=eq.${enc(business_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ access_token, refresh_token, expires_at }),
    headers: { 'Prefer': 'return=minimal' },
  });
}

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
