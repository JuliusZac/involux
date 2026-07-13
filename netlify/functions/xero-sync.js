const https = require('https');

const SB_URL     = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST = 'identity.xero.com';
const XERO_HOST  = 'api.xero.com';

// Map Involux categories → Xero account name fragments to match against Chart of Accounts
const CATEGORY_ACCOUNT = {
  'Meals & Entertainment': 'Entertainment',
  'Professional Services': 'Professional Fees',
  'Office Supplies':       'Office Supplies',
  'Travel':                'Travel',
  'Equipment':             'Equipment',
  'Utilities':             'Utilities',
  'Groceries':             'Groceries',
  'Software':              'Software',
  'Marketing':             'Marketing',
  'Shipping':              'Freight',
  'Fuel':                  'Motor Vehicle',
  'Healthcare':            'General',
  'Repairs & Maintenance': 'Repairs',
  'Other':                 'Other Business Expenses',
};
const FALLBACK_ACCOUNT_NAME = 'Other Business Expenses';

// Map Involux tax labels → Xero TaxType codes (Canadian)
const TAX_TYPE_MAP = {
  'GST/HST': 'INPUT2',
  'PST/QST': 'EXEMPTEXPENSES',
  'VAT':     'INPUT',
  'Sales Tax': 'INPUT2',
  'Tax':     'INPUT2',
};

exports.handler = async (event) => {
  const { business_id, business_name, user_email, invoice_id } = event.queryStringParameters || {};
  if (!business_id)                  return json(400, { error: 'Missing business_id' });
  if (!business_name || !user_email) return json(400, { error: 'Missing business_name or user_email' });

  try {
    const conn = await getConnection(business_id);
    if (!conn) return json(404, { error: 'Xero not connected' });

    let { access_token, refresh_token, tenant_id, expires_at } = conn;

    if (new Date(expires_at) <= new Date(Date.now() + 5 * 60 * 1000)) {
      const r = await refreshToken(refresh_token);
      access_token  = r.access_token;
      refresh_token = r.refresh_token;
      await saveTokens(business_id, access_token, refresh_token,
        new Date(Date.now() + (r.expires_in || 1800) * 1000).toISOString());
    }

    const invoices = invoice_id
      ? await sb(`invoices?id=eq.${enc(invoice_id)}&synced_to_xero=eq.false&select=id,supplier,date,amount,subtotal,category,taxes,invoice_number,payment_method,line_items`)
      : await sb(`invoices?business_name=eq.${enc(business_name)}&user_email=eq.${enc(user_email)}&synced_to_xero=eq.false&select=id,supplier,date,amount,subtotal,category,taxes,invoice_number,payment_method,line_items`);

    if (!Array.isArray(invoices) || !invoices.length) return json(200, { synced: 0, message: 'Nothing to sync' });

    // Fetch Chart of Accounts once for all invoices in this batch
    const accounts = await fetchExpenseAccounts(access_token, tenant_id);

    let synced = 0, failed = 0, errors = [], lastPayload = null;

    for (const inv of invoices) {
      if (!inv.supplier || inv.supplier === 'Processing...') continue;
      try {
        const check = await sb(`invoices?id=eq.${enc(inv.id)}&select=synced_to_xero`);
        if (Array.isArray(check) && check[0]?.synced_to_xero === true) {
          console.log(`Skipping ${inv.id} — already synced to Xero`);
          continue;
        }

        const contactId = await findOrCreateContact(access_token, tenant_id, inv.supplier);
        const payload   = buildBill(inv, contactId, accounts);
        lastPayload     = payload;

        console.log('Xero Bill payload:', JSON.stringify(payload, null, 2));

        const result  = await xero(access_token, tenant_id, 'Invoices', 'POST', JSON.stringify(payload));
        const created = result.Invoices?.[0];
        if (!created || created.HasErrors) {
          const errMsg = created?.ValidationErrors?.map(e => e.Message).join('; ') || 'Unknown Xero error';
          throw new Error(`Xero rejected bill: ${errMsg}`);
        }

        await sb(`invoices?id=eq.${inv.id}`, {
          method:  'PATCH',
          body:    JSON.stringify({ synced_to_xero: true, synced_to_xero_at: new Date().toISOString() }),
          headers: { 'Prefer': 'return=minimal' },
        });

        synced++;
        console.log(`Synced to Xero: ${inv.id} — ${inv.supplier} $${inv.amount}`);
      } catch (err) {
        failed++;
        errors.push({ id: inv.id, supplier: inv.supplier, error: err.message });
        console.error(`Xero failed ${inv.id}:`, err.message);
      }
    }

    return json(200, { synced, failed, errors, lastPayload });
  } catch (err) {
    console.error('Xero sync error:', err.message);
    return json(500, { error: err.message });
  }
};

// ── Build Xero Bill payload ───────────────────────────────────────────────────

function buildBill(inv, contactId, accounts) {
  const subtotal  = Number(inv.subtotal) || Number(inv.amount) || 0;
  const taxes     = Array.isArray(inv.taxes) ? inv.taxes.filter(t => Number(t.amount) > 0) : [];
  const taxTotal  = taxes.reduce((s, t) => s + Number(t.amount), 0);
  const grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;

  const accountCode = resolveAccountCode(accounts, inv.category);
  const lineItems   = buildLineItems(inv, subtotal, taxes, accountCode);

  return {
    Invoices: [{
      Type:            'ACCPAY',
      Contact:         { ContactID: contactId },
      Date:            inv.date || new Date().toISOString().split('T')[0],
      DueDate:         inv.date || new Date().toISOString().split('T')[0],
      LineAmountTypes: taxes.length ? 'EXCLUSIVE' : 'NOTAX',
      LineItems:       lineItems,
      Status:          'AUTHORISED',
      ...(inv.invoice_number ? { Reference: inv.invoice_number } : {}),
    }],
  };
}

function buildLineItems(inv, subtotal, taxes, accountCode) {
  const lineItems = inv.line_items;

  if (Array.isArray(lineItems) && lineItems.length > 0) {
    // Use actual line items from scanner
    const items = lineItems.map(li => ({
      Description: li.description || 'Item',
      Quantity:    Number(li.quantity) || 1,
      UnitAmount:  Number(li.unit_price) || Number(li.total) || 0,
      LineAmount:  Number(li.total) || 0,
      AccountCode: accountCode,
      TaxType:     'NONE',
    }));

    // Append tax lines if any
    taxes.forEach(t => {
      items.push({
        Description: t.label || 'Tax',
        Quantity:    1,
        UnitAmount:  Number(t.amount),
        LineAmount:  Number(t.amount),
        AccountCode: accountCode,
        TaxType:     TAX_TYPE_MAP[t.label] || 'INPUT2',
      });
    });

    return items;
  }

  // Fallback: single line with subtotal + tax lines
  const items = [{
    Description: CATEGORY_ACCOUNT[inv.category] || FALLBACK_ACCOUNT_NAME,
    Quantity:    1,
    UnitAmount:  subtotal,
    LineAmount:  subtotal,
    AccountCode: accountCode,
    TaxType:     'NONE',
  }];

  taxes.forEach(t => {
    items.push({
      Description: t.label || 'Tax',
      Quantity:    1,
      UnitAmount:  Number(t.amount),
      LineAmount:  Number(t.amount),
      AccountCode: accountCode,
      TaxType:     TAX_TYPE_MAP[t.label] || 'INPUT2',
    });
  });

  return items;
}

// ── Xero Chart of Accounts ────────────────────────────────────────────────────

async function fetchExpenseAccounts(access_token, tenant_id) {
  try {
    const res = await xero(access_token, tenant_id, `Accounts?where=Class%3D%3D%22EXPENSE%22`, 'GET');
    return res.Accounts || [];
  } catch { return []; }
}

function resolveAccountCode(accounts, category) {
  const target = CATEGORY_ACCOUNT[category] || FALLBACK_ACCOUNT_NAME;
  const match  = accounts.find(a =>
    a.Name?.toLowerCase().includes(target.toLowerCase()) ||
    target.toLowerCase().includes(a.Name?.toLowerCase())
  );
  if (match) return match.Code;
  const fallback = accounts.find(a => a.Name?.toLowerCase().includes('general')) || accounts[0];
  return fallback?.Code || '400';
}

// ── Xero contact helpers ──────────────────────────────────────────────────────

async function findOrCreateContact(access_token, tenant_id, name) {
  const vendorName = (name || '').trim() || 'Unknown Vendor';
  // URL-encode the name for the where clause
  const where = encodeURIComponent(`Name=="${vendorName}"`);
  const res   = await xero(access_token, tenant_id, `Contacts?where=${where}`, 'GET');
  const existing = res.Contacts?.[0];
  if (existing) return existing.ContactID;

  const created = await xero(access_token, tenant_id, 'Contacts', 'POST',
    JSON.stringify({ Contacts: [{ Name: vendorName }] }));
  return created.Contacts?.[0]?.ContactID;
}

// ── Xero API helper ───────────────────────────────────────────────────────────

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
  const data = await sb(`xero_connections?business_id=eq.${enc(business_id)}&select=access_token,refresh_token,tenant_id,expires_at`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function refreshToken(refresh_token) {
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
        catch { reject(new Error(`Xero token refresh parse error: ${data}`)); }
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

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
