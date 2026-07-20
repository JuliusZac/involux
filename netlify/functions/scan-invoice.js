const https = require('https');
const http = require('http');
const pdfParse = require('pdf-parse');

const ALLOWED_ORIGIN = 'https://involux.ca';

const SCAN_PROMPT = `You are an expert accountant who reads invoices and receipts of all types — thermal store receipts, restaurant bills, professional service invoices, supplier invoices, and online order confirmations.

Your job is to extract every piece of structured data from this document. Return ONLY a raw JSON object with no markdown, no backticks, no explanation.

{
  "vendor_name": "full business or store name exactly as printed — include every word, do not truncate — check header, logo, letterhead, or top of document",
  "date": "invoice or purchase date in YYYY-MM-DD format — look for Invoice Date, Order Date, Date of Service, Transaction Date — null if not found",
  "due_date": "payment due date in YYYY-MM-DD format — look for Due Date, Payment Due, Pay By — null if not found",
  "subtotal": numeric amount before tax as a plain number — null if not shown,
  "taxes": [{"label": "GST/HST", "amount": 22.20}, {"label": "PST", "amount": 31.08}] — one entry per tax line, label exactly as printed, amount as a dollar number — null if no tax on document,
  "total": final amount as a plain number — look for TOTAL, GRAND TOTAL, AMOUNT DUE, BALANCE DUE, PLEASE PAY — never null,
  "receipt_number": "invoice number, receipt number, order number, reference number — null if not found",
  "payment_method": "cash, credit, debit, visa, mastercard, amex, cheque, e-transfer, etc — null if not shown",
  "category": "single best category: Meals & Entertainment, Office Supplies, Travel, Utilities, Equipment, Software, Marketing, Professional Services, Shipping, Groceries, Fuel, Healthcare, Repairs & Maintenance, Other",
  "currency": "3-letter ISO currency code — look for $, USD, CAD, EUR, GBP, CHF, AUD, MXN, or any currency symbol/code on the document — default to CAD if none found",
  "xero_account_code": null,
  "xero_account_name": null,
  "qb_account_name": null,
  "line_items": [
    {"description": "exact item or service name", "quantity": 1, "unit_price": 9.99, "total": 9.99}
  ]
}

TAX RULES — follow exactly:

1. Scan the ENTIRE document for every tax line before writing anything
2. Add each tax line as a separate entry in the taxes array — never combine two lines into one
3. Normalize every label to a standard name using these rules (check if the label CONTAINS any of these words):
   - Contains GST or TPS → use label "GST/HST"
   - Contains HST or TVH → use label "GST/HST"
   - Contains PST or QST or TVQ or TVP → use label "PST/QST"
   - Contains VAT or TVA or IVA → use label "VAT"
   - Contains "Sales Tax" → use label "Sales Tax"
   - Anything else → use label "Tax"
4. NEVER store percentages — always store dollar amounts:
   - If only a percentage is shown: dollar = subtotal × (rate / 100)
   - Example: subtotal $399.00, "Tax 5%" → taxes: [{"label":"Tax","amount":19.95}]
   - Example: subtotal $200.00, "GST 5%" → taxes: [{"label":"GST/HST","amount":10.00}]
5. If a tax line shows $0.00 omit it from the array entirely
6. If no tax appears on the document set taxes to null

LINE ITEMS RULES — read these carefully:
- Extract EVERY line that has a dollar amount next to it, including:
  - Individual products or services with a price
  - Sub-items or nested items (e.g. "Tax return - Couple" under a "Fee for Services" header)
  - Items described across two rows where the name is on one line and the price on the next
  - Hourly rate charges (e.g. "2 hrs × $150.00")
  - Administration fees, handling fees, surcharges
  - Discount lines (use a negative total)
  - Subtotal rows within a section if they have a label and amount
- For each line item: description is required; quantity and unit_price are optional (set null if not shown); total is required if a dollar amount is visible
- Do NOT collapse multiple line items into one — keep every line separate exactly as it appears on the document
- Do NOT skip a line just because it is indented, small, or appears to be a sub-item
- If line items are not readable at all, return null for line_items

GENERAL RULES:
- All numbers must be plain numerics — no $ signs, no commas
- Never guess a value you cannot see — use null
- vendor_name must be the complete full name, never truncated
- total must never be null
- Return ONLY the JSON object, nothing else`;

const PAID_METHODS    = /visa|mastercard|amex|credit|debit|cash|e-?transfer|interac|tap|apple\s*pay|google\s*pay|prepaid/i;
const PENDING_METHODS = /invoice|net\s*\d|terms|cheque\s*pending|balance\s*due|please\s*(send|remit|pay)/i;

const MAX_SCAN_ATTEMPTS = 3;
const RETRY_DELAY_MS    = 1500;
const GOOD_ENOUGH_SCORE = 8;

function scoreResult(r) {
  if (!r || r.supplier === 'Unknown') return 0;
  let s = 0;
  if (r.supplier && r.supplier !== 'Unknown') s += 3;
  if (r.amount  && r.amount  > 0)            s += 3;
  if (r.date)                                s += 2;
  if (r.subtotal != null)                    s += 1;
  if (r.invoice_number)                      s += 1;
  if (r.payment_method)                      s += 1;
  if (Array.isArray(r.taxes)      && r.taxes.length)      s += 1;
  if (Array.isArray(r.line_items) && r.line_items.length) s += 2;
  return s;
}

async function retryingScan(scanFn) {
  let best = null, bestScore = -1;
  for (let attempt = 1; attempt <= MAX_SCAN_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS);
    try {
      const result = await scanFn(attempt);
      const score  = scoreResult(result);
      console.log(`[scan] attempt=${attempt} score=${score} supplier="${result?.supplier}" amount=${result?.amount}`);
      if (score > bestScore) { best = result; bestScore = score; }
      if (score >= GOOD_ENOUGH_SCORE) {
        console.log(`[scan] good result on attempt ${attempt} — stopping early`);
        break;
      }
    } catch (e) {
      console.error(`[scan] attempt ${attempt} threw:`, e.message);
    }
  }
  console.log(`[scan] final best score=${bestScore}`);
  return best || { supplier: 'Unknown', date: new Date().toISOString().split('T')[0], amount: 0, status: 'Review' };
}

function guessPaymentStatus(paymentMethod) {
  const m = (paymentMethod || '').toLowerCase();
  if (m && PAID_METHODS.test(m)) return 'PAID';
  if (m && PENDING_METHODS.test(m)) return 'AWAITING_PAYMENT';
  return 'PAID'; // receipts with no method are almost always already paid
}

const ACCOUNT_SELECTION_RULES = `
CRITICAL RULES — apply before selecting any account:

1. PURCHASE vs RENTAL — never confuse these:
   - A PURCHASE is a one-time transaction where ownership transfers to the buyer.
     Signs: unit price × quantity for physical goods, invoice terms like Net 30,
     no mention of a rental period, return date, or recurring usage fee.
   - A RENTAL/LEASE is a time-based usage fee with no ownership transfer.
     Signs: explicit rental period (daily/weekly/monthly rate), return date,
     words like "rental agreement", "lease term", or "per day/week/month".
   - ONLY select an account with "Rental" or "Lease" in its name if the document
     EXPLICITLY shows rental terms. The word "equipment" appearing in a line item
     description of a purchase invoice does NOT make it a rental.

2. FEW-SHOT EXAMPLES:
   - Invoice from TechNest Solutions: "MacBook Pro 14" × 1 — $2,499.00, Net 30"
     → NOT Equipment Rental (no rental period, ownership transfers, it's a purchase)
     → CORRECT: Computer Equipment, Office Equipment, or a general expense account
   - Invoice from ACME Rentals: "Excavator rental — 3 days @ $450/day — return by Aug 5"
     → CORRECT: Equipment Rental (explicit rental period and daily rate)
   - Invoice for "Microsoft 365 Business — monthly subscription"
     → CORRECT: Subscriptions or Software (recurring fee, not physical rental)`;

function buildPrompt(xeroAccounts, qbAccounts) {
  let prompt = SCAN_PROMPT;
  if (xeroAccounts && xeroAccounts.length) {
    const accountList = xeroAccounts.map(a => `${a.code} — ${a.name}`).join('\n');
    prompt += `

XERO ACCOUNT SELECTION — required when this section is present:
Select the single best-matching expense account for this document from the list below.
Return two additional fields in your JSON:
  "xero_account_code": "the exact 3-digit code from the list below",
  "xero_account_name": "the account name exactly as listed below"
Default to 429 — General Expenses if nothing else fits.
${ACCOUNT_SELECTION_RULES}

Available Xero expense accounts:
${accountList}`;
  }
  if (qbAccounts && qbAccounts.length) {
    const accountList = qbAccounts.map(a => a.name).join('\n');
    prompt += `

QUICKBOOKS ACCOUNT SELECTION — required when this section is present:
Select the single best-matching expense account for this invoice from the list below.
Return one additional field in your JSON:
  "qb_account_name": "the account name exactly as listed below"
Default to "Uncategorized Expense" if nothing else fits.
${ACCOUNT_SELECTION_RULES}

Available QuickBooks expense accounts:
${accountList}`;
  }
  return prompt;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const origin = event.headers['origin'] || event.headers['referer'] || '';
  if (!origin.startsWith(ALLOWED_ORIGIN)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { fileUrl, invoiceId, business_id } = body;

  if (!fileUrl || !invoiceId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fileUrl or invoiceId' }) };
  }

  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('https://psockxoyycvctjzigneh.supabase.co/storage/')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid file URL' }) };
  }

  if (typeof invoiceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(invoiceId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid invoice ID' }) };
  }

  try {
    const invoice = await verifyInvoiceOwnership(invoiceId, fileUrl);
    if (!invoice) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Invoice not found or file mismatch' }) };
    }

    // Fetch chart of accounts for connected accounting software
    const [xeroAccounts, qbAccounts] = await Promise.all([
      business_id ? fetchXeroAccounts(business_id) : Promise.resolve([]),
      business_id ? fetchQBAccounts(business_id) : Promise.resolve([]),
    ]);

    // Download the file from Supabase
    const { buffer, mimeType } = await downloadFile(fileUrl);

    let extracted;
    if (mimeType === 'application/pdf' || fileUrl.toLowerCase().endsWith('.pdf')) {
      extracted = await scanPdf(buffer, xeroAccounts, qbAccounts);
    } else {
      extracted = await scanImage(buffer, mimeType, xeroAccounts, qbAccounts);
    }

    await updateSupabase(invoiceId, {
      supplier:          extracted.supplier,
      date:              extracted.date,
      amount:            extracted.amount,
      invoice_number:    extracted.invoice_number,
      due_date:          extracted.due_date,
      status:            extracted.status,
      subtotal:          extracted.subtotal,
      taxes:             extracted.taxes,
      payment_method:    extracted.payment_method,
      category:          extracted.category,
      line_items:        extracted.line_items,
      currency:            extracted.currency || 'CAD',
      xero_account_code:   extracted.xero_account_code || null,
      xero_account_name:   extracted.xero_account_name || null,
      xero_payment_status: extracted.xero_payment_status || null,
      qb_account_name:     extracted.qb_account_name || null,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: extracted }) };

  } catch (error) {
    console.error('Scan error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

// ── DOWNLOAD ──

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadFile(url, retries = 4, delayMs = 1500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    const result = await new Promise((resolve, reject) => {
      const chunks = [];
      const lib = url.startsWith('https') ? https : http;
      lib.get(url, (res) => {
        const mimeType = res.headers['content-type'] || 'application/octet-stream';
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), mimeType: mimeType.split(';')[0].trim() }));
        res.on('error', reject);
      }).on('error', reject);
    });
    if (result.status === 200) return result;
    console.log(`Download attempt ${attempt + 1} got status ${result.status} — retrying...`);
  }
  throw new Error(`File not available after ${retries + 1} attempts`);
}

// ── IMAGE SCAN — base64 ──

async function scanImage(buffer, mimeType, xeroAccounts = [], qbAccounts = []) {
  const base64 = buffer.toString('base64');
  const safeMime = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mimeType) ? mimeType : 'image/jpeg';
  const dataUrl = `data:${safeMime};base64,${base64}`;
  const basePrompt = buildPrompt(xeroAccounts, qbAccounts);

  const makeBody = (p) => JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [
      { type: 'text', text: p },
      { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
    ]}],
    max_tokens: 2000,
    response_format: { type: 'json_object' }
  });

  const retryNote = '\n\nIMPORTANT: A previous attempt returned incomplete data. Examine every corner of the image carefully — check headers, footers, watermarks, and small print. Extract every visible field. Do not return Unknown or null for fields that are clearly visible.';

  return retryingScan(async (attempt) => {
    const prompt = attempt === 1 ? basePrompt : basePrompt + retryNote;
    const raw = await callOpenAI(makeBody(prompt));
    return parseResult(raw);
  });
}

// ── PDF SCAN ──

async function scanPdf(buffer, xeroAccounts = [], qbAccounts = []) {
  const basePrompt = buildPrompt(xeroAccounts, qbAccounts);
  const retryNote  = '\n\nIMPORTANT: A previous attempt returned incomplete data. Re-read every line of the document carefully. Extract every visible field. Do not return Unknown or null for fields that are present.';

  // Try text extraction first
  let pdfText = null;
  try {
    const parsed = await pdfParse(buffer);
    const text = (parsed.text || '').trim();
    if (text.length >= 80) pdfText = text.substring(0, 6000);
  } catch (e) { console.log('pdf-parse failed:', e.message); }

  if (pdfText) {
    return retryingScan(async (attempt) => {
      const prompt = (attempt === 1 ? basePrompt : basePrompt + retryNote);
      const body = JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: `${prompt}\n\nDocument text:\n${pdfText}` }],
        max_tokens: 2000,
        response_format: { type: 'json_object' }
      });
      return parseResult(await callOpenAI(body));
    });
  }

  // Scanned PDF — upload to OpenAI files API (retries handled inside)
  return await scanScannedPdf(buffer, basePrompt, retryNote);
}

async function scanScannedPdf(buffer, basePrompt = SCAN_PROMPT, retryNote = '') {
  // Upload the file once, reuse fileId across retry attempts
  let fileId = null;
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), 'invoice.pdf');
    form.append('purpose', 'user_data');
    const uploadRes = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });
    const fileData = await uploadRes.json();
    fileId = fileData.id;
    if (!fileId) { console.error(`[scan] scanned PDF upload failed — status=${uploadRes.status} body=${JSON.stringify(fileData)}`); return parseResult('{}'); }
  } catch (e) {
    console.error('[scan] scanned PDF upload error:', e.message);
    return parseResult('{}');
  }

  try {
    return await retryingScan(async (attempt) => {
      const prompt = attempt === 1 ? basePrompt : basePrompt + retryNote;
      const respRes = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          input: [{ role: 'user', content: [{ type: 'input_file', file_id: fileId }, { type: 'input_text', text: prompt }] }],
          text: { format: { type: 'json_object' } }
        })
      });
      const result = await respRes.json();
      const raw = result.output?.[0]?.content?.[0]?.text;
      if (!raw) console.error(`[scan] responses API returned no output — status=${respRes.status} body=${JSON.stringify(result)}`);
      return parseResult(raw || '{}');
    });
  } finally {
    try { await fetch(`https://api.openai.com/v1/files/${fileId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } }); } catch {}
  }
}

// ── OPENAI ──

function callOpenAI(body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          if (p.error) reject(new Error(p.error.message));
          else resolve(p.choices[0].message.content);
        } catch { reject(new Error('OpenAI parse error')); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function parseResult(content) {
  try {
    const clean = content.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);
    const today = new Date().toISOString().split('T')[0];
    const total = parseFloat(data.total) || 0;
    return {
      // Fields saved to Supabase invoices table
      supplier: data.vendor_name || 'Unknown',
      date: data.date || today,
      due_date: data.due_date || null,
      amount: total,
      invoice_number: data.receipt_number || null,
      status: 'Processed',
      subtotal: data.subtotal != null ? parseFloat(data.subtotal) : null,
      taxes: Array.isArray(data.taxes) && data.taxes.length ? data.taxes.map(t=>({label:t.label,amount:parseFloat(t.amount)})).filter(t=>t.label&&t.amount) : null,
      payment_method:    data.payment_method || null,
      category:          data.category || null,
      line_items:        data.line_items || null,
      currency:             /^[A-Z]{3}$/.test(data.currency) ? data.currency : 'CAD',
      xero_account_code:    data.xero_account_code ? String(data.xero_account_code) : null,
      xero_account_name:    data.xero_account_name || null,
      xero_payment_status:  guessPaymentStatus(data.payment_method),
      qb_account_name:      data.qb_account_name || null,
    };
  } catch {
    return { supplier: 'Unknown', date: new Date().toISOString().split('T')[0], amount: 0, invoice_number: null, status: 'Review' };
  }
}

// ── XERO ACCOUNTS ──

async function fetchXeroAccounts(business_id) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'psockxoyycvctjzigneh.supabase.co',
      path:     `/rest/v1/xero_connections?business_id=eq.${encodeURIComponent(business_id)}&select=chart_of_accounts`,
      method:   'GET',
      headers:  { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try {
          const rows = JSON.parse(d);
          const accounts = Array.isArray(rows) && rows[0]?.chart_of_accounts;
          resolve(Array.isArray(accounts) ? accounts : []);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// ── QB ACCOUNTS ──

const QB_EXPENSE_ACCOUNTS = [
  'Advertising', 'Automobile', 'Automobile:Fuel', 'Bank Charges', 'Commissions & Fees', 'Disposal Fees',
  'Dues & Subscriptions', 'Equipment Rental', 'Insurance', 'Insurance:Workers Compensation', 'Job Expenses',
  'Job Expenses:Cost of Labor', 'Job Expenses:Cost of Labor:Installation', 'Job Expenses:Cost of Labor:Maintenance and Repairs',
  'Job Expenses:Equipment Rental', 'Job Expenses:Job Materials', 'Job Expenses:Job Materials:Decks and Patios',
  'Job Expenses:Job Materials:Fountain and Garden Lighting', 'Job Expenses:Job Materials:Plants and Soil',
  'Job Expenses:Job Materials:Sprinklers and Drip Systems', 'Job Expenses:Permits', 'Legal & Professional Fees',
  'Legal & Professional Fees:Accounting', 'Legal & Professional Fees:Bookkeeper', 'Legal & Professional Fees:Lawyer',
  'Maintenance and Repair', 'Maintenance and Repair:Building Repairs', 'Maintenance and Repair:Computer Repairs',
  'Maintenance and Repair:Equipment Repairs', 'Meals and Entertainment', 'Office Expenses', 'Promotional', 'Purchases',
  'Rent or Lease', 'Stationery & Printing', 'Supplies', 'Taxes & Licenses', 'Travel', 'Travel Meals',
  'Unapplied Cash Bill Payment Expense', 'Uncategorized Expense', 'Utilities', 'Utilities:Gas and Electric',
  'Utilities:Telephone', 'Cost of Goods Sold',
];

function fetchQBAccounts() {
  return Promise.resolve(QB_EXPENSE_ACCOUNTS.map(name => ({ name })));
}

// ── SUPABASE ──

async function verifyInvoiceOwnership(invoiceId, fileUrl) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  // Retry up to 4 times — Supabase row may not be visible immediately after INSERT
  for (let i = 0; i < 4; i++) {
    if (i > 0) await sleep(1000);
    const result = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'psockxoyycvctjzigneh.supabase.co',
        path: `/rest/v1/invoices?id=eq.${invoiceId}&file_url=eq.${encodeURIComponent(fileUrl)}&select=id`,
        method: 'GET',
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try { const rows = JSON.parse(d); resolve(Array.isArray(rows) && rows.length > 0 ? rows[0] : null); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null)); req.end();
    });
    if (result) return result;
  }
  return null;
}

function updateSupabase(invoiceId, data) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'psockxoyycvctjzigneh.supabase.co',
      path: `/rest/v1/invoices?id=eq.${invoiceId}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}`, 'Prefer': 'return=representation', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}
