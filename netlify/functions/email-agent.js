const https = require('https');
const pdfParse = require('pdf-parse');

const SB_URL = 'psockxoyycvctjzigneh.supabase.co';
const NOW_YEAR = new Date().getFullYear();

const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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

async function processUserInbox({ user_email, gmail_refresh_token, default_business_name, gmail_connected_at, last_scanned_email_date }) {
  console.log(`\nProcessing inbox for ${user_email}...`);

  const accessToken = await getAccessToken(gmail_refresh_token);

  const businessName = default_business_name || await getDefaultBusiness(user_email);
  if (!businessName) { console.warn(`  No business for ${user_email} — skipping.`); return; }

  // RULE 1: Only scan emails after last imported email date, or connection date if first run
  const cutoffRaw = last_scanned_email_date || gmail_connected_at || new Date().toISOString();
  const cutoffDate = new Date(cutoffRaw);
  const scanSince = new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate());
  console.log(`  Scanning since: ${scanSince.toISOString().split('T')[0]} (${last_scanned_email_date ? 'last scan' : 'connection date'})`);

  // RULE 2-4: Only emails with attachments, invoice keywords, skip promotions/social/updates
  const messageIds = await searchInvoiceEmails(accessToken, scanSince);
  console.log(`  Found ${messageIds.length} candidate email(s).`);

  // RULE 10: Skip already-processed email IDs
  const processedIds = await getProcessedEmailIds(user_email);

  let saved = 0;
  let newestEmailDate = null;

  for (const messageId of messageIds) {
    if (processedIds.has(messageId)) { console.log(`  Already processed: ${messageId}`); continue; }

    try {
      const { attachments, subject, bodyText, emailDate } = await getEmailData(accessToken, messageId);
      if (emailDate && (!newestEmailDate || emailDate > newestEmailDate)) newestEmailDate = emailDate;

      // RULE 2: Only process emails that have attachments
      if (!attachments.length) { console.log(`  No valid attachments in ${messageId}`); continue; }

      for (const att of attachments) {
        try {
          const buffer = await downloadAttachment(accessToken, messageId, att.attachmentId);

          // RULE 6-8: AI confirms it's a real invoice with supplier, amount, date
          const invoiceData = await extractInvoiceData(buffer, att.mimeType, att.filename, subject, bodyText);
          if (!invoiceData.is_invoice) { console.log(`  Skipped (not an invoice): ${att.filename}`); continue; }

          // RULES 11-12: Block duplicate invoices
          const isDup = await isContentDuplicate(user_email, invoiceData);
          if (isDup) { console.log(`  Skipped (duplicate): ${invoiceData.supplier} | $${invoiceData.amount} | ${invoiceData.date}`); continue; }

          const fileUrl = await uploadToSupabase(buffer, att.mimeType, att.filename, user_email);
          await saveInvoiceRecord(invoiceData, user_email, businessName, fileUrl, messageId);
          saved++;
          console.log(`  ✓ Saved: ${invoiceData.supplier} | $${invoiceData.amount} | ${invoiceData.date}`);
        } catch (err) { console.error(`  Attachment error (${att.filename}):`, err.message); }
      }
    } catch (err) { console.error(`  Email error (${messageId}):`, err.message); }
  }

  console.log(`  Done for ${user_email}: ${saved} invoice(s) saved.`);

  // Save scan timestamp and newest email date seen
  try {
    const patch = { last_scan_at: new Date().toISOString(), last_scan_count: saved };
    if (newestEmailDate) patch.last_scanned_email_date = newestEmailDate;
    await supabasePatch('user_settings', `user_email=eq.${encodeURIComponent(user_email)}`, patch);
  } catch (e) { console.error('Failed to update scan time:', e.message); }
}

// ── GMAIL ──

function getAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const p = JSON.parse(d);
        if (p.access_token) resolve(p.access_token);
        else reject(new Error('No access token: ' + d));
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function gmailGet(accessToken, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Gmail parse error')); } });
    });
    req.on('error', reject); req.end();
  });
}

async function searchInvoiceEmails(accessToken, since) {
  // RULES 3 & 4: Invoice keywords + allowed file types + skip promotions/social/updates/spam
  const afterDate = since.toISOString().split('T')[0].replace(/-/g, '/');
  const query = encodeURIComponent([
    'has:attachment',
    '(invoice OR receipt OR facture OR "tax invoice" OR "pro forma" OR "bill of sale" OR "payment receipt" OR "payment confirmation" OR "statement of account" OR "purchase order")',
    '(filename:*.pdf OR filename:*.jpg OR filename:*.jpeg OR filename:*.png)',
    '-category:promotions',
    '-category:social',
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
  let emailDate = null;

  const headers = (data.payload && data.payload.headers) || [];
  const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
  if (subjectHeader) subject = subjectHeader.value;
  const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');
  if (dateHeader) { try { emailDate = new Date(dateHeader.value).toISOString(); } catch {} }
  if (!emailDate && data.internalDate) emailDate = new Date(parseInt(data.internalDate)).toISOString();

  function walkParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.parts) { walkParts(part.parts); continue; }
      const mimeType = part.mimeType || '';
      const filename = part.filename || '';
      const attachmentId = part.body && part.body.attachmentId;

      // RULE 2 & 5: Only allowed mime types, skip attachments over 10MB
      if (attachmentId && filename && ALLOWED_MIME_TYPES.has(mimeType)) {
        const sizeBytes = (part.body && part.body.size) || 0;
        if (sizeBytes > MAX_ATTACHMENT_BYTES) {
          console.log(`  Skipped large attachment (${Math.round(sizeBytes / 1024 / 1024)}MB): ${filename}`);
          continue;
        }
        attachments.push({ filename, mimeType, attachmentId });
        continue;
      }

      if (!attachmentId && (mimeType === 'text/plain' || mimeType === 'text/html') && part.body && part.body.data) {
        try {
          const raw = part.body.data.replace(/-/g, '+').replace(/_/g, '/');
          const decoded = Buffer.from(raw, 'base64').toString('utf8');
          const text = mimeType === 'text/html' ? decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : decoded;
          if (text.length > bodyText.length) bodyText = text.substring(0, 2000);
        } catch {}
      }
    }
  }

  walkParts(data.payload && data.payload.parts);

  if (!bodyText && data.payload && data.payload.body && data.payload.body.data) {
    try {
      const raw = data.payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
      bodyText = Buffer.from(raw, 'base64').toString('utf8').substring(0, 2000);
    } catch {}
  }

  return { attachments, subject, bodyText, emailDate };
}

async function downloadAttachment(accessToken, messageId, attachmentId) {
  const data = await gmailGet(accessToken, `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`);
  const raw = (data.data || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(raw, 'base64');
}

// ── AI EXTRACTION ──

const INVOICE_PROMPT = `You are a strict invoice detection system for a business accounting app.

RETURN is_invoice: true ONLY if ALL of these are true:
1. There is a specific final monetary total — amount due, charged, or paid
2. There is a clearly identifiable supplier or vendor name (who is charging money)
3. There is a transaction date on the document
4. The document is one of: invoice, receipt, bill, statement of account, purchase confirmation, payment confirmation

RETURN is_invoice: false for ANY of these:
- Marketing emails, newsletters, promotions, sale announcements, discount offers
- Contracts, agreements, terms & conditions, legal documents
- Logos, photos, ID cards, images with no financial content
- Pay stubs, salary slips, payroll documents
- Price lists, catalogues, quotes without confirmed purchase
- Shipping/tracking notifications without a charge amount
- Subscription renewal reminders (not actual receipts)
- Any document where you cannot clearly read a specific total dollar amount

EXTRACTION — if is_invoice: true:
- supplier: company or person ISSUING the invoice (who is charging — not the recipient)
- amount: final grand total as plain decimal only, no $ or commas, use grand total not subtotal
- date: invoice/receipt date in YYYY-MM-DD format — must be a real date, never guess
- invoice_number: any invoice, receipt, order, confirmation, or transaction ID on the document

RESPOND with ONLY raw JSON. No markdown. No explanation.
If invoice: {"is_invoice":true,"supplier":"Acme Corp","amount":1250.00,"date":"2024-06-15","invoice_number":"INV-00123"}
If not: {"is_invoice":false}`;

async function extractInvoiceData(buffer, mimeType, filename, emailSubject, emailBody) {
  try {
    if (mimeType.startsWith('image/')) {
      const base64 = buffer.toString('base64');
      const content = [
        { type: 'text', text: INVOICE_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } }
      ];
      return await callGPT(content);
    }

    // PDF: try text extraction first
    let pdfText = '';
    try {
      const parsed = await pdfParse(buffer);
      pdfText = (parsed.text || '').trim();
      console.log(`  PDF text: ${pdfText.length} chars`);
    } catch (e) { console.log('  pdf-parse failed:', e.message); }

    if (pdfText.length >= 100) {
      const content = [{ type: 'text', text: `${INVOICE_PROMPT}\n\nFilename: "${filename}"\n\nPDF text:\n${pdfText.substring(0, 3000)}` }];
      return await callGPT(content);
    }

    // Scanned PDF — upload to OpenAI
    console.log('  Scanned PDF — uploading to OpenAI...');
    return await extractScannedPdf(buffer, filename);

  } catch (err) {
    console.error('  extractInvoiceData error:', err.message);
    return { is_invoice: false };
  }
}

async function callGPT(content) {
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
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
  const parsed = JSON.parse(responseText);
  const data = JSON.parse(parsed.choices[0].message.content);
  return processExtractedData(data);
}

async function extractScannedPdf(buffer, filename) {
  let fileId = null;
  try {
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
    if (!fileId) { console.error('  File upload failed:', JSON.stringify(fileData)); return { is_invoice: false }; }
    console.log(`  Uploaded to OpenAI: ${fileId}`);

    const respRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        input: [{ role: 'user', content: [{ type: 'input_file', file_id: fileId }, { type: 'input_text', text: INVOICE_PROMPT }] }],
        text: { format: { type: 'json_object' } }
      })
    });
    const result = await respRes.json();
    let rawText = result.output?.[0]?.content?.[0]?.text || '';
    if (!rawText) { console.error('  Empty response from OpenAI'); return { is_invoice: false }; }
    rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return processExtractedData(JSON.parse(rawText));
  } catch (err) {
    console.error('  extractScannedPdf error:', err.message);
    return { is_invoice: false };
  } finally {
    if (fileId) {
      try { await fetch(`https://api.openai.com/v1/files/${fileId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } }); } catch {}
    }
  }
}

function processExtractedData(data) {
  if (!data || !data.is_invoice) return { is_invoice: false };

  const supplier = (data.supplier || '').trim();
  const amount = parseFloat(data.amount) || 0;

  // RULES 7 & 8: Reject if supplier missing or amount zero
  if (!supplier || supplier.toLowerCase() === 'unknown') {
    console.log('  Rejected: supplier missing or unknown');
    return { is_invoice: false };
  }
  if (amount <= 0) {
    console.log('  Rejected: amount zero or missing');
    return { is_invoice: false };
  }

  // Validate date
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

  return { is_invoice: true, supplier, amount, date, invoice_number: data.invoice_number || null, status: 'Processed' };
}

// ── DUPLICATE CHECK (RULES 11 & 12) ──

async function isContentDuplicate(userEmail, invoiceData) {
  try {
    const supplier = invoiceData.supplier.toLowerCase().trim();
    if (invoiceData.invoice_number) {
      // RULE 11: Same invoice number + amount = duplicate
      const data = await supabaseGet(`invoices?user_email=eq.${encodeURIComponent(userEmail)}&invoice_number=eq.${encodeURIComponent(invoiceData.invoice_number)}&amount=eq.${invoiceData.amount}&select=id&limit=1`);
      return Array.isArray(data) && data.length > 0;
    } else {
      // RULE 12: Same supplier (case-insensitive) + amount + date = duplicate
      const data = await supabaseGet(`invoices?user_email=eq.${encodeURIComponent(userEmail)}&amount=eq.${invoiceData.amount}&date=eq.${invoiceData.date}&select=supplier&limit=10`);
      if (!Array.isArray(data) || !data.length) return false;
      return data.some(r => r.supplier && r.supplier.toLowerCase().trim() === supplier);
    }
  } catch { return false; }
}

// ── SUPABASE ──

async function getConnectedUsers() {
  const data = await supabaseGet(`user_settings?gmail_connected=eq.true&select=user_email,gmail_refresh_token,default_business_name,gmail_connected_at,last_scanned_email_date`);
  return Array.isArray(data) ? data : [];
}

async function getDefaultBusiness(userEmail) {
  const data = await supabaseGet(`businesses?user_email=eq.${encodeURIComponent(userEmail)}&order=created_at.asc&limit=1&select=name`);
  return data[0] ? data[0].name : null;
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
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) resolve(`https://${SB_URL}/storage/v1/object/public/invoices/${path}`);
        else reject(new Error(`Storage upload failed (${res.statusCode}): ${d}`));
      });
    });
    req.on('error', reject); req.write(buffer); req.end();
  });
}

async function saveInvoiceRecord(invoiceData, userEmail, businessName, fileUrl, sourceEmailId) {
  const now = new Date();
  const dateObj = new Date(invoiceData.date);
  const year = dateObj.getFullYear();
  // RULE 9: File into correct year/month based on invoice date, not email date
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

function supabaseGet(endpoint) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const req = https.request({
      hostname: SB_URL, path: `/rest/v1/${endpoint}`, method: 'GET',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Supabase parse error')); } });
    });
    req.on('error', reject); req.end();
  });
}

function supabasePost(table, data) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: SB_URL, path: `/rest/v1/${table}`, method: 'POST',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function supabasePatch(table, filter, data) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: SB_URL, path: `/rest/v1/${table}?${filter}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}
