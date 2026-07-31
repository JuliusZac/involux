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
      ? await sb(`invoices?id=eq.${enc(invoice_id)}&select=id,supplier,date,due_date,amount,subtotal,taxes,invoice_number,freshbooks_category_name,freshbooks_payment_status,synced_to_freshbooks,line_items,currency`)
      : await sb(`invoices?business_name=eq.${enc(business_name)}&user_email=eq.${enc(user_email)}&synced_to_freshbooks=eq.false&select=id,supplier,date,due_date,amount,subtotal,taxes,invoice_number,freshbooks_category_name,freshbooks_payment_status,line_items,currency`);

    if (!Array.isArray(invoices) || !invoices.length) return json(200, { synced: 0, message: 'Nothing to sync' });

    if (invoice_id && invoices[0]?.synced_to_freshbooks) {
      return json(200, { alreadySynced: true, message: 'Already synced to FreshBooks' });
    }

    // FreshBooks has no distinct doc-number/reference field on Bills to dedupe against
    // like Xero/QB, so synced_to_freshbooks is the sole guard against double-syncing.
    const [categories, staffId] = await Promise.all([
      fetchCategories(account_id, access_token),
      fetchDefaultStaffId(account_id, access_token),
    ]);

    let synced = 0, failed = 0, errors = [];

    for (const inv of invoices) {
      if (!inv.supplier || inv.supplier === 'Processing...') continue;
      if (inv.synced_to_freshbooks) { console.log(`Skipping ${inv.id} — already synced`); continue; }

      try {
        const paymentStatus = status_override || inv.freshbooks_payment_status;
        if (!paymentStatus) { console.log(`Skipping ${inv.id} — freshbooks_payment_status not set`); continue; }
        const isPaid = paymentStatus === 'PAID';
        const categoryId = matchCategory(categories, inv.freshbooks_category_name);

        console.log(`FreshBooks sync: ${inv.supplier} — ${paymentStatus} (${isPaid ? 'Expense' : 'Bill'})`);

        let freshbooksObjectId;
        if (isPaid) {
          // Already paid → a completed cash transaction, not a liability — goes
          // straight into Expenses. Free-text vendor field, no vendor lookup needed.
          const payload = buildExpense(inv, categoryId, staffId);
          console.log('FreshBooks Expense payload:', JSON.stringify(payload));
          const result  = await fb(account_id, access_token, 'expenses/expenses', 'POST', payload);
          const created = result?.response?.result?.expense;
          if (!created?.id) throw new Error(`FreshBooks rejected expense: ${JSON.stringify(result?.response?.errors || result)}`);
          freshbooksObjectId = created.id;
        } else {
          // Still owed → tracked as Accounts Payable via a Bill against a real vendor.
          const vendorId = await findOrCreateVendor(account_id, access_token, inv.supplier, inv.currency || BASE_CURRENCY);
          const payload  = buildBill(inv, vendorId, categoryId, categories);
          console.log('FreshBooks Bill payload:', JSON.stringify(payload));
          try {
            const result  = await fb(account_id, access_token, 'bills/bills', 'POST', payload);
            const created = result?.response?.result?.bill;
            if (!created?.id) throw new Error(`FreshBooks rejected bill: ${JSON.stringify(result?.response?.errors || result)}`);
            freshbooksObjectId = created.id;
          } catch (billErr) {
            // A prior attempt can succeed on FreshBooks' side but still throw here
            // (e.g. a since-fixed field-name bug, or a dropped response) — retrying
            // then hits FreshBooks' own "bill_number already in use" guard. Recover
            // by looking up that existing bill instead of failing the whole sync.
            if (inv.invoice_number && /bill_number/.test(billErr.message) && /in use/i.test(billErr.message)) {
              const existingId = await findExistingBill(account_id, access_token, vendorId, inv.invoice_number);
              if (existingId) {
                console.log(`Recovered existing FreshBooks bill ${existingId} for bill_number ${inv.invoice_number}`);
                freshbooksObjectId = existingId;
              } else {
                throw billErr;
              }
            } else {
              throw billErr;
            }
          }
        }

        await sb(`invoices?id=eq.${inv.id}`, {
          method:  'PATCH',
          body:    JSON.stringify({ synced_to_freshbooks: true, synced_to_freshbooks_at: new Date().toISOString(), freshbooks_payment_status: paymentStatus, freshbooks_expense_id: freshbooksObjectId }),
          headers: { 'Prefer': 'return=minimal' },
        });

        // Best-effort — kept separate so a missing freshbooks_object_type column
        // (if that migration hasn't been applied yet) can't mark an otherwise
        // successful sync as failed. Frozen at sync time on purpose: a Bill that
        // later gets paid in FreshBooks stays a Bill, it doesn't become an Expense.
        try {
          await sb(`invoices?id=eq.${inv.id}`, {
            method:  'PATCH',
            body:    JSON.stringify({ freshbooks_object_type: isPaid ? 'expense' : 'bill' }),
            headers: { 'Prefer': 'return=minimal' },
          });
        } catch (e) {
          console.warn(`Could not store freshbooks_object_type for ${inv.id} (column may not exist yet):`, e.message);
        }

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

// ── Build FreshBooks Expense payload (already-paid invoices) ───────────────
// Expenses are a completed cash transaction — one record per invoice, a single
// category, free-text vendor (no vendorid lookup), and dollar-amount taxes via
// FreshBooks' native tax_name1/tax_amount1(+2) fields.

function buildExpense(inv, categoryId, staffId) {
  const subtotal = Number(inv.subtotal) || Number(inv.amount) || 0;
  const taxes    = Array.isArray(inv.taxes) ? inv.taxes.filter(t => Number(t.amount) > 0) : [];
  const total    = Number(inv.amount) || subtotal + taxes.reduce((s, t) => s + Number(t.amount), 0);

  const lineDesc = Array.isArray(inv.line_items) && inv.line_items.length
    ? inv.line_items.filter(li => li.description && !li.excluded).map(li => li.description).join(', ')
    : null;
  const notesParts = [];
  if (inv.invoice_number) notesParts.push(`Invoice #${inv.invoice_number}`);
  if (lineDesc) notesParts.push(lineDesc);

  const expense = {
    amount:  { amount: total.toFixed(2), code: inv.currency || BASE_CURRENCY },
    date:    inv.date || new Date().toISOString().split('T')[0],
    vendor:  inv.supplier,
    ...(notesParts.length ? { notes: notesParts.join(' — ').slice(0, 1000) } : {}),
    ...(categoryId ? { categoryid: categoryId } : {}),
    ...(staffId ? { staffid: staffId } : {}),
  };

  taxes.slice(0, 2).forEach((t, i) => {
    expense[`tax_name${i + 1}`]   = (t.label || 'Tax').slice(0, 50);
    expense[`tax_amount${i + 1}`] = Number(t.amount).toFixed(2);
  });

  return { expense };
}

// ── Build FreshBooks Bill payload (still-owed invoices) ─────────────────────
// Bills genuinely support per-line-item categorization (via the same
// expense_categories list used by Expenses) and real Accounts Payable
// tracking — this is only ever created unpaid; it moves to "paid" later
// in FreshBooks itself once someone records a payment against it there.

const SUMMARY_ROW = /^(sous-?total|sub-?total|total|tps|tvq|tva|gst|hst|pst|tax|taxes|tip|gratuity|discount|change|balance)$/i;

// FreshBooks bill lines take a tax PERCENT (not a dollar amount) applied per line,
// unlike Xero/QB which take a dollar tax total or a single tax code. We only have
// dollar tax amounts on the invoice, so derive an effective percent from the total
// tax vs. subtotal and apply that same percent to every line — approximate, but
// consistent with how Xero's single-TaxType-for-the-whole-bill simplification works.
function computeTaxPercents(inv, subtotal) {
  const taxes = Array.isArray(inv.taxes) ? inv.taxes.filter(t => Number(t.amount) > 0) : [];
  if (!taxes.length || subtotal <= 0) return [];
  return taxes.slice(0, 2).map(t => ({
    name:    (t.label || 'Tax').slice(0, 50),
    percent: Math.round((Number(t.amount) / subtotal) * 10000) / 100,
  }));
}

function buildBillLines(inv, categories, fallbackCategoryId, taxPercents, currency) {
  const taxFields = {};
  taxPercents.forEach((t, i) => { taxFields[`tax_name${i + 1}`] = t.name; taxFields[`tax_percent${i + 1}`] = t.percent; });

  const scannedLines = inv.line_items;
  if (Array.isArray(scannedLines) && scannedLines.length > 0) {
    const itemLines = scannedLines.filter(li => {
      if (li.excluded) return false;
      const desc = (li.description || '').trim();
      return desc && !SUMMARY_ROW.test(desc);
    });
    const lines = itemLines.length > 0 ? itemLines : scannedLines;
    return lines.map(li => {
      const qty       = Number(li.quantity) || 1;
      const lineTotal = Number(li.total) || Number(li.unit_price) * qty || 0;
      const unitCost  = Math.round((lineTotal / qty) * 100) / 100;
      const categoryId = li.freshbooks_category_name ? matchCategory(categories, li.freshbooks_category_name) : fallbackCategoryId;
      return {
        description: li.description || 'Item',
        quantity:    qty,
        unit_cost:   { amount: unitCost.toFixed(2), code: currency },
        ...(categoryId ? { categoryid: categoryId } : {}),
        ...taxFields,
      };
    });
  }

  // Fallback: single line for the subtotal (pre-tax)
  const subtotal = Number(inv.subtotal) || Number(inv.amount) || 0;
  return [{
    description: inv.supplier ? `${inv.supplier} invoice` : 'Expense',
    quantity:    1,
    unit_cost:   { amount: subtotal.toFixed(2), code: currency },
    ...(fallbackCategoryId ? { categoryid: fallbackCategoryId } : {}),
    ...taxFields,
  }];
}

// due_date is read-only on the Bill object — FreshBooks computes it from
// issue_date + due_offset_days, which is the field that's actually settable.
function computeDueOffsetDays(issueDate, dueDate) {
  if (!dueDate) return 0;
  const issue = new Date(issueDate + 'T00:00:00');
  const due   = new Date(dueDate + 'T00:00:00');
  const days  = Math.round((due - issue) / (1000 * 60 * 60 * 24));
  return days > 0 ? days : 0;
}

function buildBill(inv, vendorId, categoryId, categories) {
  const currency  = inv.currency || BASE_CURRENCY;
  const subtotal  = Number(inv.subtotal) || Number(inv.amount) || 0;
  const taxPercents = computeTaxPercents(inv, subtotal);
  const lines     = buildBillLines(inv, categories, categoryId, taxPercents, currency);
  const issueDate = inv.date || new Date().toISOString().split('T')[0];

  return {
    bill: {
      vendorid:        vendorId,
      issue_date:      issueDate,
      due_offset_days: computeDueOffsetDays(issueDate, inv.due_date),
      currency_code:   currency,
      language:        'en',
      ...(inv.invoice_number ? { bill_number: inv.invoice_number } : {}),
      lines,
    },
  };
}

// ── FreshBooks Bill Vendors ──────────────────────────────────────────────────

// Suffixes that don't identify a vendor — stripped before comparison (same approach as Xero/QB)
const NOISE = /\b(ltd\.?|inc\.?|corp\.?|co\.?|llc\.?|limited|incorporated|company|group|enterprises?|solutions?|services?|international|canada|canadian)\b\.?/gi;

function normalizeVendor(s) {
  return (s || '').toLowerCase().replace(NOISE, '').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function wordOverlapScore(a, b) {
  const wa = new Set(normalizeVendor(a).split(' ').filter(Boolean));
  const wb = new Set(normalizeVendor(b).split(' ').filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common);
}

// The Bill Vendors API has no documented name-search query param, so unlike Xero/QB
// (which support a server-side search) this lists vendors and matches client-side.
async function findExistingBill(account_id, access_token, vendorId, billNumber) {
  try {
    const path = `bills/bills?search[vendorid]=${encodeURIComponent(vendorId)}&search[bill_number]=${encodeURIComponent(billNumber)}`;
    const res  = await fb(account_id, access_token, path, 'GET');
    const bills = res?.response?.result?.bills || [];
    return bills[0]?.id || null;
  } catch (e) {
    console.warn(`findExistingBill failed for bill_number ${billNumber}:`, e.message);
    return null;
  }
}

async function findOrCreateVendor(account_id, access_token, name, currency) {
  const vendorName = (name || '').trim() || 'Unknown Vendor';

  let vendors = [];
  try {
    const res = await fb(account_id, access_token, 'bill_vendors/bill_vendors?per_page=100', 'GET');
    vendors = res?.response?.result?.bill_vendors || [];
  } catch (e) {
    console.warn('FreshBooks vendor list failed, will create new:', e.message);
  }

  const exact = vendors.find(v => (v.vendor_name || '').toLowerCase() === vendorName.toLowerCase());
  if (exact) return exact.vendorid;

  let best = null, bestScore = 0;
  for (const v of vendors) {
    const score = wordOverlapScore(vendorName, v.vendor_name);
    if (score > bestScore) { bestScore = score; best = v; }
  }
  if (best && bestScore >= 0.5) {
    console.log(`FreshBooks vendor fuzzy match: "${vendorName}" → "${best.vendor_name}" (score ${bestScore.toFixed(2)})`);
    return best.vendorid;
  }

  console.log(`Creating new FreshBooks vendor: "${vendorName}"`);
  const created = await fb(account_id, access_token, 'bill_vendors/bill_vendors', 'POST', { bill_vendor: { vendor_name: vendorName, currency_code: currency || BASE_CURRENCY, language: 'en' } });
  return created?.response?.result?.bill_vendor?.vendorid;
}

// ── FreshBooks staff (Expense.staffid is a required field) ─────────────────
// The Staff resource is FreshBooks' older, accounting-API-namespaced endpoint —
// the newer Team Members resource uses uuids that don't match the numeric
// staffid Expense/Bill objects actually require, so this one is intentional.

async function fetchDefaultStaffId(account_id, access_token) {
  try {
    const res = await fb(account_id, access_token, 'users/staffs', 'GET');
    const staff = res?.response?.result?.staff || res?.response?.result?.staffs || [];
    console.log('FreshBooks staff:', JSON.stringify(staff.map(s => ({ id: s.id, active: s.active }))));
    const active = staff.find(s => s.active !== false) || staff[0];
    return active?.id || null;
  } catch (e) {
    console.warn('Could not fetch FreshBooks staff:', e.message);
    return null;
  }
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
