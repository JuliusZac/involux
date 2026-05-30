const https = require('https');

const ALLOWED_ORIGIN = 'https://involux.ca';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Reject requests not originating from involux.ca
  const origin = event.headers['origin'] || event.headers['referer'] || '';
  if (!origin.startsWith(ALLOWED_ORIGIN)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { fileUrl, invoiceId } = body;

  if (!fileUrl || !invoiceId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fileUrl or invoiceId' }) };
  }

  // Security: only allow exact Supabase storage URLs for this project
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('https://psockxoyycvctjzigneh.supabase.co/storage/')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid file URL' }) };
  }

  // Security: validate invoiceId is a proper UUID
  if (typeof invoiceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(invoiceId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid invoice ID' }) };
  }

  try {
    // Security: verify this invoiceId actually owns this fileUrl before updating anything
    const invoice = await verifyInvoiceOwnership(invoiceId, fileUrl);
    if (!invoice) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Invoice not found or file mismatch' }) };
    }

    const openaiResponse = await callOpenAI(fileUrl);
    const extracted = parseInvoiceData(openaiResponse);
    await updateSupabase(invoiceId, extracted);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data: extracted })
    };

  } catch (error) {
    console.error('Scan error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

// Verify that the invoiceId has the matching file_url in Supabase
function verifyInvoiceOwnership(invoiceId, fileUrl) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const path = `/rest/v1/invoices?id=eq.${invoiceId}&file_url=eq.${encodeURIComponent(fileUrl)}&select=id`;
    const options = {
      hostname: 'psockxoyycvctjzigneh.supabase.co',
      path,
      method: 'GET',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try {
          const rows = JSON.parse(d);
          resolve(Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function callOpenAI(imageUrl) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString().split('T')[0];
    const body = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are an expert invoice reader. Examine this invoice/receipt image carefully at high detail and extract the following fields.

SUPPLIER — The business or company that issued this invoice (the vendor/seller, not the buyer). Look for the largest name, logo text, or header at the top of the document.

AMOUNT — The final total charged. Look for labels like: TOTAL, GRAND TOTAL, AMOUNT DUE, BALANCE DUE, TOTAL DUE, AMOUNT PAID, SUBTOTAL (if no tax line). Use the largest bottom-line number. Return as a plain decimal number, no $ or commas.

DATE — The invoice date, bill date, or transaction date. Search every part of the document for:
- Labels: "Invoice Date", "Date", "Bill Date", "Issue Date", "Statement Date", "Order Date", "Transaction Date", "Issued", "Dated"
- Common formats: "May 29, 2026" or "29 May 2026" or "05/29/2026" or "29/05/2026" or "2026-05-29" or "05-29-26" or "May 29" (assume current year)
- Dates near the invoice number or in the header area
- If there are multiple dates (invoice date vs due date), use the INVOICE date not the due date
- Convert whatever format you find to YYYY-MM-DD
- Only use ${today} as a last resort if truly no date exists anywhere on the document

INVOICE NUMBER — Any reference number, invoice ID, receipt number, order number, or confirmation number. Usually near the top. Look for: "Invoice #", "Invoice No", "Ref #", "Order #", "Receipt #", "PO #", "#", "No.", "ID".

Respond ONLY with raw JSON, no markdown, no explanation:
{"supplier":"Company Name","amount":123.45,"date":"YYYY-MM-DD","invoice_number":"INV-001"}

Never return null for any field — always provide your best reading. If truly unknown use "Unknown" for supplier, 0 for amount, ${today} for date, null for invoice_number.`
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl, detail: 'high' }
            }
          ]
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 400
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.choices[0].message.content);
        } catch (e) {
          reject(new Error('Failed to parse OpenAI response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseInvoiceData(content) {
  try {
    const clean = content.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);
    return {
      supplier: data.supplier || 'Unknown',
      date: data.date || new Date().toISOString().split('T')[0],
      amount: parseFloat(data.amount) || 0,
      invoice_number: data.invoice_number || null,
      status: 'Processed'
    };
  } catch (e) {
    return {
      supplier: 'Unknown',
      date: new Date().toISOString().split('T')[0],
      amount: 0,
      invoice_number: null,
      status: 'Review'
    };
  }
}

async function updateSupabase(invoiceId, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const options = {
      hostname: 'psockxoyycvctjzigneh.supabase.co',
      path: `/rest/v1/invoices?id=eq.${invoiceId}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=representation',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve(d));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
