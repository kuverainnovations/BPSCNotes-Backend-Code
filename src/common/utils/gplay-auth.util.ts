// Shared Google Play Developer API auth bootstrap for the course-catalog
// sync and one-time-product purchase verification utils. Deliberately NOT
// shared with the existing subscription verification code in
// combined-modules-1.module.ts (verifyGPlayPurchase) — that path is
// working today and out of scope for this change; this only consolidates
// duplication across the new gplay-*.util.ts files introduced alongside it.

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set — cannot reach Google Play Developer API`);
  return value;
}

// Returns both the typed androidpublisher client (for endpoints the
// installed googleapis@144 generates, e.g. purchases.products.*) and a raw
// authenticated request client (for endpoints it doesn't generate yet,
// e.g. monetization.onetimeproducts.*, purchases.productsv2.*) — both
// backed by the same credentials, so callers don't juggle two auth setups..
//
// Memoized: a fresh GoogleAuth holds no cached OAuth token, so rebuilding
// per call added a token-endpoint round trip to every Play API request.
// External-transaction reporting now runs on the post-payment path of
// every Cashfree purchase, so the clients are built once and reused (the
// google-auth-library refreshes its token internally on expiry). A failed
// build is not cached, so a bad env var can be fixed without a restart.
let cachedClients: ReturnType<typeof buildPlayAuthClients> | null = null;

export function getPlayAuthClients() {
  if (!cachedClients) {
    cachedClients = buildPlayAuthClients().catch((err) => {
      cachedClients = null;
      throw err;
    });
  }
  return cachedClients;
}

async function buildPlayAuthClients() {
  const serviceAccountJson = requireEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  const packageName        = requireEnv('ANDROID_PACKAGE_NAME');

  let credentials: unknown;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON — check it was pasted as a single line ' +
      'and not truncated or re-escaped when saved into .env'
    );
  }

  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  const androidpublisher = google.androidpublisher({ version: 'v3', auth });
  const rawClient = await auth.getClient();

  return { androidpublisher, rawClient, packageName };
}
