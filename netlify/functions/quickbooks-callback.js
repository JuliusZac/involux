const https = require('https');

const APP_URL = 'https://involux.ca';
const SB_URL = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST = 'oauth.platform.intuit.com';

exports.handler = async (event) => {
  const { code, state, error, realmId } = event.queryStringParameters || {};

  if (error) {
    return redirect(`${APP_URL}/app.html?qbError=${encodeURIComponent(error)}`);
  }

  if (!code || !state || !realmId) {
    return redirect(`${APP_URL}/app.html?qbError=missing_params`);
  }

  let business_id;
  try {
    ({ business_id } = JSON.parse(Buffer.from(state, 'base64').toString('utf8')));
  } catch {
    return redirect(`${APP_URL}/app.html?qbError=invalid_state`);
  }

  if (!business_id) {
    return redirect(`${APP_URL}/app.html?qbError=missing_business_id`);
  }

  try {
    const tokens = await exchangeCode(code);

    if (tokens.error) {
      console.error('QB token exchange error:', tokens.error, tokens.error_description);
      return redirect(`${APP_URL}/app.html?qbError=${encodeURIComponent(tokens.error_description || tokens.error)}`);
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error('QB missing tokens:', JSON.stringify(tokens));
      return redirect(`${APP_URL}/app.html?qbError=no_tokens`);
    }

    const expires_at = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

    await upsertConnection({
      business_id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      realm_id: realmId,
      expires_at,
    });

    console.log(`QuickBooks connected for business ${business_id}, realm ${realmId}`);
    return redirect(`${APP_URL}/app.html?qbConnected=true`);

  } catch (err) {
    console.error('QB callback error:', err.message);
    return redirect(`${APP_URL}/app.html?qbError=${encodeURIComponent(err.message)}`);
  }
};

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}

function exchangeCode(code) {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: TOKEN_HOST,
        path: '/oauth2/v1/tokens/bearer',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`QB token parse error: ${data}`)); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function upsertConnection({ business_id, access_token, refresh_token, realm_id, expires_at }) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  const payload = JSON.stringify({
    business_id,
    access_token,
    refresh_token,
    realm_id,
    expires_at,
    created_at: new Date().toISOString(),
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: SB_URL,
        path: '/rest/v1/quickbooks_connections',
        method: 'POST',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
          'on-conflict': 'business_id',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Supabase upsert failed (${res.statusCode}): ${data}`));
          } else {
            resolve(JSON.parse(data || '{}'));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
