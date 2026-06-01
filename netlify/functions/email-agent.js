const https = require('https');
const pdfParse = require('pdf-parse');

// ── CONFIG ──
const SB_URL = 'psockxoyycvctjzigneh.supabase.co';
const ALLOWED_MIME_TYPES = new Set(['application/pdf','image/jpeg','image/jpg','image/png']);
const NOW_YEAR = new Date().getFullYear();

exports.handler = async () => {
  console.log(`[${new Date().toISOString()}] Starting invoice email scan...`);
  try {
    const users = await getConnectedUsers();
    console.log(`Found ${users.length} connected user(s).`);
    for (const u of users) {
      try { await processUserInbox(u); }
      catch (err) { console.error(`Error for ${u.user_email}:`, err.message); }
    }
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('Agent error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function processUserInbox({ user_email, gmail_refresh_token, default_business_name, gmail_connected_at }) {
  console.log(`\nProcessing inbox for ${user_email}...`);

  const accessToken = await getAccessToken(gmail_refresh_token);

  const businessName = default_business_name || await getDefaultBusiness(user_email);
  if (!businessName) { console.warn(`  No business for ${user_email} — skipping.`); return; }

  // Only scan emails received on or after the day Gmail was connected
  const connectedDate = gmail_connected_at ? new Date(gmail_connected_at) : new Date();
  const scanSince = new Date(connectedDate.getFullYear(), connectedDate.getMonth(), connectedDate.getDate());
  console.log(`  Scanning emails since: ${scanSince.toISOString().split('T')[0]}`);

  // Get all message IDs from Gmail matching invoice keywords
  const messageIds = await searchInvoiceEmails(accessToken, scanSince);
  console.log(`  Found ${messageIds.length} candidate email(s).`);

  // Get already-processed email IDs from Supabase to avoid duplicates
  const processedIds = await getProcessedEmailIds(user_email);

  let saved = 0;
  for (const messageId of messageIds) {
    if (processedIds.has(messageId)) { console.log(`  Already processed: ${messageId}`); continue; }
    try {
      const { attachments, subject, bodyText } = await getEmailData(accessToken, messageId);

      if (attachments.length === 0) continue;

      for (const att of attachments) {
        try {
          const buffer = await downloadAttachment(accessToken, messageId, att.attachmentId);
          const invoiceData = await extractInvoiceData(buffer, att.mimeType, att.filename, subject, bodyText);

          if (!invoiceData.is_invoice) {
            console.log(`  Skipped (not an invoice): ${att.filename}`);
            continue;
          }

          // Content-based duplicate check — same invoice sent in two different emails
          const isDup = await isContentDuplicate(user_email, invoiceData);
          if (isDup) {
            console.log(`  Skipped (duplicate invoice): ${invoiceData.supplier} | $${invoiceData.amount} | ${invoiceData.date}`);
            continue;
          }

          const fileUrl = await uploadToSupabase(buffer, att.mimeType, att.filename, user_email);
          await saveInvoiceRecord(invoiceData, user_email, businessName, fileUrl, messageId);
          saved++;
          console.log(`  ✓ Saved: ${invoiceData.supplier} | $${invoiceData.amount} | ${invoiceData.date}`);
        } catch (err) { console.error(`  Attachment error (${att.filename}):`, err.message); }
      }
    } catch (err) { console.error(`  Email error (${messageId}):`, err.message); }
  }
  console.log(`  Done for ${user_email}: ${saved} invoice(s) saved.`);
  // Save scan timestamp and count to user_settings
  try {
    await supabasePatch('user_settings', `user_email=eq.${encodeURIComponent(user_email)}`, {
      last_scan_at: new Date().toISOString(),
      last_scan_count: saved
    });
  } catch(e) { console.error('Failed to update scan time:', e.message); }
}

// ── GMAIL HELPERS ──

function getAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    const body = params.toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const p = JSON.parse(d);
        if (p.access_token) resolve(p.access_token);
        else reject(new Error('No access token: ' + d));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function gmailGet(accessToken, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Gmail parse error')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function searchInvoiceEmails(accessToken, since) {
  const afterDate = since.toISOString().split('T')[0].replace(/-/g, '/');
  // Tight invoice-specific search — keywords + file types, excludes promotions/social/spam
  const query = encodeURIComponent([
    'has:attachment',
    '(invoice OR receipt OR facture OR "tax invoice" OR "pro forma" OR "bill of sale" OR "payment receipt" OR "payment confirmation" OR "statement of account" OR "purchase order")',
    '(filename:*.pdf OR filename:*.jpg OR filename:*.jpeg OR filename:*.png)',
    '-category:promotions',
    '-category:social',
    '-category:updates',
    '-label:spam',
    `after:${afterDate}`
  ].join(' '));

  const messageIds = [];
  let pageToken = '';
  do {
    const url = `/gmail/v1/users/me/messages?q=${query}&maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`;
    const data = await gmailGet(accessToken, url);
    for (const msg of data.messages || []) { if (msg.id) messageIds.push(msg.id); }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return messageIds;
}

async function getEmailData(accessToken, messageId) {
  const data = await gmailGet(accessToken, `/gmail/v1/users/me/messages/${messageId}?format=full`);
  const attachments = [];
  let subject = '';
  let bodyText = '';

  // Extract subject
  const headers = (data.payload && data.payload.headers) || [];
  const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
  if (subjectHeader) subject = subjectHeader.value;

  // Walk parts to get attachments and body text
  function walkParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.parts) { walkParts(part.parts); continue; }
      const mimeType = part.mimeType || '';
      const filename = part.filename || '';
      const attachmentId = part.body && part.body.attachmentId;

      // Collect attachment — skip if over 10MB
      if (attachmentId && filename && ALLOWED_MIME_TYPES.has(mimeType)) {
        const sizeBytes = (part.body && part.body.size) || 0;
        if (sizeBytes > 10 * 1024 * 1024) {
          console.log(`  Skipped large attachment (${Math.round(sizeBytes/1024/1024)}MB): ${filename}`);
          continue;
        }
        attachments.push({ filename, mimeType, attachmentId, messageId });
        continue;
      }

      // Collect plain text body
      if (!attachmentId && (mimeType === 'text/plain' || mimeType === 'text/html') && part.body && part.body.data) {
        try {
          const raw = part.body.data.replace(/-/g, '+').replace(/_/g, '/');
          const decoded = Buffer.from(raw, 'base64').toString('utf8');
          // Strip HTML tags for html parts
          const text = mimeType === 'text/html' ? decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : decoded;
          if (text.length > bodyText.length) bodyText = text.substring(0, 2000); // cap at 2000 chars
        } catch {}
      }
    }
  }

  walkParts(data.payload && data.payload.parts);

  // Also check top-level body (single-part messages)
  if (!bodyText && data.payload && data.payload.body && data.payload.body.data) {
    try {
      const raw = data.payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
      bodyText = Buffer.from(raw, 'base64').toString('utf8').substring(0, 2000);
    } catch {}
  }

  return { attachments, subject, bodyText };
}

async function downloadAttachment(accessToken, messageId, attachmentId) {
  const data = await gmailGet(accessToken, `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`);
  const raw = (data.data || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(raw, 'base64');
}

// ── OPENAI SCANNER ──

async function extractInvoiceData(buffer, mimeType, filename, emailSubject, emailBody) {
  try {
    const isImage = mimeType.startsWith('image/');

    if (isImage) {
      // Images: use GPT-4o Vision directly
      const base64 = buffer.toString('base64');
      const content = [
        { type: 'text', text: SCAN_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } }
      ];
      return await callChatCompletions(content);
    }

    // PDFs: try text extraction first (fast, cheap)
    let pdfText = '';
    try {
      const parsed = await pdfParse(buffer);
      pdfText = (parsed.text || '').trim();
      console.log(`  PDF text extracted: ${pdfText.length} chars`);
    } catch (e) { console.log('  pdf-parse failed:', e.message); }

    if (pdfText.length >= 100) {
      // Text-based PDF — pass the text to GPT
      const content = [{ type: 'text', text: `${PDF_PROMPT}\n\nFilename: "${filename}"\n\nPDF text:\n${pdfText.substring(0, 3000)}` }];
      return await callChatCompletions(content);
    }

    // Scanned PDF — upload to OpenAI so GPT can actually see it
    console.log('  Scanned PDF detected, uploading to OpenAI...');
    return await extractScannedPdf(buffer, filename);

  } catch (err) {
    console.error('  extractInvoiceData error:', err.message);
    return { is_invoice: false };
  }
}

async function callChatCompletions(content) {
  const body = JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
    max_tokens: 400
  });
  const responseText = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
  const parsed = JSON.parse(responseText);
  const data = JSON.parse(parsed.choices[0].message.content);
  return processExtractedData(data);
}

async function extractScannedPdf(buffer, filename) {
  let fileId = null;
  try {
    // Upload PDF to OpenAI Files API
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
    formData.append('purpose', 'user_data');

    const uploadRes = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData
    });
    const fileData = await uploadRes.json();
    fileId = fileData.id;
    console.log(`  Uploaded to OpenAI: ${fileId}`);

    if (!fileId) { console.error('  File upload failed:', JSON.stringify(fileData)); return { is_invoice: false }; }

    // Use Responses API — GPT-4o reads the actual PDF
    const respRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        input: [{
          role: 'user',
          content: [
            { type: 'input_file', file_id: fileId },
            { type: 'input_text', text: PDF_PROMPT }
          ]
        }],
        text: { format: { type: 'json_object' } }
      })
    });

    const result = await respRes.json();
    console.log('  Responses API:', JSON.stringify(result).substring(0, 300));

    let rawText = result.output?.[0]?.content?.[0]?.text || '';
    if (!rawText) { console.error('  Empty response from Responses API'); return { is_invoice: false }; }

    // Strip markdown code blocks if present (```json ... ```)
    rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const data = JSON.parse(rawText);
    return processExtractedData(data);

  } catch (err) {
    console.error('  extractScannedPdf error:', err.message);
    return { is_invoice: false };
  } finally {
    // Always clean up the uploaded file
    if (fileId) {
      try {
        await fetch(`https://api.openai.com/v1/files/${fileId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
        });
      } catch {}
    }
  }
}

function processExtractedData(data) {
  if (!data || !data.is_invoice) return { is_invoice: false };

  const amount = parseFloat(data.amount) || 0;
  const supplier = (data.supplier || '').trim();

  // Reject if extraction clearly failed — no supplier and no amount means GPT couldn't read it
  if (!supplier || supplier === 'Unknown') {
    console.log('  Rejected: supplier missing or unknown');
    return { is_invoice: false };
  }
  if (amount <= 0) {
    console.log('  Rejected: amount is zero or missing');
    return { is_invoice: false };
  }

  // Validate and clean the date
  let date = data.date || null;
  if (date) {
    const d = new Date(date);
    const year = d.getFullYear();
    if (isNaN(d.getTime()) || year < 2015 || year > NOW_YEAR + 1) {
      console.log(`  Date invalid (${date}), using today`);
      date = new Date().toISOString().split('T')[0];
    }
  } else {
    date = new Date().toISOString().split('T')[0];
  }

  return {
    is_invoice: true,
    supplier,
    amount,
    date,
    invoice_number: data.invoice_number || null,
    status: 'Processed'
  };
}

const INVOICE_PROMPT = `You are an expert invoice detection system for a business accounting app. Your job is to determine if a document is a genuine business invoice or receipt that a business owner needs to track for accounting.

RETURN is_invoice: true ONLY if ALL of these are true:
1. There is a SPECIFIC monetary total — a final amount due, charged, or paid (not just a price list, estimate, or range)
2. There is a clearly identifiable supplier or vendor name (the business/person charging money)
3. There is a transaction date on the document
4. The document is one of: invoice, receipt, bill, statement of account, purchase confirmation, or payment confirmation

RETURN is_invoice: false for ANY of these — even if they have dollar amounts:
- Marketing emails, newsletters, promotions, sale announcements, or discount offers
- Contracts, agreements, terms & conditions, NDAs, or legal documents
- Logos, photos, ID cards, or images with no financial content
- Pay stubs, salary slips, or employee payroll documents
- Price lists, catalogues, product brochures, or quotes without a confirmed purchase
- Shipping/tracking notifications that don't include a charge amount
- Subscription renewal REMINDERS (not actual receipts/invoices)
- Any document where you cannot clearly read a specific total dollar amount

EXTRACTION — If is_invoice: true, extract with maximum precision:
- supplier: the company or person ISSUING the invoice (who is charging money — not the recipient)
- amount: the FINAL grand total as a plain decimal number only. No $ signs, no commas. If tax is included in the final total use that. Never use a subtotal when a grand total exists.
- date: the invoice/receipt date in YYYY-MM-DD format. Search for "Invoice Date", "Date", "Issued", "Bill Date", "Transaction Date", "Order Date". Must be a real date — never guess.
- invoice_number: any invoice number, receipt number, order number, confirmation number, or transaction ID on the document

RESPOND with ONLY a raw JSON object. No markdown. No explanation. No code blocks.
If invoice: {"is_invoice":true,"supplier":"Acme Corp","amount":1250.00,"date":"2024-06-15","invoice_number":"INV-00123"}
If not: {"is_invoice":false}`;

// Alias — same strict prompt used for all document types
const SCAN_PROMPT = INVOICE_PROMPT;
const PDF_PROMPT = INVOICE_PROMPT;

// ── SUPABASE HELPERS ──

async function getConnectedUsers() {
  return supabaseGet(`user_settings?gmail_connected=eq.true&select=user_email,gmail_refresh_token,default_business_name,gmail_connected_at`);
}

async function getDefaultBusiness(userEmail) {
  const data = await supabaseGet(`businesses?user_email=eq.${encodeURIComponent(userEmail)}&order=created_at.asc&limit=1&select=name`);
  return data[0] ? data[0].name : null;
}

async function isContentDuplicate(userEmail, invoiceData) {
  try {
    let query;
    if (invoiceData.invoice_number) {
      // If we have an invoice number, match on supplier + invoice number
      query = `invoices?user_email=eq.${encodeURIComponent(userEmail)}&supplier=eq.${encodeURIComponent(invoiceData.supplier)}&invoice_number=eq.${encodeURIComponent(invoiceData.invoice_number)}&select=id&limit=1`;
    } else {
      // No invoice number — match on supplier + amount + date
      query = `invoices?user_email=eq.${encodeURIComponent(userEmail)}&supplier=eq.${encodeURIComponent(invoiceData.supplier)}&amount=eq.${invoiceData.amount}&date=eq.${invoiceData.date}&select=id&limit=1`;
    }
    const data = await supabaseGet(query);
    return Array.isArray(data) && data.length > 0;
  } catch { return false; }
}

async function getProcessedEmailIds(userEmail) {
  const data = await supabaseGet(`invoices?user_email=eq.${encodeURIComponent(userEmail)}&select=source_email_id&source_email_id=not.is.null`);
  const ids = new Set();
  for (const row of (Array.isArray(data) ? data : [])) {
    if (row.source_email_id) ids.add(row.source_email_id);
  }
  return ids;
}

async function uploadToSupabase(buffer, mimeType, filename, userEmail) {
  const ext = filename.split('.').pop().toLowerCase();
  const path = `${userEmail}/${Date.now()}.${ext}`;
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const req = https.request({
      hostname: SB_URL, path: `/storage/v1/object/invoices/${path}`, method: 'POST',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': mimeType, 'Content-Length': buffer.length }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) resolve(`https://${SB_URL}/storage/v1/object/public/invoices/${path}`);
        else reject(new Error(`Storage upload failed (${res.statusCode}): ${d}`));
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function saveInvoiceRecord(invoiceData, userEmail, businessName, fileUrl, sourceEmailId) {
  const now = new Date();
  const dateObj = new Date(invoiceData.date);
  const year = dateObj.getFullYear();
  // Final safety check on year
  const folderYear = (year >= 2015 && year <= NOW_YEAR + 1) ? year : now.getFullYear();
  const folderMonth = (year >= 2015 && year <= NOW_YEAR + 1) ? dateObj.getMonth() : now.getMonth();

  return supabasePost('invoices', {
    user_email: userEmail,
    business_name: businessName,
    supplier: invoiceData.supplier,
    amount: invoiceData.amount,
    date: invoiceData.date,
    invoice_number: invoiceData.invoice_number,
    status: invoiceData.status,
    paid: false,
    notes: '',
    file_url: fileUrl,
    folder_year: folderYear,
    folder_month: folderMonth,
    source_email_id: sourceEmailId
  });
}

function supabasePatch(table, filter, data) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: SB_URL, path: `/rest/v1/${table}?${filter}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d)); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function supabaseGet(endpoint) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const req = https.request({
      hostname: SB_URL, path: `/rest/v1/${endpoint}`, method: 'GET',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Supabase parse error')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function supabasePost(table, data) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: SB_URL, path: `/rest/v1/${table}`, method: 'POST',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
