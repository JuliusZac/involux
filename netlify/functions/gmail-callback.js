const https = require('https');

const APP_URL = 'https://involux.ca';
const SB_URL = 'psockxoyycvctjzigneh.supabase.co';
const REDIRECT_URI = 'https://involux.ca/.netlify/functions/gmail-callback';

exports.handler = async (event) => {
  const { code, error } = event.queryStringParameters || {};

  if (error) {
    return redirect(`${APP_URL}/app.html?gmailError=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return redirect(`${APP_URL}/app.html?gmailError=missing_code`);
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCode(code);
    console.log('Token exchange result keys:', Object.keys(tokens).join(', '));

    if (tokens.error) {
      console.error('Token exchange error:', tokens.error, tokens.error_description);
      return redirect(`${APP_URL}/app.html?gmailError=${encodeURIComponent(tokens.error_description || tokens.error)}`);
    }

    if (!tokens.refresh_token) {
      console.error('No refresh token in response. Got:', JSON.stringify(tokens));
      return redirect(`${APP_URL}/app.html?gmailError=no_refresh_token`);
    }

    // Get the user's email from Google using the access token
    const userInfo = await getGoogleUserInfo(tokens.access_token);
    console.log('User info email:', userInfo.email);

    if (!userInfo.email) {
      return redirect(`${APP_URL}/app.html?gmailError=no_email`);
    }

    await storeRefreshToken(userInfo.email, tokens.refresh_token);
    console.log(`Gmail connected for ${userInfo.email}`);
    return redirect(`${APP_URL}/app.html?gmailConnected=true`);

  } catch (err) {
    console.error('Gmail callback error:', err.message);
    return redirect(`${APP_URL}/app.html?gmailError=${encodeURIComponent(err.message)}`);
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

function getGoogleUserInfo(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.googleapis.com',
      path: '/oauth2/v2/userinfo',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Failed to parse userinfo response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function storeRefreshToken(userEmail, refreshToken) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const now = new Date().toISOString();
    const body = JSON.stringify({
      user_email: userEmail,
      gmail_refresh_token: refreshToken,
      gmail_connected: true,
      gmail_connected_at: now,
      last_scanned_email_date: now
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
