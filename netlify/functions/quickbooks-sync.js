const https = require('https');

const SB_URL = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST = 'oauth.platform.intuit.com';
const QB_HOST = process.env.QUICKBOOKS_ENVIRONMENT === 'production'
  ? 'quickbooks.api.intuit.com'
  : 'sandbox-quickbooks.api.intuit.com';

const CATEGORY_ACCOUNT = {
  'Meals & Entertainment':  'Meals and Entertainment',
  'Professional Services':  'Professional Fees',
  'Office Supplies':        'Office Supplies',
  'Travel':                 'Travel',
  'Equipment':              'Equipment',
  'Utilities':              'Utilities',
  'Groceries':              'Groceries',
  'Other':                  'Other Business Expenses',
};
const FALLBACK_ACCOUNT = 'Other Business Expenses';

exports.handler = async (event) => {
  const { business_id, business_name, user_email } = event.queryStringParameters || {};
  if (!business_id) return json(400, { error: 'Missing business_id' });
  if (!business_name || !user_email) return json(400, { error: 'Missing business_name or user_email' });

  try {
    const conn = await getConnection(business_id);
    if (!conn) return json(404, { error: 'QuickBooks not connected' });

    let { access_token, refresh_token, realm_id, expires_at, sync_mode } = conn;
    sync_mode = sync_mode || 'status_based';
    if (new Date(expires_at) <= new Date(Date.now() + 5 * 60 * 1000)) {
      const r = await refreshAccessToken(refresh_token);
      access_token = r.access_token;
      refresh_token = r.refresh_token;
      await updateTokens(business_id, access_token, refresh_token,
        new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString());
    }

    const { invoice_id } = event.queryStringParameters || {};
    const invoices = invoice_id
      ? await sbRequest(`invoices?id=eq.${encodeURIComponent(invoice_id)}&synced_to_quickbooks=eq.false&select=id,supplier,date,amount,subtotal,category,taxes,paid`)
      : await getUnsyncedInvoices(business_name, user_email);
    if (!Array.isArray(invoices) || !invoices.length) return json(200, { synced: 0, message: 'Nothing to sync' });

    // Fetch expense accounts
    const expAccounts = await qbQuery(realm_id, access_token, "SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 100");
    const accountMap = {};
    (expAccounts.QueryResponse?.Account || []).forEach(a => { accountMap[a.Name] = a.Id; });
    console.log('Expense accounts found:', Object.keys(accountMap));

    // Fetch a bank/cash account to use as the payment AccountRef (required by QB)
    const bankAccounts = await qbQuery(realm_id, access_token, "SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 5");
    const bankAccount = (bankAccounts.QueryResponse?.Account || [])[0];
    if (!bankAccount) throw new Error('No bank account found in QuickBooks — add a checking account first');
    console.log('Using payment account:', bankAccount.Name, bankAccount.Id);

    let synced = 0, failed = 0, errors = [];
    for (const inv of invoices) {
      try {
        const vendorId = await findOrCreateVendor(realm_id, access_token, inv.supplier || 'Unknown Vendor');
        const accountId = findAccount(accountMap, inv.category);
        console.log(`Syncing invoice ${inv.id} — sync_mode: ${sync_mode}, paid: ${inv.paid}, vendor: ${inv.supplier}, amount: ${inv.amount}`);
        let result;
        const useExpense = sync_mode === 'expenses' || inv.paid;
        if (useExpense) {
          result = await createExpense(realm_id, access_token, inv, vendorId, accountId, bankAccount.Id);
          console.log(`QB Expense created for invoice ${inv.id}:`, JSON.stringify(result?.Purchase || result));
        } else {
          result = await createBill(realm_id, access_token, inv, vendorId, accountId);
          console.log(`QB Bill created for invoice ${inv.id}:`, JSON.stringify(result?.Bill || result));
        }
        await markSynced(inv.id);
        synced++;
      } catch (err) {
        failed++;
        errors.push({ id: inv.id, supplier: inv.supplier, error: err.message });
        console.error(`Invoice ${inv.id} sync failed:`, err.message);
      }
    }

    return json(200, { synced, failed, errors });
  } catch (err) {
    console.error('Sync error:', err.message);
    return json(500, { error: err.message });
  }
};

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function sbKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
}

function sbRequest(path, opts = {}) {
  const key = sbKey();
  const method = opts.method || 'GET';
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

function qbRequest(realm_id, access_token, path, opts = {}) {
  const method = opts.method || 'GET';
  const payload = opts.body ? JSON.stringify(opts.body) : null;
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

function qbQuery(realm_id, access_token, query) {
  return qbRequest(realm_id, access_token, `query?query=${encodeURIComponent(query)}&minorversion=65`);
}

async function getConnection(business_id) {
  const data = await sbRequest(`quickbooks_connections?business_id=eq.${encodeURIComponent(business_id)}&select=access_token,refresh_token,realm_id,expires_at,sync_mode`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function refreshAccessToken(refresh_token) {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: TOKEN_HOST,
      path: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(`Token refresh parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function updateTokens(business_id, access_token, refresh_token, expires_at) {
  await sbRequest(`quickbooks_connections?business_id=eq.${encodeURIComponent(business_id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ access_token, refresh_token, expires_at }),
  });
}

async function getUnsyncedInvoices(business_name, user_email) {
  return sbRequest(
    `invoices?business_name=eq.${encodeURIComponent(business_name)}&user_email=eq.${encodeURIComponent(user_email)}&synced_to_quickbooks=eq.false&select=id,supplier,date,amount,subtotal,category,taxes,paid`
  );
}

async function findOrCreateVendor(realm_id, access_token, name) {
  const safe = name.replace(/'/g, "\\'");
  const res = await qbQuery(realm_id, access_token, `SELECT * FROM Vendor WHERE DisplayName = '${safe}'`);
  const vendors = res.QueryResponse?.Vendor || [];
  if (vendors.length) return vendors[0].Id;

  const created = await qbRequest(realm_id, access_token, 'vendor?minorversion=65', {
    method: 'POST',
    body: { DisplayName: name },
  });
  return created.Vendor?.Id;
}

function findAccount(accountMap, category) {
  const target = CATEGORY_ACCOUNT[category] || FALLBACK_ACCOUNT;
  if (accountMap[target]) return accountMap[target];
  if (accountMap[FALLBACK_ACCOUNT]) return accountMap[FALLBACK_ACCOUNT];
  return Object.values(accountMap)[0] || '1';
}

async function createExpense(realm_id, access_token, inv, vendorId, accountId, bankAccountId) {
  const subtotal = Number(inv.subtotal) || Number(inv.amount) || 0;
  const taxes = Array.isArray(inv.taxes) ? inv.taxes : [];
  const totalTax = taxes.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const total = Number(inv.amount) || subtotal + totalTax;

  const lines = [
    {
      Amount: subtotal,
      DetailType: 'AccountBasedExpenseLineDetail',
      Description: inv.category || 'Business Expense',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: accountId },
      },
    },
  ];

  taxes.forEach(t => {
    if (Number(t.amount) > 0) {
      lines.push({
        Amount: Number(t.amount),
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: t.label || 'Tax',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: accountId },
        },
      });
    }
  });

  const body = {
    PaymentType: 'Cash',
    AccountRef: { value: bankAccountId },
    TotalAmt: total,
    TxnDate: inv.date || new Date().toISOString().split('T')[0],
    EntityRef: { type: 'Vendor', value: vendorId },
    Line: lines,
  };
  console.log('QB Purchase payload:', JSON.stringify(body));

  return qbRequest(realm_id, access_token, 'purchase?minorversion=65', { method: 'POST', body });
}

async function createBill(realm_id, access_token, inv, vendorId, accountId) {
  const subtotal = Number(inv.subtotal) || Number(inv.amount) || 0;
  const taxes = Array.isArray(inv.taxes) ? inv.taxes : [];
  const totalTax = taxes.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const total = Number(inv.amount) || subtotal + totalTax;

  const lines = [
    {
      Amount: subtotal,
      DetailType: 'AccountBasedExpenseLineDetail',
      Description: inv.category || 'Business Expense',
      AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
    },
  ];

  taxes.forEach(t => {
    if (Number(t.amount) > 0) {
      lines.push({
        Amount: Number(t.amount),
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: t.label || 'Tax',
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
      });
    }
  });

  const body = {
    VendorRef: { value: vendorId },
    TxnDate: inv.date || new Date().toISOString().split('T')[0],
    TotalAmt: total,
    Line: lines,
  };
  console.log('QB Bill payload:', JSON.stringify(body));

  return qbRequest(realm_id, access_token, 'bill?minorversion=65', { method: 'POST', body });
}

async function markSynced(id) {
  await sbRequest(`invoices?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ synced_to_quickbooks: true, synced_at: new Date().toISOString() }),
  });
}
