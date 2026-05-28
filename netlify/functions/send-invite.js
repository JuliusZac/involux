const https = require('https');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { to, fromName, fromEmail, businessName } = JSON.parse(event.body);
    if (!to || !fromName || !businessName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };

    const SB_URL = 'https://psockxoyycvctjzigneh.supabase.co';
    const SB_KEY = process.env.SUPABASE_KEY;

    // Create invitation token in Supabase
    const invRes = await supabasePost(SB_URL, SB_KEY, 'invitations', {
      owner_email: fromEmail,
      owner_name: fromName,
      accountant_email: to,
      business_name: businessName
    });

    const invitation = invRes[0];
    if (!invitation) throw new Error('Failed to create invitation');

    const inviteLink = `https://involux.ca/accountant.html?token=${invitation.token}`;

    // Send email via Resend
    const emailRes = await sendEmail(process.env.RESEND_API_KEY, to, fromName, fromEmail, businessName, inviteLink);
    console.log('Resend response:', JSON.stringify(emailRes));

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

function supabasePost(url, key, table, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const opts = {
      hostname: url.replace('https://', ''),
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
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendEmail(apiKey, to, fromName, fromEmail, businessName, inviteLink) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from: 'Involux <noreply@involux.ca>',
      to: [to],
      subject: `${fromName} invited you to view ${businessName} invoices on Involux`,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F7F2EA;font-family:Arial,sans-serif">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
          <tr><td align="center">
            <table width="560" cellpadding="0" cellspacing="0" style="background:white;border-radius:16px;border:1px solid #E6DDD0;overflow:hidden;max-width:560px;width:100%">
              <tr><td style="background:#1C2B1C;padding:28px 36px;text-align:center">
                <span style="font-size:24px;font-weight:600;color:white;letter-spacing:-0.3px">Involux</span>
              </td></tr>
              <tr><td style="padding:40px 36px">
                <p style="font-size:22px;font-weight:600;color:#1C2B1C;margin:0 0 12px">You've been invited</p>
                <p style="font-size:15px;color:#7A8F7A;line-height:1.6;margin:0 0 24px">
                  <strong style="color:#1C2B1C">${fromName}</strong> has given you access to view <strong style="color:#1C2B1C">${businessName}</strong> invoices on Involux.
                </p>
                <div style="background:#F7F2EA;border:1px solid #E6DDD0;border-radius:10px;padding:18px 22px;margin-bottom:28px">
                  <p style="font-size:12px;font-weight:600;color:#7A8F7A;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 6px">Access granted by</p>
                  <p style="font-size:15px;font-weight:500;color:#1C2B1C;margin:0">${fromName}</p>
                  <p style="font-size:13px;color:#7A8F7A;margin:3px 0 0">${fromEmail}</p>
                </div>
                <p style="font-size:14px;color:#7A8F7A;line-height:1.6;margin:0 0 28px">
                  As their accountant, you can view all invoices, check payment status, and export CSV reports. You have read-only access — you cannot upload or modify anything.
                </p>
                <div style="text-align:center;margin-bottom:28px">
                  <a href="${inviteLink}" style="display:inline-block;background:#3D6147;color:white;padding:14px 36px;border-radius:9px;font-size:15px;font-weight:500;text-decoration:none">
                    Access ${businessName} Invoices →
                  </a>
                </div>
                <p style="font-size:12px;color:#9FB09F;line-height:1.6;margin:0">
                  If you weren't expecting this, you can safely ignore this email.
                </p>
              </td></tr>
              <tr><td style="background:#F7F2EA;border-top:1px solid #E6DDD0;padding:18px 36px;text-align:center">
                <p style="font-size:12px;color:#9FB09F;margin:0">© 2026 Involux · involux.ca</p>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body></html>`
    });

    const opts = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
