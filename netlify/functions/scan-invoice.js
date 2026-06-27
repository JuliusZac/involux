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
  "gst_hst": dollar amount for GST/HST/TPS/TVH tax — null if not on document,
  "gst_hst_label": "exact label as printed on document for this tax line, e.g. GST, HST, TPS/TVH, GST/HST — null if not applicable",
  "pst_qst": dollar amount for PST/QST/TVQ/TVP tax — null if not on document,
  "pst_qst_label": "exact label as printed on document for this tax line, e.g. PST, QST, TVQ, PST/QST — null if not applicable",
  "tax_generic": dollar amount for any other tax not covered above — use for generic Sales Tax, Tax, flat-rate tax, US state tax, etc — null if not applicable,
  "total": final amount as a plain number — look for TOTAL, GRAND TOTAL, AMOUNT DUE, BALANCE DUE, PLEASE PAY — never null,
  "receipt_number": "invoice number, receipt number, order number, reference number — null if not found",
  "payment_method": "cash, credit, debit, visa, mastercard, amex, cheque, e-transfer, etc — null if not shown",
  "category": "single best category: Meals & Entertainment, Office Supplies, Travel, Utilities, Equipment, Software, Marketing, Professional Services, Shipping, Groceries, Fuel, Healthcare, Repairs & Maintenance, Other",
  "line_items": [
    {"description": "exact item or service name", "quantity": 1, "unit_price": 9.99, "total": 9.99}
  ]
}

TAX RULES — follow exactly:

1. Scan the ENTIRE document for every tax line before filling any tax field
2. GST, HST, TPS, TVH (alone or combined like GST/HST or TPS/TVH) → gst_hst amount + gst_hst_label
3. PST, QST, TVQ, TVP (alone or combined like PST/QST or TVQ/TVP) → pst_qst amount + pst_qst_label
4. "Tax", "Sales Tax", "State Tax", unlabeled %, or any other tax → tax_generic
5. Store the label EXACTLY as written on the document — if document says "TPS/TVH" store "TPS/TVH" not "GST"
6. NEVER store percentages — always store dollar amounts:
   - If document shows only a percentage: dollar = subtotal × (rate / 100)
   - Example: subtotal $399.00, "Tax 5%" → tax_generic = 19.95
   - Example: subtotal $200.00, "GST 5%" → gst_hst = 10.00, gst_hst_label = "GST"
7. If a tax line shows $0.00 store null, not 0
8. Never leave a tax field null if that tax type is visible on the document

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

  const { fileUrl, invoiceId } = body;

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

    // Download the file from Supabase
    const { buffer, mimeType } = await downloadFile(fileUrl);

    let extracted;
    if (mimeType === 'application/pdf' || fileUrl.toLowerCase().endsWith('.pdf')) {
      extracted = await scanPdf(buffer);
    } else {
      extracted = await scanImage(buffer, mimeType);
    }

    await updateSupabase(invoiceId, {
      supplier: extracted.supplier,
      date: extracted.date,
      amount: extracted.amount,
      invoice_number: extracted.invoice_number,
      due_date: extracted.due_date,
      status: extracted.status,
      subtotal: extracted.subtotal,
      gst_hst: extracted.gst_hst,
      gst_hst_label: extracted.gst_hst_label,
      pst_qst: extracted.pst_qst,
      pst_qst_label: extracted.pst_qst_label,
      tax: extracted.tax,
      payment_method: extracted.payment_method,
      category: extracted.category,
      line_items: extracted.line_items
    });

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: extracted }) };

  } catch (error) {
    console.error('Scan error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};

// ── DOWNLOAD ──

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      const mimeType = res.headers['content-type'] || 'application/octet-stream';
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mimeType: mimeType.split(';')[0].trim() }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── IMAGE SCAN — base64 ──

async function scanImage(buffer, mimeType) {
  const base64 = buffer.toString('base64');
  const safeMime = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mimeType) ? mimeType : 'image/jpeg';
  const dataUrl = `data:${safeMime};base64,${base64}`;

  const body = JSON.stringify({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: SCAN_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
      ]
    }],
    max_tokens: 1200,
    response_format: { type: 'json_object' }
  });

  const raw = await callOpenAI(body);
  return parseResult(raw);
}

// ── PDF SCAN ──

async function scanPdf(buffer) {
  // Try text extraction first
  try {
    const parsed = await pdfParse(buffer);
    const text = (parsed.text || '').trim();
    if (text.length >= 80) {
      const body = JSON.stringify({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: `${SCAN_PROMPT}\n\nDocument text:\n${text.substring(0, 3000)}`
        }],
        max_tokens: 1200,
        response_format: { type: 'json_object' }
      });
      const raw = await callOpenAI(body);
      return parseResult(raw);
    }
  } catch (e) { console.log('pdf-parse failed:', e.message); }

  // Scanned PDF — upload to OpenAI files API
  return await scanScannedPdf(buffer);
}

async function scanScannedPdf(buffer) {
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
        input: [{ role: 'user', content: [{ type: 'input_file', file_id: fileId }, { type: 'input_text', text: SCAN_PROMPT }] }],
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
      gst_hst: data.gst_hst != null ? parseFloat(data.gst_hst) : null,
      gst_hst_label: data.gst_hst_label || null,
      pst_qst: data.pst_qst != null ? parseFloat(data.pst_qst) : null,
      pst_qst_label: data.pst_qst_label || null,
      tax: data.tax_generic != null ? parseFloat(data.tax_generic) : null,
      payment_method: data.payment_method || null,
      category: data.category || null,
      line_items: data.line_items || null
    };
  } catch {
    return { supplier: 'Unknown', date: new Date().toISOString().split('T')[0], amount: 0, invoice_number: null, status: 'Review' };
  }
}

// ── SUPABASE ──

function verifyInvoiceOwnership(invoiceId, fileUrl) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
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
    req.on('error', reject); req.end();
  });
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
