const https = require('https');

const APP_URL = 'https://involux.ca';
const SB_URL = 'psockxoyycvctjzigneh.supabase.co';
const REDIRECT_URI = 'https://involux.ca/.netlify/functions/gmail-callback';

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  // Google returned an error (user denied access, etc.)
  if (error) {
    return redirect(`${APP_URL}/app.html?gmailError=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return redirect(`${APP_URL}/app.html?gmailError=missing_params`);
  }

  // Decode user email from state
  let userEmail;
  try {
    userEmail = Buffer.from(state, 'base64url').toString('utf8');
    if (!userEmail || !userEmail.includes('@')) throw new Error('bad email');
  } catch {
    return redirect(`${APP_URL}/app.html?gmailError=invalid_state`);
  }

  try {
    const tokens = await exchangeCode(code);

    if (!tokens.refresh_token) {
      console.error('No refresh token received for', userEmail);
      return redirect(`${APP_URL}/app.html?gmailError=no_refresh_token`);
    }

    await storeRefreshToken(userEmail, tokens.refresh_token);
    console.log(`Gmail connected for ${userEmail}`);
    return redirect(`${APP_URL}/app.html?gmailConnected=true`);
  } catch (err) {
    console.error('Gmail callback error:', err);
    return redirect(`${APP_URL}/app.html?gmailError=server_error`);
  }
};

function redirect(url) {
  return { statusCode: 302, headers: { Location: url }, body: '' };
}

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      code,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
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
      hostname: SB_URL,
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
