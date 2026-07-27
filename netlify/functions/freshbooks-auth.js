const APP_URL      = 'https://involux.ca';
const AUTH_URL     = 'https://auth.freshbooks.com/oauth/authorize';
const REDIRECT_URI = 'https://involux.ca/.netlify/functions/freshbooks-callback';
const SCOPES       = 'user:profile:read user:expenses:read user:bills:read user:bills:write user:bill_vendors:read user:bill_vendors:write user:bill_payments:write';

exports.handler = async (event) => {
  const clientId = process.env.FRESHBOOKS_CLIENT_ID;

  if (!clientId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FreshBooks environment variables not configured' }) };
  }

  const { business_id } = event.queryStringParameters || {};
  if (!business_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing business_id parameter' }) };
  }

  const state = Buffer.from(JSON.stringify({ business_id })).toString('base64');

  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
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
