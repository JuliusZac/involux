const { sb, enc } = require('./lib/sb');
const { verifyRequest, AuthError } = require('./lib/auth');
const { json, originOk } = require('./lib/http');

// Query filter columns the client is allowed to request, beyond the
// server-forced user_email/business_name. Values must carry a PostgREST
// operator prefix we recognize — nothing else passes through.
const FILTER_KEYS = new Set([
  'supplier', 'amount', 'date', 'invoice_number', 'id',
  'synced_to_quickbooks', 'synced_to_xero', 'synced_to_freshbooks',
  'folder_year', 'folder_month', 'paid', 'category',
]);
const OPERATOR_RE = /^(eq|neq|is)\.[\s\S]*$/;
const SELECT_RE = /^[a-zA-Z0-9_,]+$/;
const ORDER_RE = /^[a-zA-Z0-9_,.]+$/;
const LIMIT_RE = /^[0-9]+$/;

// Fields a PATCH/POST body may never set directly — identity/ownership is
// always server-derived, never trusted from the client.
const LOCKED_FIELDS = ['id', 'user_email', 'business_name'];

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
      const qs = event.queryStringParameters || {};
      const business = await getOwnedBusiness(qs.business_id, email);
      if (!business) return json(403, { error: 'Not found or not yours' });

      let query = `invoices?user_email=eq.${enc(email)}&business_name=eq.${enc(business.name)}`;
      for (const [key, value] of Object.entries(qs)) {
        if (key === 'business_id') continue;
        if (FILTER_KEYS.has(key)) {
          if (!OPERATOR_RE.test(value)) return json(400, { error: `Bad filter for ${key}` });
          // Netlify already URL-decodes queryStringParameters, so the operand
          // (everything after the first '.') must be re-encoded before it's
          // appended to the outbound request path — otherwise a value like
          // "eq.MegaTech Informatique" has a literal space, which Node's
          // https module rejects outright ("Request path contains unescaped
          // characters"), silently breaking every filtered lookup.
          const dot = value.indexOf('.');
          const op = value.slice(0, dot);
          const operand = value.slice(dot + 1);
          query += `&${key}=${op}.${enc(operand)}`;
        } else if (key === 'select') {
          if (!SELECT_RE.test(value)) return json(400, { error: 'Bad select' });
          query += `&select=${value}`;
        } else if (key === 'order') {
          if (!ORDER_RE.test(value)) return json(400, { error: 'Bad order' });
          query += `&order=${value}`;
        } else if (key === 'limit') {
          if (!LIMIT_RE.test(value)) return json(400, { error: 'Bad limit' });
          query += `&limit=${value}`;
        } else {
          return json(400, { error: `Unsupported filter: ${key}` });
        }
      }
      const rows = await sb(query);
      return json(200, rows);
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body' }); }

    if (event.httpMethod === 'POST') {
      const { business_id, ...fields } = body;
      const business = await getOwnedBusiness(business_id, email);
      if (!business) return json(403, { error: 'Not found or not yours' });
      for (const f of LOCKED_FIELDS) delete fields[f];

      const rows = await sb('invoices', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify({ ...fields, user_email: email, business_name: business.name }),
      });
      return json(200, rows);
    }

    if (event.httpMethod === 'PATCH') {
      const { id, minimal, ...fields } = body;
      if (!id) return json(400, { error: 'Missing id' });
      const owned = await getOwnedInvoice(id, email);
      if (!owned) return json(403, { error: 'Not found or not yours' });
      for (const f of LOCKED_FIELDS) delete fields[f];

      const rows = await sb(`invoices?id=eq.${enc(id)}`, {
        method: 'PATCH',
        headers: { 'Prefer': minimal ? 'return=minimal' : 'return=representation' },
        body: JSON.stringify(fields),
      });
      return json(200, rows);
    }

    if (event.httpMethod === 'DELETE') {
      const { id } = body;
      if (!id) return json(400, { error: 'Missing id' });
      const owned = await getOwnedInvoice(id, email);
      if (!owned) return json(403, { error: 'Not found or not yours' });

      await sb(`invoices?id=eq.${enc(id)}`, { method: 'DELETE' });
      return json(200, { success: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('invoices error:', err.message);
    return json(500, { error: 'Internal server error' });
  }
};

async function getOwnedBusiness(businessId, email) {
  if (!businessId) return null;
  const rows = await sb(`businesses?id=eq.${enc(businessId)}&select=id,name,user_email`);
  const row = Array.isArray(rows) && rows[0];
  if (!row || row.user_email !== email) return null;
  return row;
}

async function getOwnedInvoice(id, email) {
  const rows = await sb(`invoices?id=eq.${enc(id)}&select=id,user_email`);
  const row = Array.isArray(rows) && rows[0];
  if (!row || row.user_email !== email) return null;
  return row;
}
