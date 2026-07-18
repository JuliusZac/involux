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


exports.handler = async (event) => {
  const { business_id, business_name, user_email, invoice_id, xero_payment_status: status_override } = event.queryStringParameters || {};
  console.log(`Xero sync called — invoice_id=${invoice_id} status_override=${status_override}`);
  if (!business_id)                  return json(400, { error: 'Missing business_id' });
  if (!business_name || !user_email) return json(400, { error: 'Missing business_name or user_email' });

  try {
    const conn = await getConnection(business_id);
    if (!conn) return json(404, { error: 'Xero not connected' });

    let { access_token, refresh_token, tenant_id, expires_at } = conn;

    if (new Date(expires_at) <= new Date(Date.now() + 5 * 60 * 1000)) {
      const r = await refreshToken(refresh_token);
      if (r.error || !r.access_token) {
        await markDisconnected(business_id);
        return json(401, { error: 'Xero token expired — please reconnect', disconnected: true });
      }
      access_token  = r.access_token;
      refresh_token = r.refresh_token;
      await saveTokens(business_id, access_token, refresh_token,
        new Date(Date.now() + (r.expires_in || 1800) * 1000).toISOString());
    }

    // For single-invoice sync: fetch without synced_to_xero filter so we can detect already-synced
    const invoices = invoice_id
      ? await sb(`invoices?id=eq.${enc(invoice_id)}&select=id,supplier,date,due_date,amount,subtotal,category,taxes,invoice_number,payment_method,line_items,status,xero_account_code,xero_payment_status,synced_to_xero,xero_invoice_id`)
      : await sb(`invoices?business_name=eq.${enc(business_name)}&user_email=eq.${enc(user_email)}&synced_to_xero=eq.false&select=id,supplier,date,due_date,amount,subtotal,category,taxes,invoice_number,payment_method,line_items,status,xero_account_code,xero_payment_status,xero_invoice_id`);

    if (!Array.isArray(invoices) || !invoices.length) return json(200, { synced: 0, message: 'Nothing to sync' });

    // Single-invoice: if already synced, return clear message instead of silently doing nothing
    if (invoice_id && invoices[0]?.xero_invoice_id) {
      console.log(`Invoice ${invoice_id} already synced — xero_invoice_id=${invoices[0].xero_invoice_id}`);
      return json(200, { alreadySynced: true, xero_invoice_id: invoices[0].xero_invoice_id, message: 'Already synced to Xero' });
    }
    if (invoice_id && invoices[0]?.synced_to_xero) {
      console.log(`Invoice ${invoice_id} marked synced but no xero_invoice_id stored`);
      return json(200, { alreadySynced: true, message: 'Already synced to Xero' });
    }

    // Fetch Chart of Accounts and tax rates once for all invoices in this batch
    const accounts  = await fetchExpenseAccounts(access_token, tenant_id);
    const taxRates  = await fetchTaxRates(access_token, tenant_id);

    let synced = 0, failed = 0, errors = [], lastPayload = null;

    for (const inv of invoices) {
      if (!inv.supplier || inv.supplier === 'Processing...') continue;
      try {
        // Skip if already has a Xero ID stored (race-condition guard for bulk sync)
        if (inv.xero_invoice_id) {
          console.log(`Skipping ${inv.id} — xero_invoice_id already stored: ${inv.xero_invoice_id}`);
          continue;
        }

        // URL param takes priority over DB value (avoids race condition)
        const paymentStatus = status_override || inv.xero_payment_status;
        console.log(`Invoice ${inv.id} — DB status=${inv.xero_payment_status} override=${status_override} resolved=${paymentStatus}`);

        if (!paymentStatus) {
          console.log(`Skipping ${inv.id} — xero_payment_status not set`);
          continue;
        }

        const isPaid     = paymentStatus === 'PAID';
        const contactId  = await findOrCreateContact(access_token, tenant_id, inv.supplier);

        // Backup duplicate check: search Xero for existing Bill with same Reference
        if (inv.invoice_number) {
          const existing = await findExistingBill(access_token, tenant_id, inv.invoice_number);
          if (existing) {
            console.log(`Found existing Xero bill for reference ${inv.invoice_number}: ${existing.InvoiceID}`);
            await sb(`invoices?id=eq.${inv.id}`, {
              method:  'PATCH',
              body:    JSON.stringify({ synced_to_xero: true, synced_to_xero_at: new Date().toISOString(), xero_invoice_id: existing.InvoiceID }),
              headers: { 'Prefer': 'return=minimal' },
            });
            synced++;
            continue;
          }
        }

        const payload    = buildBill(inv, contactId, accounts, taxRates);
        lastPayload      = payload;

        console.log(`Xero sync: ${inv.supplier} — ${paymentStatus} (isPaid=${isPaid})`);
        console.log('Xero Bill payload:', JSON.stringify(payload, null, 2));

        const result  = await xero(access_token, tenant_id, 'Invoices', 'POST', JSON.stringify(payload));
        const created = result.Invoices?.[0];
        if (!created || created.HasErrors) {
          const errMsg = created?.ValidationErrors?.map(e => e.Message).join('; ') || 'Unknown Xero error';
          throw new Error(`Xero rejected bill: ${errMsg}`);
        }

        if (isPaid) {
          const payAmount = created.AmountDue || created.Total || Number(inv.amount) || 0;
          const payDate   = inv.date || new Date().toISOString().split('T')[0];
          try {
            await addPayment(access_token, tenant_id, created.InvoiceID, payAmount, payDate);
            console.log(`Payment added: $${payAmount} on ${payDate}`);
          } catch (payErr) {
            console.warn(`Payment skipped (bill still created): ${payErr.message}`);
          }
        }

        await sb(`invoices?id=eq.${inv.id}`, {
          method:  'PATCH',
          body:    JSON.stringify({ synced_to_xero: true, synced_to_xero_at: new Date().toISOString(), xero_payment_status: paymentStatus, xero_invoice_id: created.InvoiceID }),
          headers: { 'Prefer': 'return=minimal' },
        });

        synced++;
        console.log(`Synced to Xero: ${inv.id} — ${inv.supplier} $${inv.amount} (${paymentStatus})`);
      } catch (err) {
        if (err.xeroUnauthorized) {
          await markDisconnected(business_id);
          return json(401, { error: 'Xero connection lost — please reconnect', disconnected: true });
        }
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

function buildBill(inv, contactId, accounts, taxRates) {
  const subtotal    = Number(inv.subtotal) || Number(inv.amount) || 0;
  const taxes       = Array.isArray(inv.taxes) ? inv.taxes.filter(t => Number(t.amount) > 0) : [];
  // Use account stored at scan time when available; fall back to category mapping
  const accountCode = inv.xero_account_code || resolveAccountCode(accounts, inv.category);
  const taxType     = resolveTaxType(taxRates, taxes, subtotal);
  const lineItems   = buildLineItems(inv, subtotal, accountCode, taxType);

  return {
    Invoices: [{
      Type:            'ACCPAY',
      Contact:         { ContactID: contactId },
      Date:            inv.date || new Date().toISOString().split('T')[0],
      DueDate:         inv.due_date || inv.date || new Date().toISOString().split('T')[0],
      LineAmountTypes: 'Exclusive',
      LineItems:       lineItems,
      Status:          'AUTHORISED',
      ...(inv.invoice_number ? { Reference: inv.invoice_number } : {}),
    }],
  };
}

function buildLineItems(inv, subtotal, accountCode, taxType) {
  const scannedLines = inv.line_items;
  const acct = accountCode ? { AccountCode: accountCode } : {};

  const SUMMARY_ROW = /^(sous-?total|sub-?total|total|tps|tvq|tva|gst|hst|pst|tax|taxes|tip|gratuity|discount|change|balance)$/i;

  if (Array.isArray(scannedLines) && scannedLines.length > 0) {
    const itemLines = scannedLines.filter(li => {
      const desc = (li.description || '').trim();
      return desc && !SUMMARY_ROW.test(desc);
    });
    const lines = itemLines.length > 0 ? itemLines : scannedLines;
    return lines.map(li => {
      const qty       = Number(li.quantity) || 1;
      // Always derive from line total when available — unit_price can be the line total, not per-unit
      const lineTotal = Number(li.total) || Number(li.unit_price) * qty || 0;
      const unitPrice = Math.round((lineTotal / qty) * 100) / 100;
      return {
        Description: li.description || 'Item',
        Quantity:    qty,
        UnitAmount:  unitPrice,
        TaxType:     taxType,
        ...acct,
      };
    });
  }

  // Fallback: single line for the subtotal (pre-tax)
  return [{
    Description: CATEGORY_ACCOUNT[inv.category] || FALLBACK_ACCOUNT_NAME,
    Quantity:    1,
    UnitAmount:  subtotal,
    TaxType:     taxType,
    ...acct,
  }];
}

// Match invoice taxes to the correct Xero TaxType by rate % and label
function resolveTaxType(taxRates, taxes, subtotal) {
  if (!taxes.length || !taxRates.length) return 'NONE';

  const active = taxRates.filter(r => r.Status === 'ACTIVE');

  // Compute effective rate from invoice: total tax / subtotal * 100
  const totalTax   = taxes.reduce((s, t) => s + Number(t.amount), 0);
  const effectiveRate = subtotal > 0 ? Math.round((totalTax / subtotal) * 1000) / 10 : 0;
  const labels     = taxes.map(t => (t.label || '').toLowerCase()).join(' ');

  console.log(`Tax resolution: label="${labels}", effectiveRate=${effectiveRate}%, subtotal=${subtotal}`);

  // Score each Xero tax rate — highest score wins
  let best = null, bestScore = -1;
  for (const r of active) {
    const name      = (r.Name || '').toLowerCase();
    const xeroRate  = Number(r.EffectiveRate || r.TaxComponents?.[0]?.Rate || 0);
    const rateDiff  = Math.abs(xeroRate - effectiveRate);
    let score = 0;

    // Label match bonuses
    if (/hst/.test(labels) && /hst/i.test(name)) score += 40;
    if (/gst/.test(labels) && /gst/i.test(name)) score += 30;
    if (/pst|qst/.test(labels) && /pst|qst/i.test(name)) score += 30;
    if (/purchase|input|expense/i.test(name)) score += 10;

    // Rate proximity bonus — within 0.1% is exact match
    if (rateDiff <= 0.1) score += 50;
    else if (rateDiff <= 1) score += 20;
    else if (rateDiff <= 3) score += 5;
    else score -= 10;

    console.log(`  TaxRate candidate: ${r.TaxType} "${r.Name}" ${xeroRate}% → score ${score}`);
    if (score > bestScore) { bestScore = score; best = r; }
  }

  if (best && bestScore > 0) {
    console.log(`Selected TaxType: ${best.TaxType} "${best.Name}" (score ${bestScore})`);
    return best.TaxType;
  }

  // No good match — use NONE so bill still goes through
  console.warn('No tax rate match found, using NONE');
  return 'NONE';
}

// ── Xero payment helper ───────────────────────────────────────────────────────

async function addPayment(access_token, tenant_id, invoiceId, amount, date) {
  const bankAccount = await findBankAccount(access_token, tenant_id);
  const accountRef  = bankAccount.Code
    ? { Code: bankAccount.Code }
    : { AccountID: bankAccount.AccountID };
  const body = JSON.stringify({
    Invoice:  { InvoiceID: invoiceId },
    Account:  accountRef,
    Date:     date,
    Amount:   amount,
  });
  const result = await xero(access_token, tenant_id, 'Payments', 'POST', body);
  if (result.Payments?.[0]?.HasErrors) {
    const errMsg = result.Payments[0].ValidationErrors?.map(e => e.Message).join('; ') || 'Payment error';
    throw new Error(`Xero payment failed: ${errMsg}`);
  }
  return result.Payments?.[0];
}

async function findBankAccount(access_token, tenant_id) {
  try {
    const res = await xero(access_token, tenant_id,
      `Accounts?where=Type%3D%3D%22BANK%22`, 'GET');
    const accounts = res.Accounts || [];
    console.log('Bank accounts found:', accounts.map(a => `${a.AccountID} Code=${a.Code} Name=${a.Name}`).join(', '));
    if (!accounts.length) throw new Error('No bank accounts found in Xero');
    return { Code: accounts[0].Code || null, AccountID: accounts[0].AccountID };
  } catch (e) {
    throw new Error(`findBankAccount failed: ${e.message}`);
  }
}

// ── Xero tax rates ────────────────────────────────────────────────────────────

async function fetchTaxRates(access_token, tenant_id) {
  try {
    const res = await xero(access_token, tenant_id, 'TaxRates', 'GET');
    const rates = res.TaxRates || [];
    console.log('Xero tax rates:', rates.map(r => `${r.TaxType} — ${r.Name}`).join(', '));
    return rates;
  } catch (e) {
    console.warn('Could not fetch tax rates:', e.message);
    return [];
  }
}

// ── Xero Chart of Accounts ────────────────────────────────────────────────────

async function fetchExpenseAccounts(access_token, tenant_id) {
  try {
    const res = await xero(access_token, tenant_id, `Accounts?where=Class%3D%3D%22EXPENSE%22`, 'GET');
    const accounts = res.Accounts || [];
    console.log('Xero expense accounts:', accounts.map(a => `${a.Code} — ${a.Name}`).join(', '));
    return accounts;
  } catch (e) {
    console.warn('Could not fetch accounts:', e.message);
    return [];
  }
}

function resolveAccountCode(accounts, category) {
  const target = CATEGORY_ACCOUNT[category] || FALLBACK_ACCOUNT_NAME;
  const match  = accounts.find(a =>
    a.Name?.toLowerCase().includes(target.toLowerCase()) ||
    target.toLowerCase().includes(a.Name?.toLowerCase())
  );
  if (match) return match.Code;
  // Prefer any account with 'general' or 'expense' in the name, else first account
  const fallback = accounts.find(a => /general|expense/i.test(a.Name || '')) || accounts[0];
  if (fallback) { console.log(`No match for "${target}", using fallback: ${fallback.Code} — ${fallback.Name}`); return fallback.Code; }
  console.warn('No expense accounts found — using hardcoded fallback 429 (General Expenses)');
  return '429';
}

// ── Xero contact helpers ──────────────────────────────────────────────────────

async function findExistingBill(access_token, tenant_id, reference) {
  try {
    const where = encodeURIComponent(`Type=="ACCPAY"&&Reference=="${reference}"`);
    const res   = await xero(access_token, tenant_id, `Invoices?where=${where}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED`, 'GET');
    const bills = res.Invoices || [];
    return bills.length ? bills[0] : null;
  } catch (e) {
    console.warn(`findExistingBill failed for reference ${reference}:`, e.message);
    return null;
  }
}

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
        if (res.statusCode === 401) { const e = new Error(`Xero 401: unauthorized`); e.xeroUnauthorized = true; return reject(e); }
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
  console.warn(`Marking Xero connection as needs_reconnect for business ${business_id}`);
  await sb(`xero_connections?business_id=eq.${enc(business_id)}`, {
    method:  'PATCH',
    body:    JSON.stringify({ needs_reconnect: true }),
    headers: { 'Prefer': 'return=minimal' },
  });
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
