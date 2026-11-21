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
      params: {
        allowMissing: true,
        'regionsVersion.version': regionsVersion,
        // Required by the API even when allowMissing creates the product
        // (it's ignored on create, enforced on update). Must list ≥1 path
        // or Google rejects with "update_mask must contain at least one
        // path". These are the only fields this sync ever writes.
        updateMask: 'listings,purchaseOptions',
      },
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

// ── Study materials marketplace — same sync, applied to materials ──────
// A material's price is settled through admin approval or negotiation
// (adminApprove / respondToNegotiation / adminFinalDecision in
// study-materials.module.ts), not a stable admin-authored catalog price
// like courses — so this is called from each of those price-finalizing
// call sites instead of a single create/edit handler. Same best-effort,
// never-throws contract as syncCourseToPlayCatalog.
export interface MaterialForSync {
  id: string;
  title: string;
  description?: string | null;
  price: number;
}

// "mat_" (not "material_") — Play product ids allow only [a-z0-9_.], max
// 40 chars, and "material_" + 32-hex-uuid is 41 chars, one over the limit.
export function gplayProductIdForMaterial(materialId: string): string {
  return `mat_${materialId.replace(/-/g, '')}`;
}

export async function syncMaterialToPlayCatalog(material: MaterialForSync): Promise<string | null> {
  if (!material.price || material.price <= 0) return null;

  const productId = gplayProductIdForMaterial(material.id);

  try {
    const { rawClient, packageName } = await getPlayAuthClients();
    const regionsVersion = requireEnv('GOOGLE_PLAY_REGIONS_VERSION');

    const units = Math.floor(material.price);
    const nanos = Math.round((material.price - units) * 1_000_000_000);

    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/onetimeproducts/${encodeURIComponent(productId)}`;

    await rawClient.request({
      url,
      method: 'PATCH',
      params: {
        allowMissing: true,
        'regionsVersion.version': regionsVersion,
        updateMask: 'listings,purchaseOptions',
      },
      data: {
        packageName,
        productId,
        listings: [
          {
            languageCode: 'en-US',
            title: material.title.slice(0, 55),
            description: (material.description || material.title).slice(0, 200),
          },
        ],
        purchaseOptions: [
          {
            purchaseOptionId: PURCHASE_OPTION_ID,
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
    console.error(`Play catalog sync failed for material ${material.id}:`, detail);
    return null;
  }
}

// ── Mock tests — same sync again, applied to quizzes ──────────────────
// Third near-copy of the same upsert. Deliberately a copy: courses and
// materials are live revenue paths and folding all three into one generic
// helper in the same change that introduces quiz purchases would put that
// money at risk for a tidiness win. Worth collapsing once this has run in
// production for a while.
export interface QuizForSync {
  id: string;
  title: string;
  description?: string | null;
  price: number;
  isPaid: boolean;
}

// quiz_ + 32 hex = 37 chars, inside Play's 40-char product id limit.
export function gplayProductIdForQuiz(quizId: string): string {
  return `quiz_${quizId.replace(/-/g, '')}`;
}

// Same best-effort contract as the two above: never throws, returns null
// when there is nothing to sync (free test, zero price) or when Play
// rejects the call. A catalog failure must never stop an admin saving a
// quiz — it only means the test cannot be bought with money yet.
export async function syncQuizToPlayCatalog(quiz: QuizForSync): Promise<string | null> {
  if (!quiz.isPaid || !quiz.price || quiz.price <= 0) return null;

  const productId = gplayProductIdForQuiz(quiz.id);

  try {
    const { rawClient, packageName } = await getPlayAuthClients();
    const regionsVersion = requireEnv('GOOGLE_PLAY_REGIONS_VERSION');

    const units = Math.floor(quiz.price);
    const nanos = Math.round((quiz.price - units) * 1_000_000_000);

    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/onetimeproducts/${encodeURIComponent(productId)}`;

    await rawClient.request({
      url,
      method: 'PATCH',
      params: {
        allowMissing: true,
        'regionsVersion.version': regionsVersion,
        updateMask: 'listings,purchaseOptions',
      },
      data: {
        packageName,
        productId,
        listings: [
          {
            languageCode: 'en-US',
            title: quiz.title.slice(0, 55),
            description: (quiz.description || quiz.title).slice(0, 200),
          },
        ],
        purchaseOptions: [
          {
            purchaseOptionId: PURCHASE_OPTION_ID,
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
    console.error(`Play catalog sync failed for quiz ${quiz.id}:`, detail);
    return null;
  }
}

// -- Mock test packages -- a bundle bought once, like a course -----------
export interface QuizPackageForSync {
  id: string;
  title: string;
  description?: string | null;
  price: number;
  isPaid: boolean;
}

// qpkg_ + 32 hex = 37 chars, inside Play's 40-char product id limit.
export function gplayProductIdForQuizPackage(packageId: string): string {
  return `qpkg_${packageId.replace(/-/g, '')}`;
}

export async function syncQuizPackageToPlayCatalog(pkg: QuizPackageForSync): Promise<string | null> {
  if (!pkg.isPaid || !pkg.price || pkg.price <= 0) return null;

  const productId = gplayProductIdForQuizPackage(pkg.id);

  try {
    const { rawClient, packageName } = await getPlayAuthClients();
    const regionsVersion = requireEnv('GOOGLE_PLAY_REGIONS_VERSION');

    const units = Math.floor(pkg.price);
    const nanos = Math.round((pkg.price - units) * 1_000_000_000);

    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/onetimeproducts/${encodeURIComponent(productId)}`;

    await rawClient.request({
      url,
      method: 'PATCH',
      params: {
        allowMissing: true,
        'regionsVersion.version': regionsVersion,
        updateMask: 'listings,purchaseOptions',
      },
      data: {
        packageName,
        productId,
        listings: [
          {
            languageCode: 'en-US',
            title: pkg.title.slice(0, 55),
            description: (pkg.description || pkg.title).slice(0, 200),
          },
        ],
        purchaseOptions: [
          {
            purchaseOptionId: PURCHASE_OPTION_ID,
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
    console.error(`Play catalog sync failed for quiz package ${pkg.id}:`, detail);
    return null;
  }
}
