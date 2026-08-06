const ALLOWED_ORIGIN = 'https://involux.ca';

function corsHeaders(methods = 'GET, POST, PATCH, DELETE, OPTIONS') {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': methods,
  };
}

function json(statusCode, body, methods) {
  return {
    statusCode,
    headers: { ...corsHeaders(methods), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function originOk(event) {
  const origin = event.headers['origin'] || event.headers['referer'] || '';
  return origin.startsWith(ALLOWED_ORIGIN);
}

module.exports = { ALLOWED_ORIGIN, corsHeaders, json, originOk };
