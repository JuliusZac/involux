const https = require('https');
const { sb, enc, SB_URL } = require('./lib/sb');
const { verifyRequest, AuthError } = require('./lib/auth');
const { json, originOk } = require('./lib/http');

const BUCKET = 'invoices';
const EXT_WHITELIST = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (!originOk(event)) return json(403, { error: 'Forbidden' });

  let email;
  try {
    ({ email } = await verifyRequest(event));
  } catch (err) {
    return json(err instanceof AuthError ? err.statusCode : 401, { error: err.message });
  }

  try {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body' }); }

    if (event.httpMethod === 'POST') {
      const { business_id, ext } = body;
      if (!EXT_WHITELIST.has(String(ext || '').toLowerCase())) return json(400, { error: 'Unsupported file type' });
      const biz = await getOwnedBusiness(business_id, email);
      if (!biz) return json(403, { error: 'Not found or not yours' });

      const path = `${email}/${Date.now()}.${ext.toLowerCase()}`;
      const encPath = encodePath(path);
      const signResult = await storageRequest('POST', `/object/upload/sign/${BUCKET}/${encPath}`, '{}');
      const relUrl = signResult && signResult.url;
      if (!relUrl) return json(502, { error: 'Storage service error' });

      return json(200, {
        path,
        signedUrl: `https://${SB_URL}/storage/v1${relUrl}`,
        publicUrl: `https://${SB_URL}/storage/v1/object/public/${BUCKET}/${encPath}`,
      });
    }

    if (event.httpMethod === 'DELETE') {
      const { path } = body;
      if (!path || !path.startsWith(`${email}/`)) return json(403, { error: 'Not yours' });
      await storageRequest('DELETE', `/object/${BUCKET}/${encodePath(path)}`);
      return json(200, { success: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('upload-url error:', err.message);
    return json(500, { error: 'Internal server error' });
  }
};

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function getOwnedBusiness(businessId, email) {
  if (!businessId) return null;
  const rows = await sb(`businesses?id=eq.${enc(businessId)}&select=id,user_email`);
  const row = Array.isArray(rows) && rows[0];
  if (!row || row.user_email !== email) return null;
  return row;
}

// Talks to Supabase Storage (not PostgREST) with the service-role key.
function storageRequest(method, path, payload) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SB_URL,
      path:     `/storage/v1${path}`,
      method,
      headers: {
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Storage ${res.statusCode}: ${data}`));
        resolve(data ? JSON.parse(data) : {});
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
