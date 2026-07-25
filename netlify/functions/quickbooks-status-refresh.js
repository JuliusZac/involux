const https = require('https');

const SB_URL     = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST = 'oauth.platform.intuit.com';
const QB_HOST    = process.env.QUICKBOOKS_ENVIRONMENT === 'production'
  ? 'quickbooks.api.intuit.com'
  : 'sandbox-quickbooks.api.intuit.com';

const DELAY_MS = 300; // stay well under QuickBooks' rate limit

// Only Bills (Awaiting Payment) can transition to Paid later — Purchases are
// created as an already-completed cash transaction and never change status.
const handler = async () => {
  console.log('QuickBooks status refresh started —', new Date().toISOString());

  try {
    const invoices = await sb(
      `invoices?synced_to_quickbooks=eq.true&qb_transaction_id=not.is.null&qb_payment_status=eq.AWAITING_PAYMENT&select=id,user_email,business_name,qb_transaction_id,qb_payment_status`
    );

    if (!Array.isArray(invoices) || !invoices.length) {
      console.log('No synced QuickBooks bills to refresh');
      return { statusCode: 200, body: 'No invoices to refresh' };
    }

    console.log(`Checking ${invoices.length} invoice(s)...`);

    const allConns = await sb(`quickbooks_connections?select=business_id,access_token,refresh_token,realm_id,expires_at`);
    const connMap = {};
    if (Array.isArray(allConns)) allConns.forEach(c => { connMap[c.business_id] = c; });

    const byBiz = {};
    for (const inv of invoices) {
      const key = inv.business_name;
      if (!byBiz[key]) byBiz[key] = [];
      byBiz[key].push(inv);
    }

    let checked = 0, updated = 0, failed = 0;

    for (const [business_name, bizInvoices] of Object.entries(byBiz)) {
      const sampleInv = bizInvoices[0];
      const bizRow = await sb(`businesses?name=eq.${enc(sampleInv.business_name)}&user_email=eq.${enc(sampleInv.user_email)}&select=id`);
      const business_id = Array.isArray(bizRow) && bizRow[0] ? bizRow[0].id : null;
      const conn = business_id ? (connMap[business_id] || await getConnection(business_id)) : null;

      if (!conn) {
        console.warn(`No QuickBooks connection for business "${business_name}" — skipping ${bizInvoices.length} invoice(s)`);
        failed += bizInvoices.length;
        continue;
      }

      let { access_token, refresh_token, realm_id, expires_at } = conn;

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
            new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString());
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
          const bill = await getQBBill(realm_id, access_token, inv.qb_transaction_id);
          const newStatus = mapQBBillStatus(bill);

          checked++;

          if (newStatus && newStatus !== inv.qb_payment_status) {
            await sb(`invoices?id=eq.${enc(inv.id)}`, {
              method:  'PATCH',
              body:    JSON.stringify({ qb_payment_status: newStatus }),
              headers: { 'Prefer': 'return=minimal' },
            });
            updated++;
            console.log(`Updated ${inv.id}: ${inv.qb_payment_status} → ${newStatus}`);
          }
        } catch (e) {
          if (e.qbUnauthorized) {
            await markDisconnected(business_id);
            console.error(`401 for ${business_id} — marked needs_reconnect`);
            failed += bizInvoices.length - bizInvoices.indexOf(inv);
            break;
          }
          failed++;
          console.error(`Failed to refresh ${inv.id} (QB Bill ID: ${inv.qb_transaction_id}):`, e.message);
        }
      }
    }

    console.log(`Done — checked: ${checked}, updated: ${updated}, failed: ${failed}`);
    return { statusCode: 200, body: JSON.stringify({ checked, updated, failed }) };

  } catch (err) {
    console.error('QuickBooks status refresh error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

exports.handler = handler;

// ── QuickBooks helpers ──────────────────────────────────────────────────────

async function getQBBill(realm_id, access_token, billId) {
  return qb(realm_id, access_token, `bill/${billId}?minorversion=65`, 'GET');
}

function mapQBBillStatus(res) {
  const bill = res?.Bill;
  if (!bill) return null;
  // A Bill is fully paid once its remaining Balance hits 0 (via a BillPayment in QB)
  return Number(bill.Balance) === 0 ? 'PAID' : 'AWAITING_PAYMENT';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── QuickBooks API ────────────────────────────────────────────────────────────

function qb(realm_id, access_token, path, method = 'GET', body = null) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: QB_HOST,
      path:     `/v3/company/${realm_id}/${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { return reject(new Error(`QB parse error: ${data}`)); }
        if (res.statusCode === 401) { const e = new Error('QB 401: unauthorized'); e.qbUnauthorized = true; return reject(e); }
        if (res.statusCode >= 400) return reject(new Error(`QB ${res.statusCode}: ${JSON.stringify(parsed?.Fault || parsed)}`));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
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
  const data = await sb(`quickbooks_connections?business_id=eq.${enc(business_id)}&select=access_token,refresh_token,realm_id,expires_at`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function markDisconnected(business_id) {
  console.warn(`Marking QuickBooks connection needs_reconnect for ${business_id}`);
  try {
    await sb(`quickbooks_connections?business_id=eq.${enc(business_id)}`, {
      method:  'PATCH',
      body:    JSON.stringify({ needs_reconnect: true }),
      headers: { 'Prefer': 'return=minimal' },
    });
  } catch (e) {
    console.error('Failed to mark QuickBooks needs_reconnect:', e.message);
  }
}

async function refreshAccessToken(refresh_token) {
  const clientId     = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body         = new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKEN_HOST,
      path:     '/oauth2/v1/tokens/bearer',
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
  await sb(`quickbooks_connections?business_id=eq.${enc(business_id)}`, {
    method:  'PATCH',
    body:    JSON.stringify({ access_token, refresh_token, expires_at }),
    headers: { 'Prefer': 'return=minimal' },
  });
}
