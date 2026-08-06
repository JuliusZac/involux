const { sb, enc } = require('./lib/sb');
const { json, originOk } = require('./lib/http');

// Intentionally unauthenticated — the token itself is the share-link secret,
// same design as today. This only relocates the two reads that used to run
// under the browser's anon key to run under the service-role key instead.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (!originOk(event)) return json(403, { error: 'Forbidden' });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const { token } = event.queryStringParameters || {};
  if (!token) return json(400, { error: 'Missing token' });

  try {
    const invRows = await sb(`invitations?token=eq.${enc(token)}`);
    const invitation = Array.isArray(invRows) && invRows[0];
    if (!invitation) return json(404, { error: 'Invalid invitation' });

    const invoices = await sb(`invoices?business_name=eq.${enc(invitation.business_name)}&order=created_at.desc`);
    return json(200, { invitation, invoices: Array.isArray(invoices) ? invoices : [] });
  } catch (err) {
    console.error('invitation error:', err.message);
    return json(500, { error: 'Internal server error' });
  }
};
