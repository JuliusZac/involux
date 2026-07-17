const https = require('https');

const APP_URL     = 'https://involux.ca';
const SB_URL      = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST  = 'identity.xero.com';
const REDIRECT_URI = 'https://involux.ca/.netlify/functions/xero-callback';

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  if (error) {
    return redirect(`${APP_URL}/app.html?xeroError=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return redirect(`${APP_URL}/app.html?xeroError=missing_params`);
  }

  let business_id;
  try {
    ({ business_id } = JSON.parse(Buffer.from(state, 'base64').toString('utf8')));
  } catch {
    return redirect(`${APP_URL}/app.html?xeroError=invalid_state`);
  }

  if (!business_id) {
    return redirect(`${APP_URL}/app.html?xeroError=missing_business_id`);
  }

  try {
    const tokens = await exchangeCode(code);

    if (tokens.error) {
      console.error('Xero token exchange error:', tokens.error, tokens.error_description);
      return redirect(`${APP_URL}/app.html?xeroError=${encodeURIComponent(tokens.error_description || tokens.error)}`);
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error('Xero missing tokens:', JSON.stringify(tokens));
      return redirect(`${APP_URL}/app.html?xeroError=no_tokens`);
    }

    // Xero requires a tenantId for every API call — fetch it from /connections
    const tenantId = await getTenantId(tokens.access_token);
    if (!tenantId) {
      return redirect(`${APP_URL}/app.html?xeroError=no_tenant`);
    }

    const expires_at = new Date(Date.now() + (tokens.expires_in || 1800) * 1000).toISOString();

    // Fetch expense accounts and store as chart_of_accounts for use at scan time
    const chartOfAccounts = await fetchExpenseAccounts(tokens.access_token, tenantId);

    await upsertConnection({
      business_id,
      access_token:     tokens.access_token,
      refresh_token:    tokens.refresh_token,
      tenant_id:        tenantId,
      expires_at,
      chart_of_accounts: chartOfAccounts,
    });

    console.log(`Xero connected for business ${business_id}, tenant ${tenantId}, ${chartOfAccounts.length} accounts stored`);
    return redirect(`${APP_URL}/app.html?xeroConnected=true`);

  } catch (err) {
    console.error('Xero callback error:', err.message);
    return redirect(`${APP_URL}/app.html?xeroError=${encodeURIComponent(err.message)}`);
  }
};

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}

function exchangeCode(code) {
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body         = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKEN_HOST,
      path:     '/connect/token',
      method:   'POST',
      headers: {
        'Authorization':  `Basic ${credentials}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Xero token parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getTenantId(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.xero.com',
      path:     '/connections',
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept':        'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const connections = JSON.parse(data);
          const org = Array.isArray(connections)
            ? connections.find(c => c.tenantType === 'ORGANISATION') || connections[0]
            : null;
          resolve(org?.tenantId || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchExpenseAccounts(accessToken, tenantId) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.xero.com',
      path:     '/api.xro/2.0/Accounts?where=Class%3D%3D%22EXPENSE%22',
      method:   'GET',
      headers: {
        'Authorization':  `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Accept':         'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const accounts = (parsed.Accounts || [])
            .filter(a => a.Status === 'ACTIVE' && a.Code)
            .map(a => ({ code: a.Code, name: a.Name }));
          resolve(accounts);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

function upsertConnection({ business_id, access_token, refresh_token, tenant_id, expires_at, chart_of_accounts }) {
  const key     = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  const payload = JSON.stringify({
    business_id,
    access_token,
    refresh_token,
    tenant_id,
    expires_at,
    chart_of_accounts: chart_of_accounts || [],
    created_at: new Date().toISOString(),
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SB_URL,
      path:     '/rest/v1/xero_connections?on_conflict=business_id',
      method:   'POST',
      headers: {
        'apikey':         key,
        'Authorization':  `Bearer ${key}`,
        'Content-Type':   'application/json',
        'Prefer':         'resolution=merge-duplicates,return=minimal',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Supabase upsert failed (${res.statusCode}): ${data}`));
        } else {
          resolve(JSON.parse(data || '{}'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
