const https = require('https');

const APP_URL      = 'https://involux.ca';
const SB_URL       = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST   = 'api.freshbooks.com';
const REDIRECT_URI = 'https://involux.ca/.netlify/functions/freshbooks-callback';

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  if (error) {
    return redirect(`${APP_URL}/app.html?freshbooksError=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return redirect(`${APP_URL}/app.html?freshbooksError=missing_params`);
  }

  let business_id;
  try {
    ({ business_id } = JSON.parse(Buffer.from(state, 'base64').toString('utf8')));
  } catch {
    return redirect(`${APP_URL}/app.html?freshbooksError=invalid_state`);
  }

  if (!business_id) {
    return redirect(`${APP_URL}/app.html?freshbooksError=missing_business_id`);
  }

  try {
    const tokens = await exchangeCode(code);

    if (tokens.error) {
      console.error('FreshBooks token exchange error:', tokens.error, tokens.error_description);
      return redirect(`${APP_URL}/app.html?freshbooksError=${encodeURIComponent(tokens.error_description || tokens.error)}`);
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error('FreshBooks missing tokens:', JSON.stringify(tokens));
      return redirect(`${APP_URL}/app.html?freshbooksError=no_tokens`);
    }

    // FreshBooks requires an account_id for every accounting API call — fetch it from /users/me
    const accountId = await getAccountId(tokens.access_token);
    if (!accountId) {
      return redirect(`${APP_URL}/app.html?freshbooksError=no_account`);
    }

    const expires_at = new Date(Date.now() + (tokens.expires_in || 43200) * 1000).toISOString();

    await upsertConnection({
      business_id,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id:    accountId,
      expires_at,
    });

    console.log(`FreshBooks connected for business ${business_id}, account ${accountId}`);
    return redirect(`${APP_URL}/app.html?freshbooksConnected=true`);

  } catch (err) {
    console.error('FreshBooks callback error:', err.message);
    return redirect(`${APP_URL}/app.html?freshbooksError=${encodeURIComponent(err.message)}`);
  }
};

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}

function exchangeCode(code) {
  const clientId     = process.env.FRESHBOOKS_CLIENT_ID;
  const clientSecret = process.env.FRESHBOOKS_CLIENT_SECRET;
  const body = JSON.stringify({
    grant_type:    'authorization_code',
    client_id:     clientId,
    client_secret: clientSecret,
    code,
    redirect_uri:  REDIRECT_URI,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKEN_HOST,
      path:     '/auth/oauth/token',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`FreshBooks token parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getAccountId(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.freshbooks.com',
      path:     '/auth/api/v1/users/me',
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
          const parsed = JSON.parse(data);
          const memberships = parsed?.response?.business_memberships || [];
          const active = memberships.find(m => m.business?.account_id) || memberships[0];
          resolve(active?.business?.account_id || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function upsertConnection({ business_id, access_token, refresh_token, account_id, expires_at }) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  const payload = JSON.stringify({
    business_id,
    access_token,
    refresh_token,
    account_id,
    expires_at,
    needs_reconnect: false,
    created_at: new Date().toISOString(),
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SB_URL,
      path:     '/rest/v1/freshbooks_connections?on_conflict=business_id',
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
