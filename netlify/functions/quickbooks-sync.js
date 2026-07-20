const https = require('https');

const SB_URL   = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST = 'oauth.platform.intuit.com';
const QB_HOST  = process.env.QUICKBOOKS_ENVIRONMENT === 'production'
  ? 'quickbooks.api.intuit.com'
  : 'sandbox-quickbooks.api.intuit.com';
const IS_SANDBOX = QB_HOST.includes('sandbox');

const FALLBACK_ACCOUNT_NAME = 'Uncategorized Expense';

exports.handler = async (event) => {
  const { business_id, business_name, user_email, invoice_id, qb_payment_status: status_override } = event.queryStringParameters || {};
  if (!business_id)                    return json(400, { error: 'Missing business_id' });
  if (!business_name || !user_email)   return json(400, { error: 'Missing business_name or user_email' });

  try {
    // 1. Get QB connection + refresh token if needed
    const conn = await getConnection(business_id);
    if (!conn) return json(404, { error: 'QuickBooks not connected' });

    let { access_token, refresh_token, realm_id, expires_at } = conn;
    if (new Date(expires_at) <= new Date(Date.now() + 5 * 60 * 1000)) {
      const r = await refreshToken(refresh_token);
      access_token   = r.access_token;
      refresh_token  = r.refresh_token;
      await saveTokens(business_id, access_token, refresh_token,
        new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString());
    }

    // 2. Fetch invoices — single invoice without synced filter so we can detect already-synced
    const invoices = invoice_id
      ? await sb(`invoices?id=eq.${enc(invoice_id)}&select=id,supplier,date,due_date,amount,subtotal,taxes,invoice_number,payment_method,synced_to_quickbooks,qb_payment_status,qb_account_name`)
      : await sb(`invoices?business_name=eq.${enc(business_name)}&user_email=eq.${enc(user_email)}&synced_to_quickbooks=eq.false&select=id,supplier,date,due_date,amount,subtotal,taxes,invoice_number,payment_method,qb_payment_status,qb_account_name`);

    if (!Array.isArray(invoices) || !invoices.length) return json(200, { synced: 0, message: 'Nothing to sync' });

    // Single-invoice: if already synced return clear message
    if (invoice_id && invoices[0]?.synced_to_quickbooks) {
      return json(200, { alreadySynced: true, message: 'Already synced to QuickBooks' });
    }

    let synced = 0, failed = 0, errors = [];

    for (const inv of invoices) {
      if (!inv.supplier || inv.supplier === 'Processing...') continue;
      if (inv.synced_to_quickbooks) { console.log(`Skipping ${inv.id} — already synced`); continue; }

      try {
        const paymentStatus = status_override || inv.qb_payment_status;
        if (!paymentStatus) { console.log(`Skipping ${inv.id} — qb_payment_status not set`); continue; }

        const isPaid = paymentStatus === 'PAID';
        console.log(`QB sync: ${inv.supplier} — ${paymentStatus}`);

        // Find or create vendor + expense account (both paths need these)
        const vendorId  = await findOrCreateVendor(realm_id, access_token, inv.supplier);
        const accountId = await resolveExpenseAccount(realm_id, access_token, inv.qb_account_name);

        if (isPaid) {
          // Paid → Expense (Purchase object)
          const paymentAccountId = await findPaymentAccount(realm_id, access_token);
          await pushExpense(realm_id, access_token, inv, vendorId, accountId, paymentAccountId);
        } else {
          // Awaiting Payment → Bill
          await pushBill(realm_id, access_token, inv, vendorId, accountId);
        }

        // Mark synced
        await sb(`invoices?id=eq.${inv.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ synced_to_quickbooks: true, synced_at: new Date().toISOString(), qb_payment_status: paymentStatus }),
          headers: { 'Prefer': 'return=minimal' },
        });

        synced++;
        console.log(`Synced ${inv.id} — ${inv.supplier} $${inv.amount} (${paymentStatus})`);
      } catch (err) {
        failed++;
        errors.push({ id: inv.id, supplier: inv.supplier, error: err.message });
        console.error(`Failed ${inv.id}:`, err.message);
      }
    }

    return json(200, { synced, failed, errors });
  } catch (err) {
    console.error('Sync error:', err.message);
    return json(500, { error: err.message });
  }
};

// ── Push invoice to QB as an Expense ─────────────────────────────────────────

async function pushExpense(realm_id, access_token, inv, vendorId, expenseAccountId, paymentAccountId) {
  const subtotal = Number(inv.subtotal) || Number(inv.amount) || 0;
  const taxes    = Array.isArray(inv.taxes) ? inv.taxes.filter(t => Number(t.amount) > 0) : [];
  const taxTotal = taxes.reduce((s, t) => s + Number(t.amount), 0);
  const total    = Math.round((subtotal + taxTotal) * 100) / 100;
  const memo     = taxes.length
    ? `Tax breakdown: ${taxes.map(t => `${t.label || 'Tax'}: $${Number(t.amount).toFixed(2)}`).join(', ')} | Subtotal: $${subtotal.toFixed(2)} | Total: $${total.toFixed(2)}`
    : null;

  let taxFields = {};
  if (taxes.length) {
    if (IS_SANDBOX) {
      // Sandbox has no CA tax rates — send grand total as line amount, taxes in memo only
      taxFields = { lineAmount: total };
    } else {
      // Production: look up real QB tax rate IDs so taxes appear in the TAX column
      const taxRates = await fetchTaxRates(realm_id, access_token);
      const taxLines = taxes.map(t => {
        const match = matchTaxRate(taxRates, t.label);
        return {
          Amount: Number(t.amount),
          DetailType: 'TaxLineDetail',
          TaxLineDetail: {
            TaxRateRef: match ? { value: match.Id } : { name: t.label || 'Tax' },
            NetAmountTaxable: subtotal,
          },
        };
      });
      taxFields = {
        lineAmount: subtotal,  // line = subtotal; QB adds tax lines to reach total
        txnTax: { GlobalTaxCalculation: 'TaxExcluded', TxnTaxDetail: { TotalTax: taxTotal, TaxLine: taxLines } },
      };
    }
  }

  const paymentMethodId = inv.payment_method
    ? await findPaymentMethod(realm_id, access_token, inv.payment_method)
    : null;

  const body = {
    PaymentType: 'Cash',
    AccountRef:  { value: paymentAccountId },
    EntityRef:   { value: vendorId, type: 'Vendor' },
    TxnDate:     inv.date || new Date().toISOString().split('T')[0],
    ...(inv.invoice_number ? { DocNumber: inv.invoice_number } : {}),
    // LINE ADDED: payment method looked up/created in QB so field populates
    ...(paymentMethodId ? { PaymentMethodRef: { value: paymentMethodId } } : {}),
    Line: [{
      Amount:     taxFields.lineAmount ?? total,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAccountId } },
    }],
    ...(memo ? { PrivateNote: memo } : {}),
    ...(taxFields.txnTax || {}),
  };

  console.log('QB Expense:', JSON.stringify(body));
  return qb(realm_id, access_token, 'purchase?minorversion=65', 'POST', body);
}

// ── Push invoice to QB as a Bill (Awaiting Payment) ──────────────────────────

async function pushBill(realm_id, access_token, inv, vendorId, expenseAccountId) {
  const subtotal = Number(inv.subtotal) || Number(inv.amount) || 0;
  const taxes    = Array.isArray(inv.taxes) ? inv.taxes.filter(t => Number(t.amount) > 0) : [];
  const taxTotal = taxes.reduce((s, t) => s + Number(t.amount), 0);
  const total    = Math.round((subtotal + taxTotal) * 100) / 100;
  const txnDate  = inv.date || new Date().toISOString().split('T')[0];
  const dueDate  = inv.due_date || txnDate;
  const memo     = taxes.length
    ? `Tax: ${taxes.map(t => `${t.label || 'Tax'}: $${Number(t.amount).toFixed(2)}`).join(', ')} | Subtotal: $${subtotal.toFixed(2)} | Total: $${total.toFixed(2)}`
    : null;

  const body = {
    VendorRef: { value: vendorId },
    TxnDate:   txnDate,
    DueDate:   dueDate,
    ...(inv.invoice_number ? { DocNumber: inv.invoice_number } : {}),
    Line: [{
      Amount:     total,
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAccountId } },
    }],
    ...(memo ? { PrivateNote: memo } : {}),
  };

  console.log('QB Bill:', JSON.stringify(body));
  return qb(realm_id, access_token, 'bill?minorversion=65', 'POST', body);
}

async function fetchTaxRates(realm_id, access_token) {
  try {
    const res = await qb(realm_id, access_token,
      `query?query=${enc('SELECT * FROM TaxRate MAXRESULTS 50')}&minorversion=65`);
    return res.QueryResponse?.TaxRate || [];
  } catch { return []; }
}

function matchTaxRate(rates, label) {
  const l = (label || '').toUpperCase();
  for (const r of rates) {
    const n = (r.Name || '').toUpperCase();
    if ((l.includes('GST') || l.includes('TPS')) && (n.includes('GST') || n.includes('TPS'))) return r;
    if ((l.includes('HST') || l.includes('TVH')) && (n.includes('HST') || n.includes('TVH'))) return r;
    if ((l.includes('PST') || l.includes('TVP')) && (n.includes('PST') || n.includes('TVP'))) return r;
    if ((l.includes('QST') || l.includes('TVQ')) && (n.includes('QST') || n.includes('TVQ'))) return r;
  }
  return rates[0] || null;
}


// ── QB helpers ───────────────────────────────────────────────────────────────

async function findOrCreateVendor(realm_id, access_token, name) {
  const vendorName = (name || '').trim() || 'Unknown Vendor';
  const safe = vendorName.replace(/'/g, "''");
  const res = await qb(realm_id, access_token,
    `query?query=${enc(`SELECT * FROM Vendor WHERE DisplayName = '${safe}'`)}&minorversion=65`);
  const existing = res.QueryResponse?.Vendor?.[0];
  if (existing) return existing.Id;
  const created = await qb(realm_id, access_token, 'vendor?minorversion=65', 'POST', { DisplayName: vendorName });
  return created.Vendor?.Id;
}

async function resolveExpenseAccount(realm_id, access_token, qb_account_name) {
  // Fetch all expense accounts once
  const res = await qb(realm_id, access_token,
    `query?query=${enc('SELECT * FROM Account WHERE AccountType = \'Expense\' MAXRESULTS 200')}&minorversion=65`);
  const accounts = (res.QueryResponse?.Account || []).filter(a => a.Active !== false);
  if (!accounts.length) return '1';

  // 1. Exact match (case-insensitive)
  const stored = (qb_account_name || '').trim().toLowerCase();
  if (stored) {
    const exact = accounts.find(a => a.Name.toLowerCase() === stored);
    if (exact) { console.log(`QB account exact match: ${exact.Name}`); return exact.Id; }

    // 2. Fuzzy — word overlap score (same approach as Xero vendor matching)
    const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = s => new Set(normalize(s).split(' ').filter(Boolean));
    const score = (a, b) => {
      const wa = words(a), wb = words(b);
      let inter = 0; wa.forEach(w => { if (wb.has(w)) inter++; });
      return inter / Math.max(wa.size + wb.size - inter, 1);
    };
    let best = null, bestScore = 0;
    for (const a of accounts) {
      const s = score(stored, a.Name);
      if (s > bestScore) { bestScore = s; best = a; }
    }
    if (best && bestScore >= 0.4) { console.log(`QB account fuzzy match: ${best.Name} (score ${bestScore.toFixed(2)})`); return best.Id; }
  }

  // 3. Fallback — look for "Uncategorized Expense" account, else first account
  const fallback = accounts.find(a => a.Name.toLowerCase().includes('uncategorized'));
  if (fallback) return fallback.Id;
  console.log(`QB account fallback: ${accounts[0].Name}`);
  return accounts[0].Id;
}

async function findPaymentMethod(realm_id, access_token, name) {
  try {
    // 1. Query all existing payment methods
    const res = await qb(realm_id, access_token,
      `query?query=${enc('SELECT * FROM PaymentMethod MAXRESULTS 50')}&minorversion=65`);
    const methods = res.QueryResponse?.PaymentMethod || [];
    // 2. Case-insensitive match
    const match = methods.find(m => m.Name?.toLowerCase() === name.toLowerCase());
    if (match) return match.Id;
    // 3. Not found — create it so any method (e-Transfer, Interac, etc.) works automatically
    const created = await qb(realm_id, access_token, 'paymentmethod?minorversion=65', 'POST', { Name: name });
    return created.PaymentMethod?.Id || null;
  } catch { return null; }
}

async function findPaymentAccount(realm_id, access_token) {
  // Prefer a checking/bank account; fall back to any bank/credit account
  const res = await qb(realm_id, access_token,
    `query?query=${enc(`SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 1`)}&minorversion=65`);
  const bank = res.QueryResponse?.Account?.[0];
  if (bank) return bank.Id;
  const cc = await qb(realm_id, access_token,
    `query?query=${enc(`SELECT * FROM Account WHERE AccountType = 'Credit Card' MAXRESULTS 1`)}&minorversion=65`);
  return cc.QueryResponse?.Account?.[0]?.Id || '1';
}

function qb(realm_id, access_token, path, method = 'GET', body = null) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: QB_HOST,
      path: `/v3/company/${realm_id}/${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { return reject(new Error(`QB parse error: ${data}`)); }
        if (res.statusCode >= 400) return reject(new Error(`QB ${res.statusCode}: ${JSON.stringify(parsed?.Fault || parsed)}`));
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
      path: `/rest/v1/${path}`,
      method,
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(opts.headers || {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
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

async function refreshToken(refresh_token) {
  const creds = Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64');
  const body  = new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKEN_HOST,
      path: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Token refresh error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function saveTokens(business_id, access_token, refresh_token, expires_at) {
  await sb(`quickbooks_connections?business_id=eq.${enc(business_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ access_token, refresh_token, expires_at }),
    headers: { 'Prefer': 'return=minimal' },
  });
}

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
