const https = require('https');

const REVOKE_HOST = 'api.freshbooks.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let refresh_token;
  try {
    ({ refresh_token } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (!refresh_token) {
    return { statusCode: 400, body: 'Missing refresh_token' };
  }

  const body = JSON.stringify({
    client_id:     process.env.FRESHBOOKS_CLIENT_ID,
    client_secret: process.env.FRESHBOOKS_CLIENT_SECRET,
    token:         refresh_token,
  });

  try {
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: REVOKE_HOST,
        path:     '/auth/oauth/revoke',
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
          if (res.statusCode >= 400) {
            console.warn(`FreshBooks revoke returned ${res.statusCode}: ${data}`);
          } else {
            console.log('FreshBooks token revoked successfully');
          }
          resolve();
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('FreshBooks revoke error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
