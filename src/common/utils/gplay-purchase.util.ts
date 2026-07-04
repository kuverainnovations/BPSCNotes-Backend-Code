// Server-side verification + acknowledgement for one-time course purchases.
//
// Verification uses purchases.productsv2.getproductpurchasev2 — the
// endpoint Google documents as current for products created via the
// monetization.onetimeproducts catalog model (see gplay-catalog.util.ts).
// Not in the installed googleapis@144 client (checked: no
// Resource$Purchases$Productsv2 in node_modules/googleapis), so this goes
// through the raw authenticated client, same as catalog sync.
//
// Acknowledgement is still the *legacy* purchases.products.acknowledge
// endpoint — Google's docs confirm there's no v2 equivalent for
// acknowledge, only for the get/read side. That one IS in the installed
// client, so it uses the typed androidpublisher wrapper instead.

import { getPlayAuthClients } from './gplay-auth.util';

export type PlayPurchaseState = 'PURCHASED' | 'CANCELLED' | 'PENDING' | 'PURCHASE_STATE_UNSPECIFIED';
export type PlayAcknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' | 'ACKNOWLEDGEMENT_STATE_PENDING' | 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED';

export interface OneTimeProductPurchase {
  purchaseState: PlayPurchaseState;
  acknowledgementState: PlayAcknowledgementState;
  productId: string | null;
  orderId: string | null;
  regionCode: string | null;
  purchaseCompletionTime: string | null;
  // Google's account-binding field (externalAccountIdentifiers.obfuscatedExternalAccountId).
  // Not read by the existing course verify flow — added for the new study-materials
  // gplay verify path, which checks this against the requesting user's id to prevent
  // a purchase token from being replayed/claimed by a different account.
  obfuscatedExternalAccountId: string | null;
}

// GET purchases.productsv2.getproductpurchasev2 — read-only, checks token
// validity + current state. Throws on network/auth failure; callers decide
// how to surface that (this intentionally does NOT swallow errors the way
// syncCourseToPlayCatalog does — an unverifiable purchase must never be
// silently treated as valid).
export async function getOneTimeProductPurchase(purchaseToken: string): Promise<OneTimeProductPurchase> {
  const { rawClient, packageName } = await getPlayAuthClients();

  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/productsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await rawClient.request({ url, method: 'GET' });
  const data: any = res.data;

  return {
    purchaseState: data?.purchaseStateContext?.purchaseState ?? 'PURCHASE_STATE_UNSPECIFIED',
    acknowledgementState: data?.acknowledgementState ?? 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED',
    productId: data?.productLineItem?.[0]?.productId ?? null,
    orderId: data?.orderId ?? null,
    regionCode: data?.regionCode ?? null,
    purchaseCompletionTime: data?.purchaseCompletionTime ?? null,
    obfuscatedExternalAccountId: data?.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
  };
}

// Must happen within 3 days of purchase or Google auto-refunds it. Never
// throws — acknowledgement failing shouldn't undo an entitlement that's
// already been granted; it just means this call (or the RTDN safety net)
// needs to retry. Returns whether it succeeded so the caller can log it.
export async function acknowledgeOneTimeProductPurchase(productId: string, purchaseToken: string): Promise<boolean> {
  try {
    const { androidpublisher, packageName } = await getPlayAuthClients();
    await androidpublisher.purchases.products.acknowledge({
      packageName,
      productId,
      token: purchaseToken,
      requestBody: {},
    });
    return true;
  } catch (e: any) {
    console.error(`Play purchase acknowledge failed for product ${productId}:`, e?.response?.data ?? e?.message ?? e);
    return false;
  }
}
