const https = require('https');

const SB_URL   = 'psockxoyycvctjzigneh.supabase.co';
const FB_HOST  = 'api.freshbooks.com';
const TOKEN_HOST = 'api.freshbooks.com';

const DELAY_MS = 300; // stay well under FreshBooks' rate limit

// Only Bills (Unpaid) can transition to Paid later — Expenses are created as an
// already-completed cash transaction and never change status.
const handler = async () => {
  console.log('FreshBooks status refresh started —', new Date().toISOString());

  try {
    const invoices = await sb(
      `invoices?synced_to_freshbooks=eq.true&freshbooks_expense_id=not.is.null&freshbooks_payment_status=eq.AWAITING_PAYMENT&select=id,user_email,business_name,freshbooks_expense_id,freshbooks_payment_status`
    );

    if (!Array.isArray(invoices) || !invoices.length) {
      console.log('No synced FreshBooks bills to refresh');
      return { statusCode: 200, body: 'No invoices to refresh' };
    }

    console.log(`Checking ${invoices.length} invoice(s)...`);

    const allConns = await sb(`freshbooks_connections?select=business_id,access_token,refresh_token,account_id,expires_at`);
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
        console.warn(`No FreshBooks connection for business "${business_name}" — skipping ${bizInvoices.length} invoice(s)`);
        failed += bizInvoices.length;
        continue;
      }

      let { access_token, refresh_token, account_id, expires_at } = conn;

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
            new Date(Date.now() + (r.expires_in || 43200) * 1000).toISOString());
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
          const bill = await getFreshBooksBill(account_id, access_token, inv.freshbooks_expense_id);
          const newStatus = mapFreshBooksBillStatus(bill);

          checked++;

          if (newStatus && newStatus !== inv.freshbooks_payment_status) {
            await sb(`invoices?id=eq.${enc(inv.id)}`, {
              method:  'PATCH',
              body:    JSON.stringify({ freshbooks_payment_status: newStatus }),
              headers: { 'Prefer': 'return=minimal' },
            });
            updated++;
            console.log(`Updated ${inv.id}: ${inv.freshbooks_payment_status} → ${newStatus}`);
          }
        } catch (e) {
          if (e.freshbooksUnauthorized) {
            await markDisconnected(business_id);
            console.error(`401 for ${business_id} — marked needs_reconnect`);
            failed += bizInvoices.length - bizInvoices.indexOf(inv);
            break;
          }
          failed++;
          console.error(`Failed to refresh ${inv.id} (FreshBooks Bill ID: ${inv.freshbooks_expense_id}):`, e.message);
        }
      }
    }

    console.log(`Done — checked: ${checked}, updated: ${updated}, failed: ${failed}`);
    return { statusCode: 200, body: JSON.stringify({ checked, updated, failed }) };

  } catch (err) {
    console.error('FreshBooks status refresh error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

exports.handler = handler;

// ── FreshBooks helpers ───────────────────────────────────────────────────────

async function getFreshBooksBill(account_id, access_token, billId) {
  return fb(account_id, access_token, `bills/bills/${billId}`, 'GET');
}

function mapFreshBooksBillStatus(res) {
  const bill = res?.response?.result?.bill;
  if (!bill) return null;
  // A Bill is fully paid once its outstanding balance hits 0 (via a Bill Payment
  // recorded against it in FreshBooks) — the same check QB's refresh uses, since
  // FreshBooks' own "status" string can lag behind the outstanding amount.
  const outstanding = Number(bill.outstanding?.amount);
  if (bill.status === 'paid' || outstanding === 0) return 'PAID';
  return 'AWAITING_PAYMENT';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── FreshBooks API ────────────────────────────────────────────────────────────

function fb(account_id, access_token, path, method = 'GET', body = null) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: FB_HOST,
      path:     `/accounting/account/${account_id}/${path}`,
      method,
      headers: {
        'Authorization':  `Bearer ${access_token}`,
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        'Api-Version':    '2023-02-20',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { return reject(new Error(`FreshBooks parse error: ${data}`)); }
        if (res.statusCode === 401) { const e = new Error('FreshBooks 401: unauthorized'); e.freshbooksUnauthorized = true; return reject(e); }
        if (res.statusCode >= 400) return reject(new Error(`FreshBooks ${res.statusCode}: ${JSON.stringify(parsed)}`));
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
  const data = await sb(`freshbooks_connections?business_id=eq.${enc(business_id)}&select=access_token,refresh_token,account_id,expires_at`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function markDisconnected(business_id) {
  console.warn(`Marking FreshBooks connection needs_reconnect for ${business_id}`);
  try {
    await sb(`freshbooks_connections?business_id=eq.${enc(business_id)}`, {
      method:  'PATCH',
      body:    JSON.stringify({ needs_reconnect: true }),
      headers: { 'Prefer': 'return=minimal' },
    });
  } catch (e) {
    console.error('Failed to mark FreshBooks needs_reconnect:', e.message);
  }
}

async function refreshAccessToken(refresh_token) {
  const body = JSON.stringify({
    grant_type:    'refresh_token',
    client_id:     process.env.FRESHBOOKS_CLIENT_ID,
    client_secret: process.env.FRESHBOOKS_CLIENT_SECRET,
    refresh_token,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKEN_HOST,
      path:     '/auth/oauth/token',
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
  await sb(`freshbooks_connections?business_id=eq.${enc(business_id)}`, {
    method:  'PATCH',
    body:    JSON.stringify({ access_token, refresh_token, expires_at }),
    headers: { 'Prefer': 'return=minimal' },
  });
}
