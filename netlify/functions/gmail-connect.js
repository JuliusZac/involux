const https = require('https');

const ALLOWED_ORIGIN = 'https://involux.ca';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const origin = event.headers['origin'] || event.headers['referer'] || '';
  if (!origin.startsWith(ALLOWED_ORIGIN)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { code, userEmail } = body;
  if (!code || !userEmail) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing code or userEmail' }) };
  }

  try {
    const tokens = await exchangeCode(code);

    if (!tokens.refresh_token) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No refresh token — user should revoke Involux Gmail access in their Google account and try again.' }) };
    }

    await storeRefreshToken(userEmail, tokens.refresh_token);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (error) {
    console.error('Gmail connect error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      code,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri: 'postmessage',
      grant_type: 'authorization_code'
    });

    const body = params.toString();
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Failed to parse token response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function storeRefreshToken(userEmail, refreshToken) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const body = JSON.stringify({
      user_email: userEmail,
      gmail_refresh_token: refreshToken,
      gmail_connected: true
    });

    const options = {
      hostname: 'psockxoyycvctjzigneh.supabase.co',
      path: '/rest/v1/user_settings',
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
