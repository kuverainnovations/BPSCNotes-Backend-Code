// Google Play catalog sync for one-time course products.
//
// Keeps a Play "one-time product" in lockstep with a course's price/title
// whenever admin creates or edits a paid course, so nobody ever has to
// touch Play Console by hand. One course <-> one product, id derived
// deterministically from the course id (see gplayProductIdForCourse).
//
// Auth bootstrap lives in gplay-auth.util.ts, shared with
// gplay-purchase.util.ts — not shared with the existing subscription
// verification code in combined-modules-1.module.ts (verifyGPlayPurchase),
// which stays untouched and out of scope here.
//
// Requires three env vars, all currently unset in this deployment:
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON — full service-account key JSON
//   ANDROID_PACKAGE_NAME             — the real applicationId registered
//                                       in Play Console (verify this —
//                                       see memory/project_crit02_package)
//   GOOGLE_PLAY_REGIONS_VERSION      — the current regions-catalog version
//                                       string Play expects on every write;
//                                       check the latest value at
//                                       https://support.google.com/googleplay/android-developer/answer/10532353
//                                       before deploying, and again if Play
//                                       ever rejects writes with a stale-
//                                       regionsVersion error.

import { getPlayAuthClients, requireEnv } from './gplay-auth.util';

export interface CourseForSync {
  id: string;
  title: string;
  description?: string | null;
  price: number;
  isPaid: boolean;
}

// Play product IDs: must start with a lowercase letter/number, and contain
// only [a-z0-9_.] — no hyphens. Stripping the UUID's hyphens keeps this
// deterministic and under the 40-char limit (course_ + 32 hex = 39 chars).
export function gplayProductIdForCourse(courseId: string): string {
  return `course_${courseId.replace(/-/g, '')}`;
}

const PURCHASE_OPTION_ID = 'buy';

// The installed googleapis (144.0.0) generated client predates Play's
// one-time-products API — androidpublisher.monetization.onetimeproducts
// doesn't exist in its types or its runtime methods (checked directly:
// zero references in node_modules/googleapis/build/.../androidpublisher/v3.*).
// Upgrading that shared dependency is out of scope here — the existing
// subscription verification code (combined-modules-1.module.ts) depends on
// the same package and isn't part of this change. So this calls the REST
// endpoint directly through the raw authenticated client instead of the
// generated wrapper; functionally identical, just not type-generated yet.

// Upserts the Play product for a course. Returns the product id that was
// synced, or null if the course isn't a paid course (nothing to sync — a
// free course has no business having a Play product at all).
//
// Does NOT throw on failure — catalog sync is best-effort, same resilience
// pattern as sendCourseNotification() elsewhere in this module. A Play API
// outage or missing config must never block an admin from saving a course;
// it just means the course isn't purchasable via Play yet, and Cashfree
// (debug builds) is completely unaffected either way. Caller should log
// the returned null distinctly from "not paid" if it wants to surface a
// sync-failed state — for now this just logs to console.
export async function syncCourseToPlayCatalog(course: CourseForSync): Promise<string | null> {
  if (!course.isPaid || !course.price || course.price <= 0) return null;

  const productId = gplayProductIdForCourse(course.id);

  try {
    const { rawClient, packageName } = await getPlayAuthClients();
    const regionsVersion = requireEnv('GOOGLE_PLAY_REGIONS_VERSION');

    const units = Math.floor(course.price);
    const nanos = Math.round((course.price - units) * 1_000_000_000);

    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/onetimeproducts/${encodeURIComponent(productId)}`;

    await rawClient.request({
      url,
      method: 'PATCH',
      params: { allowMissing: true, 'regionsVersion.version': regionsVersion },
      data: {
        packageName,
        productId,
        listings: [
          {
            languageCode: 'en-US',
            title: course.title.slice(0, 55),
            description: (course.description || course.title).slice(0, 200),
          },
        ],
        purchaseOptions: [
          {
            purchaseOptionId: PURCHASE_OPTION_ID,
            // legacyCompatible: the installed Android client (billing-ktx
            // 7.1.1) predates the multi-purchase-option model and only ever
            // reads ProductDetails.getOneTimePurchaseOfferDetails() (singular,
            // no offer token) — that method only returns a purchase option
            // flagged legacy-compatible. The first "buy" option is marked
            // this way automatically, but this is set explicitly since it's
            // the only purchase option this app will ever create per course
            // and correctness here shouldn't depend on implicit ordering.
            buyOption: { legacyCompatible: true },
            regionalPricingAndAvailabilityConfigs: [
              {
                regionCode: 'IN',
                price: { currencyCode: 'INR', units: String(units), nanos },
                availability: 'AVAILABLE',
              },
            ],
          },
        ],
      },
    });

    return productId;
  } catch (e: any) {
    const detail = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || e);
    console.error(`Play catalog sync failed for course ${course.id}:`, detail);
    return null;
  }
}
