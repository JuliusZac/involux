const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async (req, res) => {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, fromName, fromEmail } = req.body;

  if (!to || !fromName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const data = await resend.emails.send({
      from: 'Involux <noreply@involux.ca>',
      to: [to],
      subject: `${fromName} invited you to view their invoices on Involux`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background:#F7F9FF;font-family:'DM Sans',Arial,sans-serif">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FF;padding:40px 20px">
            <tr>
              <td align="center">
                <table width="560" cellpadding="0" cellspacing="0" style="background:white;border-radius:16px;border:1px solid #E4E8F5;overflow:hidden;max-width:560px;width:100%">
                  
                  <!-- Header -->
                  <tr>
                    <td style="background:#0B1229;padding:28px 36px;text-align:center">
                      <span style="font-size:24px;font-weight:600;color:white;letter-spacing:-0.3px">
                        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#1847F0;margin-right:8px;vertical-align:middle"></span>
                        Involux
                      </span>
                    </td>
                  </tr>

                  <!-- Body -->
                  <tr>
                    <td style="padding:40px 36px">
                      <p style="font-size:22px;font-weight:600;color:#0B1229;margin:0 0 12px">You've been invited 🎉</p>
                      <p style="font-size:16px;color:#4A5578;line-height:1.6;margin:0 0 28px">
                        <strong style="color:#0B1229">${fromName}</strong> has invited you to view their invoices and financial data on <strong style="color:#0B1229">Involux</strong> — an AI-powered invoice management platform.
                      </p>

                      <div style="background:#F7F9FF;border:1px solid #E4E8F5;border-radius:10px;padding:20px 24px;margin-bottom:28px">
                        <p style="font-size:13px;font-weight:600;color:#4A5578;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px">Invited by</p>
                        <p style="font-size:16px;font-weight:500;color:#0B1229;margin:0">${fromName}</p>
                        <p style="font-size:14px;color:#4A5578;margin:4px 0 0">${fromEmail}</p>
                      </div>

                      <p style="font-size:15px;color:#4A5578;line-height:1.6;margin:0 0 28px">
                        As their accountant, you'll be able to view organized invoices, categorized expenses, and export-ready financial reports — all in one clean dashboard.
                      </p>

                      <div style="text-align:center;margin-bottom:28px">
                        <a href="https://involux.ca" style="display:inline-block;background:#1847F0;color:white;padding:14px 36px;border-radius:9px;font-size:16px;font-weight:500;text-decoration:none">
                          Access Involux →
                        </a>
                      </div>

                      <p style="font-size:13px;color:#9AA5C2;line-height:1.6;margin:0">
                        If you weren't expecting this invite, you can safely ignore this email.
                      </p>
                    </td>
                  </tr>

                  <!-- Footer -->
                  <tr>
                    <td style="background:#F7F9FF;border-top:1px solid #E4E8F5;padding:20px 36px;text-align:center">
                      <p style="font-size:12px;color:#9AA5C2;margin:0">
                        © 2026 Involux · <a href="https://involux.ca" style="color:#1847F0;text-decoration:none">involux.ca</a>
                      </p>
                    </td>
                  </tr>

                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
    });

    return res.status(200).json({ success: true, id: data.id });
  } catch (error) {
    console.error('Email error:', error);
    return res.status(500).json({ error: 'Failed to send email', details: error.message });
  }
};
