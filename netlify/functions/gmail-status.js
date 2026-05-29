const https = require('https');

const ALLOWED_ORIGIN = 'https://involux.ca';
const SB_URL = 'psockxoyycvctjzigneh.supabase.co';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { userEmail } = body;
  if (!userEmail || !userEmail.includes('@')) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email' }) };

  try {
    const data = await supabaseGet(`user_settings?user_email=eq.${encodeURIComponent(userEmail)}&select=gmail_connected`);
    const connected = Array.isArray(data) && data[0] && data[0].gmail_connected === true;
    return { statusCode: 200, headers, body: JSON.stringify({ connected }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ connected: false }) };
  }
};

function supabaseGet(endpoint) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const options = {
      hostname: SB_URL,
      path: `/rest/v1/${endpoint}`,
      method: 'GET',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Parse error')); } });
    });
    req.on('error', reject);
    req.end();
  });
}
