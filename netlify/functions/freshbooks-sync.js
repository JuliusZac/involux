const https = require('https');

const SB_URL = 'psockxoyycvctjzigneh.supabase.co';
const FB_HOST = 'api.freshbooks.com';
const TOKEN_HOST = 'api.freshbooks.com';

const BASE_CURRENCY = 'CAD';

exports.handler = async (event) => {
  const { business_id, business_name, user_email, invoice_id, freshbooks_payment_status: status_override } = event.queryStringParameters || {};
  if (!business_id)                  return json(400, { error: 'Missing business_id' });
  if (!business_name || !user_email) return json(400, { error: 'Missing business_name or user_email' });

  try {
    const conn = await getConnection(business_id);
    if (!conn) return json(404, { error: 'FreshBooks not connected' });

    let { access_token, refresh_token, account_id, expires_at } = conn;
    if (new Date(expires_at) <= new Date(Date.now() + 5 * 60 * 1000)) {
      const r = await refreshToken(refresh_token);
      if (r.error || !r.access_token) {
        await markDisconnected(business_id);
        return json(401, { error: 'FreshBooks token expired — please reconnect', disconnected: true });
      }
      access_token  = r.access_token;
      refresh_token = r.refresh_token;
      await saveTokens(business_id, access_token, refresh_token,
        new Date(Date.now() + (r.expires_in || 43200) * 1000).toISOString());
    }

    const invoices = invoice_id
      ? await sb(`invoices?id=eq.${enc(invoice_id)}&select=id,supplier,date,amount,subtotal,taxes,invoice_number,freshbooks_category_name,freshbooks_payment_status,synced_to_freshbooks,line_items,currency`)
      : await sb(`invoices?business_name=eq.${enc(business_name)}&user_email=eq.${enc(user_email)}&synced_to_freshbooks=eq.false&select=id,supplier,date,amount,subtotal,taxes,invoice_number,freshbooks_category_name,freshbooks_payment_status,line_items,currency`);

    if (!Array.isArray(invoices) || !invoices.length) return json(200, { synced: 0, message: 'Nothing to sync' });

    if (invoice_id && invoices[0]?.synced_to_freshbooks) {
      return json(200, { alreadySynced: true, message: 'Already synced to FreshBooks' });
    }

    // FreshBooks Expense has no distinct doc-number/reference field to dedupe against like
    // Xero/QB, so synced_to_freshbooks is the sole guard against double-syncing.
    const categories = await fetchCategories(account_id, access_token);

    let synced = 0, failed = 0, errors = [];

    for (const inv of invoices) {
      if (!inv.supplier || inv.supplier === 'Processing...') continue;
      if (inv.synced_to_freshbooks) { console.log(`Skipping ${inv.id} — already synced`); continue; }

      try {
        const paymentStatus = status_override || inv.freshbooks_payment_status;
        if (!paymentStatus) { console.log(`Skipping ${inv.id} — freshbooks_payment_status not set`); continue; }

        const categoryId = matchCategory(categories, inv.freshbooks_category_name);
        const payload = buildExpense(inv, categoryId, paymentStatus);

        console.log(`FreshBooks sync: ${inv.supplier} — ${paymentStatus}`);
        console.log('FreshBooks Expense payload:', JSON.stringify(payload));

        const result = await fb(account_id, access_token, 'expenses/expenses', 'POST', payload);
        const created = result?.response?.result?.expense;
        if (!created?.id) {
          throw new Error(`FreshBooks rejected expense: ${JSON.stringify(result?.response?.errors || result)}`);
        }

        await sb(`invoices?id=eq.${inv.id}`, {
          method:  'PATCH',
          body:    JSON.stringify({ synced_to_freshbooks: true, synced_to_freshbooks_at: new Date().toISOString(), freshbooks_payment_status: paymentStatus, freshbooks_expense_id: created.id }),
          headers: { 'Prefer': 'return=minimal' },
        });

        synced++;
        console.log(`Synced to FreshBooks: ${inv.id} — ${inv.supplier} $${inv.amount} (${paymentStatus})`);
      } catch (err) {
        if (err.freshbooksUnauthorized) {
          await markDisconnected(business_id);
          return json(401, { error: 'FreshBooks connection lost — please reconnect', disconnected: true });
        }
        failed++;
        errors.push({ id: inv.id, supplier: inv.supplier, error: err.message });
        console.error(`FreshBooks failed ${inv.id}:`, err.message);
      }
    }

    return json(200, { synced, failed, errors });
  } catch (err) {
    console.error('FreshBooks sync error:', err.message);
    return json(500, { error: err.message });
  }
};

// ── Build FreshBooks Expense payload ────────────────────────────────────────
// FreshBooks Expenses don't support per-line-item categorization like Xero/QB
// Bills — one Expense record covers the whole invoice, categorized once. Tax
// breakdown and payment status (a concept FreshBooks itself doesn't track on
// Expenses) are recorded in notes for visibility, and mapped onto FreshBooks'
// native taxName1/taxAmount1(+2) fields where present.

function buildExpense(inv, categoryId, paymentStatus) {
  const subtotal = Number(inv.subtotal) || Number(inv.amount) || 0;
  const taxes    = Array.isArray(inv.taxes) ? inv.taxes.filter(t => Number(t.amount) > 0) : [];
  const total    = Number(inv.amount) || subtotal + taxes.reduce((s, t) => s + Number(t.amount), 0);

  const statusLabel = paymentStatus === 'PAID' ? 'Paid' : 'Awaiting payment';
  const lineDesc = Array.isArray(inv.line_items) && inv.line_items.length
    ? inv.line_items.filter(li => li.description && !li.excluded).map(li => li.description).join(', ')
    : null;
  const notesParts = [statusLabel];
  if (inv.invoice_number) notesParts.push(`Invoice #${inv.invoice_number}`);
  if (lineDesc) notesParts.push(lineDesc);

  const expense = {
    amount:  { amount: total.toFixed(2), code: inv.currency || BASE_CURRENCY },
    date:    inv.date || new Date().toISOString().split('T')[0],
    vendor:  inv.supplier,
    notes:   notesParts.join(' — ').slice(0, 1000),
    ...(categoryId ? { categoryid: categoryId } : {}),
  };

  taxes.slice(0, 2).forEach((t, i) => {
    expense[`tax_name${i + 1}`]   = (t.label || 'Tax').slice(0, 50);
    expense[`tax_amount${i + 1}`] = Number(t.amount).toFixed(2);
  });

  return { expense };
}

// ── FreshBooks expense categories ───────────────────────────────────────────

async function fetchCategories(account_id, access_token) {
  try {
    const res = await fb(account_id, access_token, 'expenses/categories', 'GET');
    const categories = res?.response?.result?.categories || [];
    console.log('FreshBooks categories:', categories.map(c => `${c.id} — ${c.category}`).join(', '));
    return categories;
  } catch (e) {
    console.warn('Could not fetch FreshBooks categories:', e.message);
    return [];
  }
}

function matchCategory(categories, storedName) {
  if (!categories.length) return null;
  const stored = (storedName || '').trim().toLowerCase();
  if (stored) {
    const exact = categories.find(c => (c.category || '').toLowerCase() === stored);
    if (exact) return exact.id;

    const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = s => new Set(normalize(s).split(' ').filter(Boolean));
    const score = (a, b) => {
      const wa = words(a), wb = words(b);
      let inter = 0; wa.forEach(w => { if (wb.has(w)) inter++; });
      return inter / Math.max(wa.size + wb.size - inter, 1);
    };
    let best = null, bestScore = 0;
    for (const c of categories) {
      const s = score(stored, c.category || '');
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best && bestScore >= 0.4) { console.log(`FreshBooks category fuzzy match: ${best.category} (score ${bestScore.toFixed(2)})`); return best.id; }
  }

  const fallback = categories.find(c => (c.category || '').toLowerCase().includes('uncategorized'));
  if (fallback) return fallback.id;
  console.log(`FreshBooks category fallback: ${categories[0]?.category}`);
  return categories[0]?.id || null;
}

// ── FreshBooks API helper ────────────────────────────────────────────────────

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

// ── Supabase helpers ─────────────────────────────────────────────────────────

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
  const data = await sb(`freshbooks_connections?business_id=eq.${enc(business_id)}&select=access_token,refresh_token,account_id,expires_at,needs_reconnect`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function markDisconnected(business_id) {
  console.warn(`Marking FreshBooks connection as needs_reconnect for business ${business_id}`);
  await sb(`freshbooks_connections?business_id=eq.${enc(business_id)}`, {
    method:  'PATCH',
    body:    JSON.stringify({ needs_reconnect: true }),
    headers: { 'Prefer': 'return=minimal' },
  });
}

async function refreshToken(refresh_token) {
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
        catch { reject(new Error(`FreshBooks token refresh parse error: ${data}`)); }
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

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
