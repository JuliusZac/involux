const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '367389157668-c8p1c92st9m300ajevpck7gfuo9d33k1.apps.googleusercontent.com';

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

class AuthError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Verifies the Google ID token on an incoming request and returns the
// caller's verified email. Throws AuthError (401) on anything unverifiable —
// callers must not proceed past this without a caught error.
async function verifyRequest(event) {
  const header = event.headers['authorization'] || event.headers['Authorization'] || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!idToken) throw new AuthError(401, 'Missing Authorization header');

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    throw new AuthError(401, `Invalid token: ${err.message}`);
  }

  if (!payload || !payload.email || payload.email_verified !== true) {
    throw new AuthError(401, 'Token missing a verified email');
  }

  return { email: payload.email };
}

module.exports = { verifyRequest, AuthError };
