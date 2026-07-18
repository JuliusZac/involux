const https = require('https');

const SB_URL     = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST = 'identity.xero.com';
const XERO_HOST  = 'api.xero.com';

const DELAY_MS = 300; // stay well under Xero's 60 req/min rate limit

const handler = async () => {
  console.log('Xero status refresh started —', new Date().toISOString());

  try {
    // Fetch all synced invoices that have a stored Xero InvoiceID
    const invoices = await sb(
      `invoices?synced_to_xero=eq.true&xero_invoice_id=not.is.null&select=id,user_email,business_name,xero_invoice_id,xero_payment_status`
    );

    if (!Array.isArray(invoices) || !invoices.length) {
      console.log('No synced invoices to refresh');
      return { statusCode: 200, body: 'No invoices to refresh' };
    }

    console.log(`Checking ${invoices.length} invoice(s)...`);

    // Fetch all xero connections and key by business_id
    const allConns = await sb(`xero_connections?select=business_id,access_token,refresh_token,tenant_id,expires_at`);
    const connMap = {};
    if (Array.isArray(allConns)) allConns.forEach(c => { connMap[c.business_id] = c; });

    // Group invoices by business_name so we look up the connection once per business
    const byBiz = {};
    for (const inv of invoices) {
      const key = inv.business_name;
      if (!byBiz[key]) byBiz[key] = [];
      byBiz[key].push(inv);
    }

    let checked = 0, updated = 0, failed = 0;

    for (const [business_name, bizInvoices] of Object.entries(byBiz)) {
      // Find connection by looking up the business_id for this business_name
      const sampleInv = bizInvoices[0];
      const bizRow = await sb(`businesses?name=eq.${enc(sampleInv.business_name)}&user_email=eq.${enc(sampleInv.user_email)}&select=id`);
      const business_id = Array.isArray(bizRow) && bizRow[0] ? bizRow[0].id : null;
      const conn = business_id ? (connMap[business_id] || await getConnection(business_id)) : null;

      if (!conn) {
        console.warn(`No Xero connection for business "${business_name}" — skipping ${bizInvoices.length} invoice(s)`);
        failed += bizInvoices.length;
        continue;
      }

      let { access_token, refresh_token, tenant_id, expires_at } = conn;

      if (new Date(expires_at) <= new Date(Date.now() + 5 * 60 * 1000)) {
        try {
          const r = await refreshAccessToken(refresh_token);
          if (r.error || !r.access_token) {
            await markDisconnected(business_id);
            console.error(`Token refresh failed for ${business_id} — marked needs_reconnect`);
            failed += bizInvoices.length;
            continue;
          }
          access_token  = r.access_token;
          refresh_token = r.refresh_token;
          await saveTokens(business_id, access_token, refresh_token,
            new Date(Date.now() + (r.expires_in || 1800) * 1000).toISOString());
        } catch (e) {
          await markDisconnected(business_id);
          console.error(`Token refresh failed for ${business_id}:`, e.message);
          failed += bizInvoices.length;
          continue;
        }
      }

      for (const inv of bizInvoices) {
        await sleep(DELAY_MS);
        try {
          const xeroInv = await getXeroInvoice(access_token, tenant_id, inv.xero_invoice_id);
          const newStatus = mapXeroStatus(xeroInv);

          checked++;

          if (newStatus && newStatus !== inv.xero_payment_status) {
            await sb(`invoices?id=eq.${enc(inv.id)}`, {
              method:  'PATCH',
              body:    JSON.stringify({ xero_payment_status: newStatus }),
              headers: { 'Prefer': 'return=minimal' },
            });
            updated++;
            console.log(`Updated ${inv.id}: ${inv.xero_payment_status} → ${newStatus}`);
          }
        } catch (e) {
          if (e.xeroUnauthorized) {
            await markDisconnected(business_id);
            console.error(`401 for ${business_id} — marked needs_reconnect`);
            failed += bizInvoices.length - bizInvoices.indexOf(inv);
            break;
          }
          failed++;
          console.error(`Failed to refresh ${inv.id} (Xero ID: ${inv.xero_invoice_id}):`, e.message);
        }
      }
    }

    console.log(`Done — checked: ${checked}, updated: ${updated}, failed: ${failed}`);
    return { statusCode: 200, body: JSON.stringify({ checked, updated, failed }) };

  } catch (err) {
    console.error('Xero status refresh error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

exports.handler = handler;

// ── Xero helpers ──────────────────────────────────────────────────────────────

async function getXeroInvoice(access_token, tenant_id, xeroInvoiceId) {
  return xero(access_token, tenant_id, `Invoices/${xeroInvoiceId}`, 'GET');
}

function mapXeroStatus(res) {
  const inv = res?.Invoices?.[0];
  if (!inv) return null;
  // PAID = Xero status is PAID or AmountDue is 0 and there are payments
  if (inv.Status === 'PAID') return 'PAID';
  if (inv.AmountDue === 0 && Array.isArray(inv.Payments) && inv.Payments.length > 0) return 'PAID';
  return 'AWAITING_PAYMENT';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Xero API ──────────────────────────────────────────────────────────────────

function xero(access_token, tenant_id, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: XERO_HOST,
      path:     `/api.xro/2.0/${path}`,
      method,
      headers: {
        'Authorization':  `Bearer ${access_token}`,
        'Xero-tenant-id': tenant_id,
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { return reject(new Error(`Xero parse error: ${data}`)); }
        if (res.statusCode === 401) { const e = new Error('Xero 401: unauthorized'); e.xeroUnauthorized = true; return reject(e); }
        if (res.statusCode >= 400) return reject(new Error(`Xero ${res.statusCode}: ${JSON.stringify(parsed)}`));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(s); }

function sb(path, opts = {}) {
  const key     = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  const method  = opts.method || 'GET';
  const payload = opts.body || null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SB_URL,
      path:     `/rest/v1/${path}`,
      method,
      headers: {
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(opts.headers || {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Supabase ${res.statusCode}: ${data}`));
        resolve(data ? JSON.parse(data) : {});
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getConnection(business_id) {
  const data = await sb(`xero_connections?business_id=eq.${enc(business_id)}&select=access_token,refresh_token,tenant_id,expires_at,needs_reconnect`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function markDisconnected(business_id) {
  console.warn(`Marking Xero connection needs_reconnect for ${business_id}`);
  await sb(`xero_connections?business_id=eq.${enc(business_id)}`, {
    method:  'PATCH',
    body:    JSON.stringify({ needs_reconnect: true }),
    headers: { 'Prefer': 'return=minimal' },
  });
}

async function refreshAccessToken(refresh_token) {
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body         = new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKEN_HOST,
      path:     '/connect/token',
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
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Token refresh parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function saveTokens(business_id, access_token, refresh_token, expires_at) {
  await sb(`xero_connections?business_id=eq.${enc(business_id)}`, {
    method:  'PATCH',
    body:    JSON.stringify({ access_token, refresh_token, expires_at }),
    headers: { 'Prefer': 'return=minimal' },
  });
}
