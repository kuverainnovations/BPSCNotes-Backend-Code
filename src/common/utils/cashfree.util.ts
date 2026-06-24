/**
 * Cashfree Payment Gateway Utility
 * ══════════════════════════════════
 * Centralises all Cashfree API calls so each module (subscriptions,
 * courses, study-materials, admin) has a single, auditable integration
 * point.
 *
 * API version: 2023-08-01 (Cashfree PG v3)
 * Docs: https://docs.cashfree.com/reference/pg-new-apis-endpoint
 *
 * ENV vars expected (set via admin panel → payment_settings DB, or .env):
 *   CASHFREE_APP_ID        — from Cashfree dashboard
 *   CASHFREE_SECRET_KEY    — from Cashfree dashboard
 *   CASHFREE_WEBHOOK_SECRET — from Cashfree dashboard (for signature verify)
 *   CASHFREE_ENV           — 'sandbox' | 'production'  (default: sandbox)
 */

import * as crypto from 'crypto';

// ── Types ────────────────────────────────────────────────────
export interface CashfreeOrderRequest {
  orderId:       string;   // your internal receipt / unique ID
  orderAmount:   number;   // ₹ (NOT paise)
  orderCurrency: string;   // 'INR'
  customerId:    string;   // your user UUID (used for customer_id)
  customerPhone: string;   // required by Cashfree
  customerEmail: string;
  customerName:  string;
  orderNote?:    string;
  notifyUrl?:    string;   // webhook URL (overrides dashboard setting)
  orderMeta?:    Record<string, string>; // extra tags stored on the order
}

export interface CashfreeOrderResponse {
  cfOrderId:        string;   // Cashfree's internal order ID
  orderId:          string;   // mirrors your orderId
  paymentSessionId: string;   // pass to Android SDK
  orderStatus:      string;   // ACTIVE | PAID | EXPIRED | CANCELLED
  orderAmount:      number;
  orderCurrency:    string;
}

export interface CashfreeCredentials {
  appId:     string;
  secretKey: string;
  env:       'sandbox' | 'production';
}

// ── Helpers ──────────────────────────────────────────────────
function baseUrl(env: 'sandbox' | 'production'): string {
  return env === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

function headers(creds: CashfreeCredentials): Record<string, string> {
  return {
    'Content-Type':      'application/json',
    'x-api-version':     '2023-08-01',
    'x-client-id':       creds.appId,
    'x-client-secret':   creds.secretKey,
  };
}

// ── Order creation ────────────────────────────────────────────
/**
 * Create a Cashfree order and return the payment_session_id for the
 * Android SDK. Throws if the API returns an error.
 */
export async function createCashfreeOrder(
  creds: CashfreeCredentials,
  req:   CashfreeOrderRequest,
): Promise<CashfreeOrderResponse> {
  const body = {
    order_id:       req.orderId,
    order_amount:   req.orderAmount,
    order_currency: req.orderCurrency || 'INR',
    order_note:     req.orderNote || 'BPSCNotes purchase',
    customer_details: {
      customer_id:    req.customerId,
      customer_phone: req.customerPhone || '9999999999',
      customer_email: req.customerEmail || `${req.customerId}@bpscnotes.app`,
      customer_name:  req.customerName  || 'BPSCNotes User',
    },
    ...(req.notifyUrl ? { order_meta: { notify_url: req.notifyUrl, ...req.orderMeta } } : {}),
  };

  const res = await fetch(`${baseUrl(creds.env)}/orders`, {
    method:  'POST',
    headers: headers(creds),
    body:    JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok || !data.payment_session_id) {
    const msg = data?.message || data?.error_detail?.error_reason || JSON.stringify(data);
    throw new Error(`Cashfree order creation failed: ${msg}`);
  }

  return {
    cfOrderId:        data.cf_order_id,
    orderId:          data.order_id,
    paymentSessionId: data.payment_session_id,
    orderStatus:      data.order_status,
    orderAmount:      data.order_amount,
    orderCurrency:    data.order_currency,
  };
}

// ── Payment verification ──────────────────────────────────────
/**
 * Fetch the Cashfree order status and return the settled payment.
 * Verifies the order belongs to us and is PAID before unlocking entitlement.
 */
export interface CashfreePaymentDetail {
  cfPaymentId:   string;
  orderId:       string;
  paymentStatus: string;   // SUCCESS | FAILED | PENDING | USER_DROPPED | etc.
  paymentAmount: number;
  paymentMethod: string;   // upi | card | netbanking | wallet
  paymentTime:   string;
  bankReference?: string;
  upiId?:         string;
}

export async function verifyCashfreePayment(
  creds:   CashfreeCredentials,
  orderId: string,
): Promise<CashfreePaymentDetail> {
  const res = await fetch(`${baseUrl(creds.env)}/orders/${orderId}/payments`, {
    method:  'GET',
    headers: headers(creds),
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.message || JSON.stringify(data);
    throw new Error(`Cashfree payment fetch failed: ${msg}`);
  }

  // data is an array; find the successful payment
  const payments: any[] = Array.isArray(data) ? data : [];
  const success = payments.find(p => p.payment_status === 'SUCCESS');
  if (!success) {
    // Return the most recent payment's status for error messages
    const latest = payments[0];
    return {
      cfPaymentId:   latest?.cf_payment_id  || '',
      orderId,
      paymentStatus: latest?.payment_status || 'PENDING',
      paymentAmount: latest?.payment_amount || 0,
      paymentMethod: latest?.payment_group  || 'unknown',
      paymentTime:   latest?.payment_time   || '',
    };
  }

  return {
    cfPaymentId:   String(success.cf_payment_id),
    orderId,
    paymentStatus: success.payment_status,
    paymentAmount: success.payment_amount,
    paymentMethod: success.payment_group  || 'unknown',
    paymentTime:   success.payment_time   || '',
    bankReference: success.bank_reference,
    upiId:         success.payment_method?.upi?.upi_id,
  };
}

// ── Webhook signature verification ───────────────────────────
/**
 * Verify Cashfree webhook signature.
 *
 * Cashfree signs the webhook as:
 *   HMAC-SHA256( timestamp + rawBody, secretKey )
 *   where timestamp = value of 'x-webhook-timestamp' header
 *
 * Returns true if valid, false otherwise.
 */
export function verifyCashfreeWebhookSignature(
  rawBody:   string | Buffer,
  timestamp: string,
  signature: string,
  secret:    string,
): boolean {
  try {
    const payload  = timestamp + rawBody.toString();
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('base64');
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

// ── Refund ────────────────────────────────────────────────────
export interface CashfreeRefundRequest {
  refundId:     string;   // unique refund ID (e.g. "refund_sub_{uuid}")
  refundAmount: number;   // ₹
  refundNote?:  string;
}

export interface CashfreeRefundResponse {
  cfRefundId:   string;
  refundId:     string;
  orderId:      string;
  refundAmount: number;
  refundStatus: string;   // PENDING | SUCCESS | CANCELLED | ONHOLD
}

export async function refundCashfreePayment(
  creds:   CashfreeCredentials,
  orderId: string,
  req:     CashfreeRefundRequest,
): Promise<CashfreeRefundResponse> {
  const res = await fetch(`${baseUrl(creds.env)}/orders/${orderId}/refunds`, {
    method:  'POST',
    headers: headers(creds),
    body:    JSON.stringify({
      refund_id:     req.refundId,
      refund_amount: req.refundAmount,
      refund_note:   req.refundNote || 'Admin initiated refund',
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.message || JSON.stringify(data);
    throw new Error(`Cashfree refund failed: ${msg}`);
  }

  return {
    cfRefundId:   data.cf_refund_id   || '',
    refundId:     data.refund_id       || req.refundId,
    orderId:      data.order_id        || orderId,
    refundAmount: data.refund_amount   || req.refundAmount,
    refundStatus: data.refund_status   || 'PENDING',
  };
}

// ── Credentials helper ────────────────────────────────────────
/**
 * Build credentials from env vars, with DB overrides applied on top.
 * Call pattern: resolve env defaults first, then overlay payment_settings rows.
 */
export function buildCashfreeCredentials(overrides: {
  appId?:     string;
  secretKey?: string;
  env?:       string;
}): CashfreeCredentials {
  const appId     = overrides.appId     || process.env.CASHFREE_APP_ID     || '';
  const secretKey = overrides.secretKey || process.env.CASHFREE_SECRET_KEY || '';
  const env       = (overrides.env      || process.env.CASHFREE_ENV        || 'sandbox') as 'sandbox' | 'production';
  return { appId, secretKey, env };
}

/**
 * Generate a unique, idempotent order receipt string.
 * Cashfree order_id must be unique per order, max 50 chars.
 */
export function cashfreeReceiptId(prefix: string, ...ids: string[]): string {
  const raw = [prefix, ...ids.map(id => id.substring(0, 8)), Date.now().toString(36)].join('_');
  return raw.substring(0, 50);
}
