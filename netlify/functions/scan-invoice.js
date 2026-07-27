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
  "payment_confirmation_present": true or false — see PAYMENT SIGNAL RULES below,
  "has_payment_terms": true or false — see PAYMENT SIGNAL RULES below,
  "category": "single best category: Meals & Entertainment, Office Supplies, Travel, Utilities, Equipment, Software, Marketing, Professional Services, Shipping, Groceries, Fuel, Healthcare, Repairs & Maintenance, Other",
  "currency": "3-letter ISO currency code — look for $, USD, CAD, EUR, GBP, CHF, AUD, MXN, or any currency symbol/code on the document — default to CAD if none found",
  "xero_account_code": null,
  "xero_account_name": null,
  "qb_account_name": null,
  "line_items": [
    {"description": "exact item or service name", "quantity": 1, "unit_price": 9.99, "total": 9.99, "qb_account_name": null, "xero_account_code": null, "xero_account_name": null}
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
- qb_account_name on each line item: leave null unless a QUICKBOOKS ACCOUNT SELECTION section appears later in this prompt — if it does, set it to that specific line item's best-matching account from the list provided there (see rules below)
- xero_account_code / xero_account_name on each line item: leave both null unless a XERO ACCOUNT SELECTION section appears later in this prompt — if it does, set them to that specific line item's best-matching account (code and name) from the list provided there (see rules below)

PAYMENT SIGNAL RULES — extract these two signals INDEPENDENTLY of each other. Do not try to combine
them into one paid/unpaid decision yourself — the system combines them deterministically afterward.
A document can have neither signal, one, or (rarely) both.

1. "payment_confirmation_present": true if the document shows explicit proof a payment was already
   completed — "PAIEMENT REÇU", "PAYMENT RECEIVED", "PAID", "APPROVED", a completed card-transaction
   line such as "VISA - Achat", "VISA - Purchase", "DEBIT - APPROVED", "MASTERCARD - APPROVED", or a
   plain tender line on a checkout receipt such as "Cash", "Debit", "Visa", "Mastercard" — a receipt
   showing HOW the customer paid at the register is itself proof the transaction is complete, even
   without the word "approved" or "paid" next to it. Otherwise false.
2. "has_payment_terms": true if the document contains invoice/billing language that asks to be paid
   LATER rather than confirming payment already happened — "Net 15", "Net 30", "please remit payment",
   "balance due", "payment due upon receipt", "terms: ...", or similar. Otherwise false.

Judge each signal only from what's literally on the document. When genuinely unsure about either one,
set it to false rather than guessing true.

GENERAL RULES:
- All numbers must be plain numerics — no $ signs, no commas
- Never guess a value you cannot see — use null
- vendor_name must be the complete full name, never truncated
- total must never be null
- Return ONLY the JSON object, nothing else`;

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

// requireXero/requireQb: when an account list was offered in the prompt, an attempt
// that omits xero_account_code/qb_account_name is NOT "good enough" even if its other
// fields score well — scoreResult() alone never checked this, so a single attempt that
// dropped account categorization (a real risk in a long, compound prompt) used to get
// accepted immediately with zero retry pressure to fix it.
async function retryingScan(scanFn, requireXero = false, requireQb = false) {
  let best = null, bestScore = -1, bestCategorized = false;
  for (let attempt = 1; attempt <= MAX_SCAN_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS);
    try {
      const result = await scanFn(attempt);
      const score  = scoreResult(result);
      const xeroOk = !requireXero || Boolean(result?._rawXeroCode);
      const qbOk   = !requireQb   || Boolean(result?._rawQbName);
      const categorized = xeroOk && qbOk;
      console.log(`[scan] attempt=${attempt} score=${score} categorized=${categorized} (xeroOk=${xeroOk} qbOk=${qbOk}) supplier="${result?.supplier}" amount=${result?.amount}`);
      if (score > bestScore || (score === bestScore && categorized && !bestCategorized)) {
        best = result; bestScore = score; bestCategorized = categorized;
      }
      if (score >= GOOD_ENOUGH_SCORE && categorized) {
        console.log(`[scan] good result on attempt ${attempt} — stopping early`);
        break;
      }
    } catch (e) {
      console.error(`[scan] attempt ${attempt} threw:`, e.message);
    }
  }
  console.log(`[scan] final best score=${bestScore} categorized=${bestCategorized}`);
  return best || { supplier: 'Unknown', date: new Date().toISOString().split('T')[0], amount: 0, status: 'Review' };
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

const XERO_ACCOUNT_GUIDE = `310 — Cost of Goods Sold (Direct Costs): Official Xero description: "Cost of goods sold by the business." Raw materials/inventory purchased for resale or used directly in producing what the business sells — e.g. raw ingredients for a restaurant, inventory for a retailer. Use this over a general expense account whenever the purchase is food/materials that go directly into what the business sells.
400 — Advertising: Official Xero description: "Expenses incurred for advertising while trying to increase sales." Includes promotional/marketing materials (banners, decals, signage, business cards used for networking/marketing). Does NOT include routine office paperwork or printing — see 461 for that, even for the same vendor.
404 — Bank Fees: Official Xero description: "Fees charged by your bank for transactions regarding your bank account(s)." Bank-charged transaction fees only — never merchandise or services.
408 — Cleaning: Official Xero description: "Expenses incurred for cleaning business property." Cleaning services/supplies for business property only.
412 — Consulting & Accounting: Official Xero description: "Expenses related to paying consultants." Payments to consultants, accountants, bookkeepers.
416 — Depreciation: Official Xero description: "The amount of the asset's cost (based on the useful life) that was consumed during the period." Non-cash depreciation entries only — never an actual purchase invoice.
420 — Entertainment: Official Xero description: "Expenses paid by company for the business but are not deductable for income tax purposes." Client/staff entertainment, event tickets, hosting. Distinct from ordinary staff meals.
425 — Freight & Courier: Official Xero description: "Expenses incurred on courier & freight costs." Shipping/delivery/courier costs only — not the goods being shipped.
429 — General Expenses: Official Xero description: "General expenses related to the running of the business." Last-resort only — use only if nothing else genuinely fits. Do not default here just because a purchase is ambiguous; try harder to match a specific account first.
433 — Insurance: Official Xero description: "Expenses incurred for insuring the business' assets." Business insurance premiums only.
437 — Interest Expense: Official Xero description: "Any interest expenses paid to your tax authority, business bank accounts or credit card accounts." Never an actual purchase.
441 — Legal expenses: Official Xero description: "Expenses incurred on any legal matters." Lawyer/legal service fees only.
445 — Light, Power, Heating: Official Xero description: "Expenses incurred for lighting, powering or heating the premises." Utility bills only — not phone/internet (see 489).
449 — Motor Vehicle Expenses: Official Xero description: "Expenses incurred on the running of company motor vehicles." Fuel, oil changes, tires, repairs, registration, parking. Never mistake this for an equipment rental.
453 — Office Expenses: Official Xero description: "General expenses related to the running of the business office." Day-to-day office running costs NOT covered by a more specific account — e.g. coffee/kitchen supplies, cleaning consumables, small miscellaneous office purchases. Does NOT include printing, paper, ink/toner cartridges, envelopes, notepads, pens, or any other stationery item — those ALWAYS belong in Printing & Stationery (461) instead, even when bought from an office-supply store alongside other office items, and even if the vendor's invoice itself is titled "office supplies."
461 — Printing & Stationery: Official Xero description: "Expenses incurred by the entity as a result of printing and stationery." This covers ALL printing and stationery costs: print jobs, printer paper, ink/toner cartridges, envelopes, notepads, pens, folders, labels, and any other stationery item — whether for internal office use or client-facing documents. Do not route these to Office Expenses (453) just because they were bought at an office-supply retailer. The only exception: printed materials made specifically for marketing/promotion (banners, business cards, flyers, signage) belong in Advertising (400) instead.
469 — Rent: Official Xero description: "The payment to lease a building or area." Lease payment for premises only.
473 — Repairs and Maintenance: Official Xero description: "Expenses incurred on a damaged or run down asset that will bring the asset back to its original condition." Repairs restoring a damaged/worn asset (building, equipment — not vehicle, see 449). Never a purchase of a new asset.
477 — Wages and Salaries: Official Xero description: "Payment to employees in exchange for their resources." Payroll only — never an outside vendor invoice.
478 — Superannuation: Official Xero description: "Superannuation contributions." Payroll-related only — never an outside vendor invoice.
485 — Subscriptions: Official Xero description: "E.g. Magazines, professional bodies." Recurring memberships, magazines, professional bodies, software/SaaS subscriptions.
489 — Telephone & Internet: Official Xero description: "Expenditure incurred from any business-related phone calls, phone lines, or internet connections."
493 — Travel - National: Official Xero description: "Expenses incurred from domestic travel which has a business purpose." Flights, hotels, transportation — not vehicle running costs (449) and not meals (420).
494 — Travel - International: Official Xero description: "Expenses incurred from international travel which has a business purpose." Same distinction as 493, for trips outside the country.`;

const XERO_CRITICAL_RULES = `CRITICAL RULES TO PREVENT PAST ERRORS:
- Never select an account just because a keyword (e.g. "equipment", "printing", "rental") appears in
  the line item text — verify the actual transaction type matches the account's true purpose. A
  one-time equipment PURCHASE is never a rental account without explicit rental/lease terms (a rental
  period, a daily/weekly rate, a return date).
- When multiple line items on the same invoice serve the same underlying business purpose, categorize
  them consistently under the same account rather than splitting them apart based on superficial
  wording differences — differentiate by genuine business purpose, not by vocabulary.
- Only use 429 — General Expenses when no other account genuinely fits. Do not default there just
  because a purchase is ambiguous — try harder to match a specific account first.
- Never select 505 — Income Tax Expense, or any Revenue, Asset, Liability, or Equity account — none
  of these apply to a purchase/expense line item, and none of them appear in the list below on purpose.
- Printing, paper, ink/toner, and stationery items go to 461 — Printing & Stationery, NEVER to 453 —
  Office Expenses, even when the vendor is a general office-supply store and even when the invoice
  itself is labeled "office supplies." Past error: a printing/stationery purchase was miscategorized
  as Office Expenses instead of Printing & Stationery — do not repeat this.`;

function buildPrompt(xeroAccounts, qbAccounts) {
  let prompt = SCAN_PROMPT;
  if (xeroAccounts && xeroAccounts.length) {
    prompt += `

XERO ACCOUNT SELECTION — required when this section is present:
Select the single best-matching expense account for this document as a whole from the list below.
Return two additional top-level fields in your JSON:
  "xero_account_code": "the exact code from the list below — the best overall account for this invoice",
  "xero_account_name": "the account name exactly as listed below"
Default to 429 — General Expenses if nothing else fits.

ALSO select an account for EACH INDIVIDUAL line item, independently of the invoice-level account above.
Do NOT copy the invoice-level "xero_account_code"/"xero_account_name" onto every line item — that
defeats the purpose of line-level categorization and is treated as an error. For every object in the
"line_items" array, look ONLY at that line's own description (ignore what you picked for the other
lines and for the invoice overall) and set that object's "xero_account_code" and "xero_account_name"
to the single best-matching account for THAT description alone, from the same list below.

Different line items on the same invoice frequently belong to different accounts, even when they're
from the same vendor or the same type of business. For example, on a law firm invoice: a "Retainer
Fee" or "Contract Review Services" line is legal work → Legal expenses; a separate "Filing Fee",
"Incorporation Filing Assistance", "Disbursement", or government/permit charge is NOT the lawyer's own
labor → match it to a more fitting account instead if one exists in the list (e.g. Consulting &
Accounting, General Expenses), even though it's on the same invoice from the same law firm. Judge
every line on its own wording — never assume two lines share an account just because they're on the
same document.
Default to 429 — General Expenses for any single line item that doesn't clearly fit elsewhere.
${ACCOUNT_SELECTION_RULES}

${XERO_ACCOUNT_GUIDE}

${XERO_CRITICAL_RULES}`;
  }
  if (qbAccounts && qbAccounts.length) {
    const accountList = qbAccounts.map(a => a.name).join('\n');
    prompt += `

QUICKBOOKS ACCOUNT SELECTION — required when this section is present:
Select the single best-matching expense account for this invoice as a whole from the list below.
Return one additional top-level field in your JSON:
  "qb_account_name": "the account name exactly as listed below — the best overall account for this invoice"
Default to "Uncategorized Expense" if nothing else fits.

ALSO select an account for EACH INDIVIDUAL line item, independently of the invoice-level account above.
Do NOT copy the invoice-level "qb_account_name" onto every line item — that defeats the purpose of
line-level categorization and is treated as an error. For every object in the "line_items" array,
look ONLY at that line's own description (ignore what you picked for the other lines and for the
invoice overall) and set that object's "qb_account_name" to the single best-matching account for THAT
description alone, from the same list below.

Different line items on the same invoice frequently belong to different accounts, even when they're
from the same vendor or the same type of business. For example, on a law firm invoice: a "Retainer
Fee" or "Contract Review Services" line is legal work → a legal/professional-fees account; a separate
"Filing Fee", "Incorporation Filing Assistance", "Disbursement", or government/permit charge is NOT
the lawyer's own labor → match it to a permits/filing/disbursements account instead if one exists in
the list, even though it's on the same invoice from the same law firm. Judge every line on its own
wording — never assume two lines share an account just because they're on the same document.
Default to "Uncategorized Expense" for any single line item that doesn't clearly fit elsewhere.
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
    console.log(`[scan] business_id=${business_id || 'none'} xeroAccounts=${xeroAccounts.length} qbAccounts=${qbAccounts.length}`);

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
      qb_payment_status:   extracted.qb_payment_status || null,
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
    return parseResult(raw, xeroAccounts.length > 0, qbAccounts.length > 0);
  }, xeroAccounts.length > 0, qbAccounts.length > 0);
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
      return parseResult(await callOpenAI(body), xeroAccounts.length > 0, qbAccounts.length > 0);
    }, xeroAccounts.length > 0, qbAccounts.length > 0);
  }

  // Scanned PDF — upload to OpenAI files API (retries handled inside)
  return await scanScannedPdf(buffer, basePrompt, retryNote, xeroAccounts.length > 0, qbAccounts.length > 0);
}

async function scanScannedPdf(buffer, basePrompt = SCAN_PROMPT, retryNote = '', requireXero = false, requireQb = false) {
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
    if (!fileId) { console.error(`[scan] scanned PDF upload failed — status=${uploadRes.status} body=${JSON.stringify(fileData)}`); return parseResult('{}', requireXero, requireQb); }
  } catch (e) {
    console.error('[scan] scanned PDF upload error:', e.message);
    return parseResult('{}', requireXero, requireQb);
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
      return parseResult(raw || '{}', requireXero, requireQb);
    }, requireXero, requireQb);
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

// Combines GPT's independently-extracted signals into the final paid/unpaid decision.
// Kept as deterministic code (not trusted from a single GPT-summarized boolean) so it's
// auditable and can't silently drift from what the raw signals actually say.
function resolvePaymentConfirmed(data, invoiceDate) {
  const dueDate = data.due_date || null;
  const dueDateBlocksIt = dueDate != null && dueDate !== invoiceDate; // due date later (or earlier) than invoice date
  const confirmationPresent = data.payment_confirmation_present === true;
  const hasPaymentTerms     = data.has_payment_terms === true;

  const confirmed = confirmationPresent && !hasPaymentTerms && !dueDateBlocksIt;

  console.log(`[scan] payment signals — confirmation_present=${confirmationPresent} has_payment_terms=${hasPaymentTerms} invoice_date=${invoiceDate} due_date=${dueDate || 'none'} due_date_blocks=${dueDateBlocksIt} => payment_confirmed=${confirmed}`);

  return confirmed;
}

const FALLBACK_XERO_CODE = '429';
const FALLBACK_XERO_NAME = 'General Expenses';
const FALLBACK_QB_NAME   = 'Uncategorized Expense';

function parseResult(content, xeroRequested = false, qbRequested = false) {
  try {
    const clean = content.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);
    const today = new Date().toISOString().split('T')[0];
    const total = parseFloat(data.total) || 0;
    const invoiceDate = data.date || today;
    const paymentConfirmed = resolvePaymentConfirmed(data, invoiceDate);

    const rawLineItems = Array.isArray(data.line_items) ? data.line_items : [];
    const rawXeroCode = data.xero_account_code ? String(data.xero_account_code) : null;
    const rawQbName   = data.qb_account_name || null;
    console.log(`[scan] xero categorization — invoice_level_code=${rawXeroCode || 'none'} invoice_level_name=${data.xero_account_name || 'none'} line_items_with_own_code=${rawLineItems.filter(li => li.xero_account_code).length}/${rawLineItems.length}`);
    console.log(`[scan] qb categorization — invoice_level_name=${rawQbName || 'none'} line_items_with_own_name=${rawLineItems.filter(li => li.qb_account_name).length}/${rawLineItems.length}`);
    rawLineItems.forEach((li, i) => console.log(`[scan] line_item[${i}] "${li.description || ''}" — raw xero_account_code=${li.xero_account_code || 'none'} xero_account_name=${li.xero_account_name || 'none'} qb_account_name=${li.qb_account_name || 'none'}`));

    // GPT is told to default to a fallback account when nothing else fits, but doesn't
    // always comply — guarantee a non-blank category whenever categorization was actually
    // requested (xeroRequested/qbRequested), so the details view never shows a blank
    // Category for a connected business, even if every retry attempt came back empty.
    const xeroAccountCode = rawXeroCode || (xeroRequested ? FALLBACK_XERO_CODE : null);
    const xeroAccountName = data.xero_account_name || (xeroRequested ? FALLBACK_XERO_NAME : null);
    const qbAccountName   = rawQbName   || (qbRequested   ? FALLBACK_QB_NAME   : null);

    return {
      // Fields saved to Supabase invoices table
      supplier: data.vendor_name || 'Unknown',
      date: invoiceDate,
      due_date: data.due_date || null,
      amount: total,
      invoice_number: data.receipt_number || null,
      status: 'Processed',
      subtotal: data.subtotal != null ? parseFloat(data.subtotal) : null,
      taxes: Array.isArray(data.taxes) && data.taxes.length ? data.taxes.map(t=>({label:t.label,amount:parseFloat(t.amount)})).filter(t=>t.label&&t.amount) : null,
      payment_method:    data.payment_method || null,
      category:          data.category || null,
      // Line items inherit the (now guaranteed-non-blank) invoice-level account whenever
      // GPT didn't set their own — every line always shows a category.
      line_items:        rawLineItems.length ? rawLineItems.map(li => ({
        ...li,
        qb_account_name:   li.qb_account_name   || qbAccountName,
        xero_account_code: li.xero_account_code || xeroAccountCode,
        xero_account_name: li.xero_account_name || xeroAccountName,
      })) : null,
      currency:             /^[A-Z]{3}$/.test(data.currency) ? data.currency : 'CAD',
      xero_account_code:    xeroAccountCode,
      xero_account_name:    xeroAccountName,
      xero_payment_status:  paymentConfirmed ? 'PAID' : null,
      qb_account_name:      qbAccountName,
      qb_payment_status:    paymentConfirmed ? 'PAID' : null,
      // Internal only — not persisted (updateSupabase whitelists fields) — lets
      // retryingScan tell a genuine GPT categorization apart from our fallback.
      _rawXeroCode: rawXeroCode,
      _rawQbName:   rawQbName,
    };
  } catch {
    return { supplier: 'Unknown', date: new Date().toISOString().split('T')[0], amount: 0, invoice_number: null, status: 'Review' };
  }
}

// ── XERO ACCOUNTS ──

const XERO_EXPENSE_ACCOUNTS = [
  { code: '310', name: 'Cost of Goods Sold' },
  { code: '400', name: 'Advertising' },
  { code: '404', name: 'Bank Fees' },
  { code: '408', name: 'Cleaning' },
  { code: '412', name: 'Consulting & Accounting' },
  { code: '416', name: 'Depreciation' },
  { code: '420', name: 'Entertainment' },
  { code: '425', name: 'Freight & Courier' },
  { code: '429', name: 'General Expenses' },
  { code: '433', name: 'Insurance' },
  { code: '437', name: 'Interest Expense' },
  { code: '441', name: 'Legal expenses' },
  { code: '445', name: 'Light, Power, Heating' },
  { code: '449', name: 'Motor Vehicle Expenses' },
  { code: '453', name: 'Office Expenses' },
  { code: '461', name: 'Printing & Stationery' },
  { code: '469', name: 'Rent' },
  { code: '473', name: 'Repairs and Maintenance' },
  { code: '477', name: 'Wages and Salaries' },
  { code: '478', name: 'Superannuation' },
  { code: '485', name: 'Subscriptions' },
  { code: '489', name: 'Telephone & Internet' },
  { code: '493', name: 'Travel - National' },
  { code: '494', name: 'Travel - International' },
];

function fetchXeroAccounts() {
  return Promise.resolve(XERO_EXPENSE_ACCOUNTS);
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
