const https = require('https');

const TOKEN_HOST = 'identity.xero.com';

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

  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body         = new URLSearchParams({ token: refresh_token }).toString();

  try {
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: TOKEN_HOST,
        path:     '/connect/revocation',
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
          if (res.statusCode >= 400) {
            console.warn(`Xero revoke returned ${res.statusCode}: ${data}`);
          } else {
            console.log('Xero token revoked successfully');
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
    console.error('Xero revoke error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
