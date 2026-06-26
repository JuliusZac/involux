const https = require('https');
const http = require('http');
const pdfParse = require('pdf-parse');

const ALLOWED_ORIGIN = 'https://involux.ca';

const SCAN_PROMPT = `You are an expert at reading invoices, receipts, and bills of all types — including thermal store receipts, restaurant bills, supplier invoices, and online order confirmations.

Look carefully at this document and extract the following fields. Return ONLY a raw JSON object with no markdown, no backticks, no explanation.

{
  "vendor_name": "the store or business name — check header, logo, or top of document",
  "date": "date of purchase or invoice in YYYY-MM-DD format — look for invoice date, order date, receipt date, or transaction date — return null if not found",
  "subtotal": numeric amount before tax — no $ or commas — null if not visible,
  "tax": total tax amount charged as a number — if multiple tax lines (e.g. GST and PST) add them together — null if not visible,
  "tax_lines": [{"label": "GST", "amount": 12.50}, {"label": "PST", "amount": 8.00}] or null if no tax breakdown visible,
  "total": final amount paid as a plain number — use TOTAL, GRAND TOTAL, AMOUNT DUE, or BALANCE DUE — never null,
  "receipt_number": "receipt, invoice, order, transaction, or reference number — null if not visible",
  "payment_method": "cash, credit, debit, visa, mastercard, amex, etc — null if not visible",
  "category": "single best category for this expense from: Meals & Entertainment, Office Supplies, Travel, Utilities, Equipment, Software, Marketing, Professional Services, Shipping, Groceries, Fuel, Healthcare, Repairs & Maintenance, Other",
  "line_items": [{"description": "Item name", "quantity": 1, "unit_price": 9.99, "total": 9.99}] or null if items not clearly readable
}

Rules:
- Numbers must always be numeric (not strings) — no $ signs, no commas
- If a field is not visible or readable, return null — never guess a value you cannot see
- vendor_name and total must never be null — always provide your best reading
- For store receipts: vendor name is at the very top, TOTAL is near the bottom before payment method
- For Canadian receipts: capture GST and PST separately in tax_lines, sum them into tax
- For line items: only include if clearly readable — skip if blurry or cut off
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
      status: extracted.status
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
    max_tokens: 400,
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
        max_tokens: 400,
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
      amount: total,
      invoice_number: data.receipt_number || null,
      status: 'Processed',
      // Extra extracted fields returned in response (not yet in DB)
      subtotal: data.subtotal != null ? parseFloat(data.subtotal) : null,
      tax: data.tax != null ? parseFloat(data.tax) : null,
      tax_lines: data.tax_lines || null,
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
