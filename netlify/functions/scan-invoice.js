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
    const body = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are an expert at reading invoices, receipts, and bills. Look carefully at this image and extract the information. Even if the image is blurry or partially visible, make your best guess.

Respond ONLY with a valid JSON object, absolutely no markdown, no explanation, no extra text:
{
  "supplier": "the business/company/vendor name (look for logo, header, or business name at top)",
  "amount": the final total amount as a number only — no $ sign, no commas (look for TOTAL, AMOUNT DUE, GRAND TOTAL, BALANCE DUE),
  "date": "date in YYYY-MM-DD format (look for invoice date, order date, or transaction date)",
  "invoice_number": "the invoice or reference number as a string — look for Invoice #, Invoice No, Ref #, Order #, Receipt #, PO #, Bill #, Transaction ID near the top of the document — return null only if completely absent"
}

Important rules:
- ALWAYS return a valid JSON object even if you can only find partial info
- For supplier: use the main business name, not the customer name
- For amount: use the largest/final total on the document
- For date: if no date found use today ${new Date().toISOString().split('T')[0]}
- For invoice_number: look carefully near the top and header area — it is usually a short alphanumeric code
- Never return null for supplier, amount or date — always make your best guess`
            },
            {
              type: 'image_url',
              image_url: { url: imageUrl, detail: 'high' }
            }
          ]
        }
      ],
      max_tokens: 300
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
