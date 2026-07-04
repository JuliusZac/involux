const APP_URL = 'https://involux.ca';
const INTUIT_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

exports.handler = async (event) => {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'QuickBooks environment variables not configured' }),
    };
  }

  // Pass business_id through state so callback knows which business to link
  const { business_id } = event.queryStringParameters || {};
  if (!business_id) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing business_id parameter' }),
    };
  }

  // state is base64-encoded JSON so we can round-trip arbitrary data safely
  const state = Buffer.from(JSON.stringify({ business_id })).toString('base64');

  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    prompt: 'login',
  });

  const authUrl = `${INTUIT_AUTH_URL}?${params.toString()}`;

  return {
    statusCode: 302,
    headers: { Location: authUrl },
    body: '',
  };
};
