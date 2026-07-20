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

function guessPaymentStatus(paymentMethod) {
  const m = (paymentMethod || '').toLowerCase();
  if (m && PAID_METHODS.test(m)) return 'PAID';
  if (m && PENDING_METHODS.test(m)) return 'AWAITING_PAYMENT';
  return 'PAID'; // receipts with no method are almost always already paid
}

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
Default to "Miscellaneous" if nothing else fits.

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
  const prompt = buildPrompt(xeroAccounts, qbAccounts);

  const makeBody = (p) => JSON.stringify({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: p },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
      ]
    }],
    max_tokens: 2000,
    response_format: { type: 'json_object' }
  });

  const raw = await callOpenAI(makeBody(prompt));
  const result = parseResult(raw);
  if (result.supplier === 'Unknown' && !result.amount) {
    const raw2 = await callOpenAI(makeBody(prompt + '\n\nIMPORTANT: This image DOES contain invoice data. Look harder — zoom into every corner, read every line, and extract all fields. Do not return Unknown or null for fields that are visible.'));
    return parseResult(raw2);
  }
  return result;
}

// ── PDF SCAN ──

async function scanPdf(buffer, xeroAccounts = [], qbAccounts = []) {
  const prompt = buildPrompt(xeroAccounts, qbAccounts);
  // Try text extraction first
  try {
    const parsed = await pdfParse(buffer);
    const text = (parsed.text || '').trim();
    if (text.length >= 80) {
      const body = JSON.stringify({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: `${prompt}\n\nDocument text:\n${text.substring(0, 6000)}`
        }],
        max_tokens: 2000,
        response_format: { type: 'json_object' }
      });
      const raw = await callOpenAI(body);
      const result = parseResult(raw);
      if (result.supplier === 'Unknown' && !result.amount) {
        const body2 = JSON.stringify({
          model: 'gpt-4o',
          messages: [{
            role: 'user',
            content: `${prompt}\n\nIMPORTANT: This document DOES contain invoice data. Extract every field carefully.\n\nDocument text:\n${text.substring(0, 6000)}`
          }],
          max_tokens: 2000,
          response_format: { type: 'json_object' }
        });
        const raw2 = await callOpenAI(body2);
        return parseResult(raw2);
      }
      return result;
    }
  } catch (e) { console.log('pdf-parse failed:', e.message); }

  // Scanned PDF — upload to OpenAI files API
  return await scanScannedPdf(buffer, prompt);
}

async function scanScannedPdf(buffer, prompt = SCAN_PROMPT) {
  let fileId = null;
  try {
    const FormData = (await import('node:form-data')).default || require('form-data');
    const form = new FormData();
    form.append('file', buffer, { filename: 'invoice.pdf', contentType: 'application/pdf' });
    form.append('purpose', 'user_data');

    const uploadRes = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      body: form
    });
    const fileData = await uploadRes.json();
    fileId = fileData.id;
    if (!fileId) return parseResult('{}');

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
    const raw = result.output?.[0]?.content?.[0]?.text || '{}';
    return parseResult(raw);
  } catch (e) {
    console.error('Scanned PDF error:', e.message);
    return parseResult('{}');
  } finally {
    if (fileId) {
      try { await fetch(`https://api.openai.com/v1/files/${fileId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } }); } catch {}
    }
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

async function fetchQBAccounts(business_id) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  try {
    const connRows = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'psockxoyycvctjzigneh.supabase.co',
        path: `/rest/v1/quickbooks_connections?business_id=eq.${encodeURIComponent(business_id)}&select=access_token,realm_id,expires_at`,
        method: 'GET',
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
      });
      req.on('error', () => resolve([])); req.end();
    });
    if (!Array.isArray(connRows) || !connRows.length) return [];
    const { access_token, realm_id, expires_at } = connRows[0];
    if (!access_token || !realm_id) return [];
    // Skip if token is already expired (don't refresh here — scan should be fast)
    if (new Date(expires_at) <= new Date()) return [];
    const QB_HOST = process.env.QUICKBOOKS_ENVIRONMENT === 'production'
      ? 'quickbooks.api.intuit.com'
      : 'sandbox-quickbooks.api.intuit.com';
    const res = await new Promise((resolve) => {
      const path = `/v3/company/${realm_id}/query?query=${encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 150")}&minorversion=65`;
      const req = https.request({
        hostname: QB_HOST, path, method: 'GET',
        headers: { 'Authorization': `Bearer ${access_token}`, 'Accept': 'application/json' },
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      });
      req.on('error', () => resolve({})); req.end();
    });
    return (res.QueryResponse?.Account || [])
      .filter(a => a.Active !== false)
      .map(a => ({ id: a.Id, name: a.Name }));
  } catch { return []; }
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
