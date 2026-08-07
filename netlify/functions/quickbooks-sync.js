const https = require('https');

const SB_URL   = 'psockxoyycvctjzigneh.supabase.co';
const TOKEN_HOST = 'oauth.platform.intuit.com';
const QB_HOST  = process.env.QUICKBOOKS_ENVIRONMENT === 'production'
  ? 'quickbooks.api.intuit.com'
  : 'sandbox-quickbooks.api.intuit.com';

const FALLBACK_ACCOUNT_NAME = 'Uncategorized Expense';
const BASE_CURRENCY         = 'CAD';

// Only send CurrencyRef when the invoice is in a foreign currency — omitting it for the
// base currency avoids QB rejecting the transaction on companies without multicurrency
// enabled (the common case), matching how Xero passes CurrencyCode through.
function qbCurrencyField(inv) {
  return inv.currency && inv.currency !== BASE_CURRENCY ? { CurrencyRef: { value: inv.currency } } : {};
}

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
      if (r.error || !r.access_token) {
        await markDisconnected(business_id);
        return json(401, { error: 'QuickBooks token expired — please reconnect', disconnected: true });
      }
      access_token   = r.access_token;
      refresh_token  = r.refresh_token;
      await saveTokens(business_id, access_token, refresh_token,
        new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString());
    }

    // 2. Fetch invoices — single invoice without synced filter so we can detect already-synced
    const invoices = invoice_id
      ? await sb(`invoices?id=eq.${enc(invoice_id)}&select=id,supplier,date,due_date,amount,subtotal,taxes,invoice_number,payment_method,synced_to_quickbooks,qb_payment_status,qb_account_name,line_items,currency`)
      : await sb(`invoices?business_name=eq.${enc(business_name)}&user_email=eq.${enc(user_email)}&synced_to_quickbooks=eq.false&select=id,supplier,date,due_date,amount,subtotal,taxes,invoice_number,payment_method,qb_payment_status,qb_account_name,line_items,currency`);

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
        const vendorId = await findOrCreateVendor(realm_id, access_token, inv.supplier);
        const accounts = await fetchExpenseAccounts(realm_id, access_token);
        const accountId = matchExpenseAccount(accounts, inv.qb_account_name);

        // Backup duplicate check: search QB for an existing transaction with the same
        // DocNumber for this vendor (same approach as Xero's Reference-based check)
        if (inv.invoice_number) {
          const docType  = isPaid ? 'Purchase' : 'Bill';
          const existing = await findExistingTransaction(realm_id, access_token, docType, vendorId, inv.invoice_number);
          if (existing) {
            console.log(`Found existing QB ${docType} for DocNumber ${inv.invoice_number}: ${existing.Id}`);
            await sb(`invoices?id=eq.${inv.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ synced_to_quickbooks: true, synced_at: new Date().toISOString(), qb_payment_status: paymentStatus }),
              headers: { 'Prefer': 'return=minimal' },
            });
            try {
              await sb(`invoices?id=eq.${inv.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ qb_object_type: isPaid ? 'expense' : 'bill' }),
                headers: { 'Prefer': 'return=minimal' },
              });
            } catch (e) {
              console.warn(`Could not store qb_object_type for ${inv.id} (column may not exist yet):`, e.message);
            }
            synced++;
            continue;
          }
        }

        let qbResult, qbTransactionId = null;
        if (isPaid) {
          // Paid → Expense (Purchase object)
          const paymentAccountId = await findPaymentAccount(realm_id, access_token);
          qbResult = await pushExpense(realm_id, access_token, inv, vendorId, accountId, paymentAccountId, accounts);
          qbTransactionId = qbResult?.Purchase?.Id || null;
        } else {
          // Awaiting Payment → Bill
          qbResult = await pushBill(realm_id, access_token, inv, vendorId, accountId, accounts);
          qbTransactionId = qbResult?.Bill?.Id || null;
        }

        // Mark synced — also persist the checked-lines-only amount onto the invoice
        // itself so the dashboard, exports, and this invoice's own row match what
        // actually got pushed to QuickBooks, instead of forever showing the full
        // original scanned amount even after an excluded line shrank what synced.
        const { subtotal: effSubtotal, taxes: effTaxes, taxTotal: effTaxTotal } = computeEffectiveAmounts(inv);
        const effAmount = Math.round((effSubtotal + effTaxTotal) * 100) / 100;
        await sb(`invoices?id=eq.${inv.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ synced_to_quickbooks: true, synced_at: new Date().toISOString(), qb_payment_status: paymentStatus, amount: effAmount, subtotal: effSubtotal, taxes: effTaxes }),
          headers: { 'Prefer': 'return=minimal' },
        });

        // Best-effort — lets quickbooks-status-refresh look this transaction up later.
        // Kept separate from the PATCH above so a missing qb_transaction_id column
        // (if the migration hasn't been applied yet) can't mark a successful sync failed.
        if (qbTransactionId) {
          try {
            await sb(`invoices?id=eq.${inv.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ qb_transaction_id: qbTransactionId }),
              headers: { 'Prefer': 'return=minimal' },
            });
          } catch (e) {
            console.warn(`Could not store qb_transaction_id for ${inv.id} (column may not exist yet):`, e.message);
          }
        }

        // Best-effort, frozen at sync time on purpose — a Bill that later gets
        // paid in QuickBooks stays a Bill, it doesn't retroactively become a
        // Purchase/Expense, so this must not be re-derived from qb_payment_status
        // once quickbooks-status-refresh starts changing that value over time.
        try {
          await sb(`invoices?id=eq.${inv.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ qb_object_type: isPaid ? 'expense' : 'bill' }),
            headers: { 'Prefer': 'return=minimal' },
          });
        } catch (e) {
          console.warn(`Could not store qb_object_type for ${inv.id} (column may not exist yet):`, e.message);
        }

        synced++;
        console.log(`Synced ${inv.id} — ${inv.supplier} $${inv.amount} (${paymentStatus})`);
      } catch (err) {
        if (err.qbUnauthorized) {
          await markDisconnected(business_id);
          return json(401, { error: 'QuickBooks connection lost — please reconnect', disconnected: true });
        }
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

// Distributes tax proportionally across real line items (by relative Amount share)
// instead of adding a synthetic "Tax" line — the last line absorbs any rounding
// remainder so the sum always matches taxTotal exactly.
function distributeTaxIntoLines(itemLines, taxTotal) {
  if (!taxTotal || !itemLines.length) return itemLines;
  const subtotal = itemLines.reduce((s, l) => s + l.Amount, 0);
  if (subtotal <= 0) return itemLines;
  let allocated = 0;
  return itemLines.map((l, i) => {
    const isLast = i === itemLines.length - 1;
    const share  = isLast
      ? Math.round((taxTotal - allocated) * 100) / 100
      : Math.round((l.Amount / subtotal) * taxTotal * 100) / 100;
    allocated += share;
    return { ...l, Amount: Math.round((l.Amount + share) * 100) / 100 };
  });
}

// Applies tax using QB's native TxnTaxDetail so it shows properly in the TAX
// column, matching each of our tax labels (GST/HST, PST/QST, etc.) to a real
// TaxRate configured in the connected company. If the company has no
// matching rate for one or more of the invoice's tax lines — common in test
// sandboxes provisioned with US-locale demo data, or any company that
// genuinely hasn't set up that tax — a TaxRateRef pointing at a rate that
// doesn't exist gets the whole transaction rejected by QuickBooks. Rather
// than guess (a wrong rate is worse than none), fall back to folding the tax
// proportionally into each line's Amount instead: same correct end total,
// just not broken out in the TAX column. Shared by pushExpense and pushBill.
async function applyQBTax(realm_id, access_token, itemLines, taxes, taxTotal, subtotal) {
  if (!taxes.length) return { lines: itemLines, taxFields: {} };

  const taxRates = await fetchTaxRates(realm_id, access_token);
  // raw_label (the tax line's verbatim printed text, e.g. "California Sales
  // Tax") matches a real QB tax rate far better than the normalized display
  // label (e.g. "Sales Tax") ever could — falls back to label for invoices
  // scanned before raw_label existed.
  const matches  = taxes.map(t => matchTaxRate(taxRates, t.raw_label || t.label));

  if (matches.some(m => !m)) {
    return { lines: distributeTaxIntoLines(itemLines, taxTotal), taxFields: {} };
  }

  const taxLines = taxes.map((t, i) => ({
    Amount: Number(t.amount),
    DetailType: 'TaxLineDetail',
    TaxLineDetail: {
      TaxRateRef: { value: matches[i].Id },
      NetAmountTaxable: subtotal,
    },
  }));
  return {
    lines: itemLines,
    taxFields: { txnTax: { GlobalTaxCalculation: 'TaxExcluded', TxnTaxDetail: { TotalTax: taxTotal, TaxLine: taxLines } } },
  };
}

// Excluded line items must shrink tax proportionally, not just drop out of the
// subtotal — inv.taxes was computed against inv.subtotal (never against a fresh
// sum of the current line items), so that's the only correct ratio denominator.
// This matters because a completed sync persists the checked-only subtotal/taxes
// back onto the invoice below — using a freshly-recomputed "sum of all line
// items" here instead of inv.subtotal would scale those already-reduced numbers
// a second time on every later sync/re-sync of the same invoice.
function computeEffectiveAmounts(inv) {
  const storedSubtotal = Number(inv.subtotal) || Number(inv.amount) || 0;
  const allTaxes = Array.isArray(inv.taxes) ? inv.taxes.filter(t => Number(t.amount) > 0) : [];
  const lineItems = Array.isArray(inv.line_items) ? inv.line_items.filter(li => li.description) : [];

  if (!lineItems.length) {
    return { subtotal: storedSubtotal, taxes: allTaxes, taxTotal: allTaxes.reduce((s, t) => s + Number(t.amount), 0) };
  }

  const checkedSum = lineItems.reduce((s, li) => s + (li.excluded ? 0 : Number(li.total) || 0), 0);
  const ratio       = storedSubtotal > 0 ? checkedSum / storedSubtotal : 1;

  const scaledTaxes = allTaxes.map(t => ({ label: t.label, raw_label: t.raw_label, amount: Math.round(Number(t.amount) * ratio * 100) / 100 }));
  return { subtotal: checkedSum, taxes: scaledTaxes, taxTotal: scaledTaxes.reduce((s, t) => s + t.amount, 0) };
}

async function pushExpense(realm_id, access_token, inv, vendorId, expenseAccountId, paymentAccountId, accounts) {
  const { subtotal, taxes, taxTotal } = computeEffectiveAmounts(inv);
  const total    = Math.round((subtotal + taxTotal) * 100) / 100;
  const memo     = taxes.length
    ? `Tax breakdown: ${taxes.map(t => `${t.label || 'Tax'}: $${Number(t.amount).toFixed(2)}`).join(', ')} | Subtotal: $${subtotal.toFixed(2)} | Total: $${total.toFixed(2)}`
    : null;

  // One QB Line per invoice line item, each tagged with its own account — falls
  // back to a single lump-sum line for invoices with no usable line items.
  const itemLines = buildItemLines(inv, accounts, expenseAccountId)
    || [{ Amount: subtotal, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAccountId } } }];

  const { lines, taxFields } = await applyQBTax(realm_id, access_token, itemLines, taxes, taxTotal, subtotal);

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
    ...qbCurrencyField(inv),
    Line: lines,
    ...(memo ? { PrivateNote: memo } : {}),
    ...(taxFields.txnTax || {}),
  };

  console.log('QB Expense:', JSON.stringify(body));
  return qb(realm_id, access_token, 'purchase?minorversion=65', 'POST', body);
}

// ── Push invoice to QB as a Bill (Awaiting Payment) ──────────────────────────

async function pushBill(realm_id, access_token, inv, vendorId, expenseAccountId, accounts) {
  const { subtotal, taxes, taxTotal } = computeEffectiveAmounts(inv);
  const total    = Math.round((subtotal + taxTotal) * 100) / 100;
  const txnDate  = inv.date || new Date().toISOString().split('T')[0];
  const dueDate  = inv.due_date || txnDate;
  const memo     = taxes.length
    ? `Tax: ${taxes.map(t => `${t.label || 'Tax'}: $${Number(t.amount).toFixed(2)}`).join(', ')} | Subtotal: $${subtotal.toFixed(2)} | Total: $${total.toFixed(2)}`
    : null;

  // One QB Line per invoice line item, each tagged with its own account — falls
  // back to a single lump-sum line for invoices with no usable line items.
  const itemLines = buildItemLines(inv, accounts, expenseAccountId)
    || [{ Amount: subtotal, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: expenseAccountId } } }];

  const { lines, taxFields } = await applyQBTax(realm_id, access_token, itemLines, taxes, taxTotal, subtotal);

  const body = {
    VendorRef: { value: vendorId },
    TxnDate:   txnDate,
    DueDate:   dueDate,
    ...(inv.invoice_number ? { DocNumber: inv.invoice_number } : {}),
    ...qbCurrencyField(inv),
    Line: lines,
    ...(memo ? { PrivateNote: memo } : {}),
    ...(taxFields.txnTax || {}),
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
  // Generic fallback beyond the Canadian-specific terms above — a direct
  // name match either direction (e.g. an invoice tax label of "California
  // Sales Tax" against a configured rate named "California") covers any
  // other jurisdiction's tax setup without hardcoding it, since which
  // country's rates exist depends entirely on the connected QB company.
  if (l) {
    for (const r of rates) {
      const n = (r.Name || '').toUpperCase();
      if (n && (l.includes(n) || n.includes(l))) return r;
    }
  }
  // No genuine match — critically, do NOT default to rates[0]. An unrelated
  // rate (e.g. a US sandbox's "AZ State tax" applied to a Canadian GST line)
  // is actively wrong, not just imprecise, and applyQBTax's caller relies on
  // null here to trigger its safe fallback instead of tagging the invoice
  // with the wrong tax.
  return null;
}


// ── QB helpers ───────────────────────────────────────────────────────────────

// Suffixes that don't identify a vendor — stripped before comparison (same approach as Xero contact matching)
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

async function findOrCreateVendor(realm_id, access_token, name) {
  const vendorName = (name || '').trim() || 'Unknown Vendor';
  const safe = vendorName.replace(/'/g, "''");

  // 1. Exact match first (fast path)
  const exact = await qb(realm_id, access_token,
    `query?query=${enc(`SELECT * FROM Vendor WHERE DisplayName = '${safe}'`)}&minorversion=65`);
  const exactMatch = exact.QueryResponse?.Vendor?.[0];
  if (exactMatch) return exactMatch.Id;

  // 2. Fuzzy — search by first significant word, then score candidates by word overlap
  const coreWords = normalizeVendor(vendorName).split(' ').filter(Boolean);
  if (coreWords.length) {
    const searchWord = coreWords[0].replace(/'/g, "''");
    try {
      const searchRes = await qb(realm_id, access_token,
        `query?query=${enc(`SELECT * FROM Vendor WHERE DisplayName LIKE '%${searchWord}%' MAXRESULTS 20`)}&minorversion=65`);
      const candidates = searchRes.QueryResponse?.Vendor || [];
      let best = null, bestScore = 0;
      for (const c of candidates) {
        const score = wordOverlapScore(vendorName, c.DisplayName);
        console.log(`  QB vendor candidate: "${c.DisplayName}" → score ${score.toFixed(2)}`);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (best && bestScore >= 0.5) {
        console.log(`QB vendor fuzzy match: "${vendorName}" → "${best.DisplayName}" (score ${bestScore.toFixed(2)})`);
        return best.Id;
      }
    } catch (e) {
      console.warn('QB fuzzy vendor search failed, will create new:', e.message);
    }
  }

  // 3. No match — create new vendor
  console.log(`Creating new QB vendor: "${vendorName}"`);
  const created = await qb(realm_id, access_token, 'vendor?minorversion=65', 'POST', { DisplayName: vendorName });
  return created.Vendor?.Id;
}

async function findExistingTransaction(realm_id, access_token, docType, vendorId, docNumber) {
  try {
    const safe = docNumber.replace(/'/g, "''");
    const res  = await qb(realm_id, access_token,
      `query?query=${enc(`SELECT * FROM ${docType} WHERE DocNumber = '${safe}' MAXRESULTS 5`)}&minorversion=65`);
    const rows = res.QueryResponse?.[docType] || [];
    return rows.find(r => (r.EntityRef?.value || r.VendorRef?.value) === vendorId) || null;
  } catch (e) {
    console.warn(`findExistingTransaction (${docType}) failed for DocNumber ${docNumber}:`, e.message);
    return null;
  }
}

async function fetchExpenseAccounts(realm_id, access_token) {
  const res = await qb(realm_id, access_token,
    `query?query=${enc('SELECT * FROM Account WHERE AccountType = \'Expense\' MAXRESULTS 200')}&minorversion=65`);
  return (res.QueryResponse?.Account || []).filter(a => a.Active !== false);
}

function matchExpenseAccount(accounts, qb_account_name) {
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

// ── Build one QB Line per invoice line item, each tagged with its own account ──
// Returns null when there are no usable line items, so callers can fall back to
// a single lump-sum line (manual invoices, or ones scanned before this existed).
const SUMMARY_ROW = /^(sous-?total|sub-?total|total|tps|tvq|tva|gst|hst|pst|tax|taxes|tip|gratuity|discount|change|balance)$/i;

function buildItemLines(inv, accounts, fallbackAccountId) {
  const scanned = Array.isArray(inv.line_items) ? inv.line_items : [];
  const items = scanned.filter(li => {
    if (li.excluded) return false;
    const desc = (li.description || '').trim();
    return desc && !SUMMARY_ROW.test(desc);
  });
  if (!items.length) return null;

  return items.map(li => {
    const qty   = Number(li.quantity) || 1;
    const total = (li.total != null && !isNaN(Number(li.total))) ? Number(li.total) : (Number(li.unit_price) || 0) * qty;
    const accountId = li.qb_account_name ? matchExpenseAccount(accounts, li.qb_account_name) : fallbackAccountId;
    return {
      Amount:      Math.round(total * 100) / 100,
      Description: li.description,
      DetailType:  'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
    };
  });
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

async function markDisconnected(business_id) {
  console.warn(`Marking QuickBooks connection as needs_reconnect for business ${business_id}`);
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
