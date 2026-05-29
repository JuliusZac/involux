const https = require('https');

// ── CONFIG ──
const SB_URL = 'psockxoyycvctjzigneh.supabase.co';
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const ALLOWED_MIME_TYPES = new Set(['application/pdf','image/jpeg','image/jpg','image/png']);
const LABEL_NAME = 'Processed-Involux';

exports.handler = async () => {
  console.log(`[${new Date().toISOString()}] Starting invoice email scan...`);

  try {
    // Get all users who have connected Gmail
    const users = await getConnectedUsers();
    console.log(`Found ${users.length} connected user(s).`);

    for (const userSetting of users) {
      try {
        await processUserInbox(userSetting);
      } catch (err) {
        console.error(`Error processing inbox for ${userSetting.user_email}:`, err);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('Agent error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function processUserInbox(userSetting) {
  const { user_email, gmail_refresh_token, default_business_name } = userSetting;
  console.log(`\nProcessing inbox for ${user_email}...`);

  // Get a fresh Gmail access token
  const accessToken = await getAccessToken(gmail_refresh_token);

  // Get the default business for this user
  const businessName = default_business_name || await getDefaultBusiness(user_email);
  if (!businessName) {
    console.warn(`  No business found for ${user_email} — skipping.`);
    return;
  }

  // Get or create the processed label
  const labelId = await getOrCreateLabel(accessToken, LABEL_NAME);

  // Search for invoice emails
  const messageIds = await searchInvoiceEmails(accessToken, labelId);
  console.log(`  Found ${messageIds.length} unprocessed email(s).`);

  let saved = 0;

  for (const messageId of messageIds) {
    try {
      const attachments = await getAttachments(accessToken, messageId);
      if (attachments.length === 0) {
        await markAsProcessed(accessToken, messageId, labelId);
        continue;
      }

      let invoicesSaved = 0;

      for (const att of attachments) {
        try {
          const buffer = await downloadAttachment(accessToken, messageId, att.attachmentId);
          const invoiceData = await extractInvoiceData(buffer, att.mimeType, att.filename);
          const fileUrl = await uploadToSupabase(buffer, att.mimeType, att.filename, user_email);
          await saveInvoiceRecord(invoiceData, user_email, businessName, fileUrl, messageId);

          invoicesSaved++;
          console.log(`  Saved: ${invoiceData.supplier || 'unknown'} | $${invoiceData.amount || '?'} | ${invoiceData.date || 'no date'}`);
        } catch (err) {
          console.error(`  Attachment error (${att.filename}):`, err);
        }
      }

      if (invoicesSaved > 0) {
        await markAsProcessed(accessToken, messageId, labelId);
        saved += invoicesSaved;
      }
    } catch (err) {
      console.error(`  Email error (${messageId}):`, err);
    }
  }

  console.log(`  Done for ${user_email}: ${saved} invoice(s) saved.`);
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
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error('No access token: ' + d));
        } catch { reject(new Error('Failed to parse token response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function gmailGet(accessToken, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'gmail.googleapis.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Failed to parse Gmail response')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function gmailPost(accessToken, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'gmail.googleapis.com',
      path,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Failed to parse Gmail response')); } });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getOrCreateLabel(accessToken, labelName) {
  const { labels } = await gmailGet(accessToken, '/gmail/v1/users/me/labels');
  const existing = (labels || []).find(l => l.name === labelName);
  if (existing) return existing.id;

  const created = await gmailPost(accessToken, '/gmail/v1/users/me/labels', {
    name: labelName,
    labelListVisibility: 'labelShow',
    messageListVisibility: 'show'
  });
  return created.id;
}

async function searchInvoiceEmails(accessToken, labelId) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  const afterDate = cutoff.toISOString().split('T')[0].replace(/-/g, '/');

  const query = encodeURIComponent([
    'has:attachment',
    '(invoice OR receipt OR bill OR statement OR "payment due")',
    `-label:${LABEL_NAME}`,
    `after:${afterDate}`
  ].join(' '));

  const messageIds = [];
  let pageToken = '';

  do {
    const url = `/gmail/v1/users/me/messages?q=${query}&maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`;
    const data = await gmailGet(accessToken, url);
    for (const msg of data.messages || []) {
      if (msg.id) messageIds.push(msg.id);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return messageIds;
}

async function getAttachments(accessToken, messageId) {
  const data = await gmailGet(accessToken, `/gmail/v1/users/me/messages/${messageId}?format=full`);
  const attachments = [];

  function walkParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.parts) { walkParts(part.parts); continue; }
      const mimeType = part.mimeType || '';
      const filename = part.filename || '';
      const attachmentId = part.body && part.body.attachmentId;
      if (!attachmentId || !filename || !ALLOWED_MIME_TYPES.has(mimeType)) continue;
      attachments.push({ filename, mimeType, attachmentId, messageId });
    }
  }

  walkParts(data.payload && data.payload.parts);
  return attachments;
}

async function downloadAttachment(accessToken, messageId, attachmentId) {
  const data = await gmailGet(accessToken, `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`);
  const raw = (data.data || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(raw, 'base64');
}

async function markAsProcessed(accessToken, messageId, labelId) {
  await gmailPost(accessToken, `/gmail/v1/users/me/messages/${messageId}/modify`, {
    addLabelIds: [labelId]
  });
}

// ── OPENAI SCANNER ──

function extractInvoiceData(buffer, mimeType, filename) {
  return new Promise((resolve, reject) => {
    const isImage = mimeType.startsWith('image/');
    const base64 = buffer.toString('base64');

    const content = isImage
      ? [
          { type: 'text', text: SCAN_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } }
        ]
      : [{ type: 'text', text: `${SCAN_PROMPT}\n\nThis is a PDF named "${filename}". Extract what you can.` }];

    const body = JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 256
    });

    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          const raw = parsed.choices[0].message.content;
          const data = JSON.parse(raw);
          resolve({
            supplier: data.supplier || 'Unknown',
            amount: parseFloat(data.amount) || 0,
            date: data.date || new Date().toISOString().split('T')[0],
            invoice_number: data.invoice_number || null,
            status: 'Processed'
          });
        } catch { resolve({ supplier: 'Unknown', amount: 0, date: new Date().toISOString().split('T')[0], invoice_number: null, status: 'Review' }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const SCAN_PROMPT = `You are an invoice data extraction assistant. Analyze this invoice and extract:
- supplier: company name that issued the invoice
- amount: total amount as a number only (no currency symbol)
- date: invoice date in YYYY-MM-DD format
- invoice_number: invoice or receipt number

Respond with ONLY a JSON object. Example: {"supplier":"Acme Corp","amount":1250.00,"date":"2024-06-15","invoice_number":"INV-00123"}`;

// ── SUPABASE HELPERS ──

async function getConnectedUsers() {
  return supabaseGet(`user_settings?gmail_connected=eq.true&select=user_email,gmail_refresh_token,default_business_name`);
}

async function getDefaultBusiness(userEmail) {
  const data = await supabaseGet(`businesses?user_email=eq.${encodeURIComponent(userEmail)}&order=created_at.asc&limit=1&select=name`);
  return data[0] ? data[0].name : null;
}

async function uploadToSupabase(buffer, mimeType, filename, userEmail) {
  const ext = filename.split('.').pop().toLowerCase();
  const path = `${userEmail}/${Date.now()}.${ext}`;

  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const options = {
      hostname: SB_URL,
      path: `/storage/v1/object/invoices/${path}`,
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': mimeType,
        'Content-Length': buffer.length
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(`https://${SB_URL}/storage/v1/object/public/invoices/${path}`);
        } else {
          reject(new Error(`Storage upload failed: ${d}`));
        }
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function saveInvoiceRecord(invoiceData, userEmail, businessName, fileUrl, sourceEmailId) {
  const date = invoiceData.date ? new Date(invoiceData.date) : new Date();
  const folderYear = date.getFullYear();
  const folderMonth = date.getMonth();

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
    const options = {
      hostname: SB_URL,
      path: `/rest/v1/${endpoint}`,
      method: 'GET',
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Failed to parse Supabase response')); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function supabasePost(table, data) {
  return new Promise((resolve, reject) => {
    const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
    const body = JSON.stringify(data);
    const options = {
      hostname: SB_URL,
      path: `/rest/v1/${table}`,
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
