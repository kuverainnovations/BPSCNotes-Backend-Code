import { Controller, Get, Header, Module } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/guards';

/**
 * Digital Asset Links, served by the API rather than from a file.
 *
 * Android verifies App Links by fetching
 *   https://<host>/.well-known/assetlinks.json
 * over HTTPS, expecting 200, application/json, and no redirect.
 *
 * The obvious home for that is the main site, but bpscnotes.in is on
 * WordPress.com, which will not serve arbitrary files on the current plan.
 * api.bpscnotes.in is ours, already has a certificate and an nginx server
 * block, so the share links point there instead and this route answers the
 * verification fetch. nginx maps /.well-known/assetlinks.json onto it.
 *
 * Serving it from code rather than a mounted file means it ships with a
 * deploy — no volume to add to the nginx container, nothing to forget.
 *
 * ── Fingerprints ──────────────────────────────────────────────────────
 * APP_LINKS_FINGERPRINTS, comma-separated, overrides the default below.
 *
 * The default is the UPLOAD key, read from the repo's keystore. It is
 * enough to verify a locally built release APK, and NOT enough for anything
 * installed from Play: Google re-signs the app with its own key first. The
 * Play App Signing SHA-256 (Play Console > Setup > App integrity) must be
 * added to that env var, keeping both values, or links will open the
 * browser for every real user while working perfectly on your test device.
 */
const UPLOAD_KEY_SHA256 =
  'CF:A5:06:CE:9D:33:9A:BF:8F:B4:5F:C3:AE:DD:41:51:59:B1:7A:17:A4:2E:20:54:6D:13:0A:95:79:23:58:7C';

const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || 'com.bpscnotes.eduapp';

function fingerprints(): string[] {
  const raw = process.env.APP_LINKS_FINGERPRINTS || '';
  const parsed = raw
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f));

  // A malformed env var must not produce an empty or invalid list — an
  // unparseable assetlinks.json fails verification for every host at once.
  return parsed.length ? parsed : [UPLOAD_KEY_SHA256];
}

@ApiExcludeController()
@Controller('app-links')
export class AppLinksController {
  @Public()
  @Get('assetlinks.json')
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=300')
  assetLinks() {
    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: PACKAGE_NAME,
          sha256_cert_fingerprints: fingerprints(),
        },
      },
    ];
  }
}

@Module({ controllers: [AppLinksController] })
export class AppLinksModule {}
