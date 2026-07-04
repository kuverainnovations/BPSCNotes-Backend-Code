// One-off connectivity check for Google Play Billing configuration —
// NOT part of the app (no controller/module imports this), same standalone-
// script pattern as src/database/seeds/run-seeds.ts. Safe to run repeatedly;
// makes exactly one read-only Play Developer API call, writes nothing.
//
// Run in production (inside the running api container, env vars already
// present via docker-compose's env_file):
//   docker compose exec api node dist/scripts/verify-gplay-auth.js
//
// Run locally against a local .env (dev):
//   npx ts-node -r tsconfig-paths/register src/scripts/verify-gplay-auth.ts

import { getPlayAuthClients, requireEnv } from '../common/utils/gplay-auth.util';

async function main() {
  console.log('── Google Play Billing config check ──');

  // 1. Presence + JSON validity (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
  // ANDROID_PACKAGE_NAME) — getPlayAuthClients() throws a clear error here
  // if either is missing or the JSON is malformed.
  const { androidpublisher, packageName } = await getPlayAuthClients();
  console.log(`✓ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON parses and ANDROID_PACKAGE_NAME is set: ${packageName}`);

  // 2. GOOGLE_PLAY_REGIONS_VERSION — only required for catalog writes
  // (course/material approval sync), not for this read-only check, but
  // confirmed present here since it's one of the 3 required variables.
  const regionsVersion = requireEnv('GOOGLE_PLAY_REGIONS_VERSION');
  console.log(`✓ GOOGLE_PLAY_REGIONS_VERSION is set: ${regionsVersion}`);

  // 3. Actual round-trip to Google — proves the service account is not just
  // well-formed but genuinely authenticates and is linked to this app in
  // Play Console. inappproducts.list is read-only and safe to call even
  // with zero legacy in-app products defined (returns an empty list, not
  // an error) — it exists on every androidpublisher API version, unlike
  // the newer monetization.onetimeproducts endpoints this app also uses.
  try {
    const res = await androidpublisher.inappproducts.list({ packageName });
    const count = res.data.inappproduct?.length ?? 0;
    console.log(`✓ Authenticated with Google Play Developer API — reached package "${packageName}" (${count} legacy in-app product(s) listed).`);
    console.log('\nAll three variables are configured correctly and auth works end-to-end.');
  } catch (e: any) {
    const detail = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || e);
    console.error(`✗ Google rejected the request: ${detail}`);
    console.error(
      '\nCommon causes: the service account is not linked to this app in Play Console ' +
      '(Setup > API access), ANDROID_PACKAGE_NAME does not match the app it\'s linked to, ' +
      'or the service account is missing the "View financial data" / basic access permission.'
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message || e}`);
  process.exitCode = 1;
});
