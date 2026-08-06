const { sb, enc } = require('./lib/sb');
const { verifyRequest, AuthError } = require('./lib/auth');
const { json, originOk } = require('./lib/http');

const REP = { 'Prefer': 'return=representation' };

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
    if (event.httpMethod === 'GET') {
      const rows = await sb(`businesses?user_email=eq.${enc(email)}&order=created_at.asc`);
      return json(200, rows);
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body' }); }

    if (event.httpMethod === 'POST') {
      const { name, province, country } = body;
      if (!name) return json(400, { error: 'Missing name' });
      const rows = await sb('businesses', {
        method: 'POST',
        headers: REP,
        body: JSON.stringify({ user_email: email, name, province: province || null, country: country || null }),
      });
      return json(200, rows);
    }

    if (event.httpMethod === 'PATCH') {
      const { id, name } = body;
      if (!id || !name) return json(400, { error: 'Missing id or name' });
      const owned = await getOwnedBusiness(id, email);
      if (!owned) return json(403, { error: 'Not found or not yours' });

      const rows = await sb(`businesses?id=eq.${enc(id)}`, {
        method: 'PATCH',
        headers: REP,
        body: JSON.stringify({ name }),
      });
      if (name !== owned.name) {
        await sb(`invoices?user_email=eq.${enc(email)}&business_name=eq.${enc(owned.name)}`, {
          method: 'PATCH',
          body: JSON.stringify({ business_name: name }),
        });
      }
      return json(200, rows);
    }

    if (event.httpMethod === 'DELETE') {
      const { id } = body;
      if (!id) return json(400, { error: 'Missing id' });
      const owned = await getOwnedBusiness(id, email);
      if (!owned) return json(403, { error: 'Not found or not yours' });

      await sb(`invoices?user_email=eq.${enc(email)}&business_name=eq.${enc(owned.name)}`, { method: 'DELETE' });
      await sb(`businesses?id=eq.${enc(id)}`, { method: 'DELETE' });
      return json(200, { success: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('businesses error:', err.message);
    return json(500, { error: 'Internal server error' });
  }
};

async function getOwnedBusiness(id, email) {
  const rows = await sb(`businesses?id=eq.${enc(id)}&select=id,name,user_email`);
  const row = Array.isArray(rows) && rows[0];
  if (!row || row.user_email !== email) return null;
  return row;
}
