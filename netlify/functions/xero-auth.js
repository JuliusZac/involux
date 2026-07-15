const APP_URL     = 'https://involux.ca';
const AUTH_URL    = 'https://login.xero.com/identity/connect/authorize';
const REDIRECT_URI = 'https://involux.ca/.netlify/functions/xero-callback';
const SCOPES      = 'accounting.contacts accounting.invoices accounting.payments offline_access';

exports.handler = async (event) => {
  const clientId = process.env.XERO_CLIENT_ID;

  if (!clientId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Xero environment variables not configured' }) };
  }

  const { business_id } = event.queryStringParameters || {};
  if (!business_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing business_id parameter' }) };
  }

  const state = Buffer.from(JSON.stringify({ business_id })).toString('base64');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES,
    state,
  });

  return {
    statusCode: 302,
    headers: { Location: `${AUTH_URL}?${params.toString()}` },
    body: '',
  };
};
