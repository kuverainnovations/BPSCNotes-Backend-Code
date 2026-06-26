/**
 * WhatsApp OTP Utility
 * ════════════════════
 * Sends OTP via Meta WhatsApp Business Cloud API (v21.0).
 *
 * ENV vars required:
 *   WHATSAPP_PHONE_NUMBER_ID  — from Meta Business → WhatsApp → API Setup
 *   WHATSAPP_ACCESS_TOKEN     — System User permanent token (never expires)
 *   WHATSAPP_TEMPLATE_NAME    — default: bpscnotes_otp
 *   WHATSAPP_TEMPLATE_LANG    — default: en_US
 *
 * Template must be AUTHENTICATION category with two variables:
 *   {{1}} = OTP value (6 digits)
 *   {{2}} = expiry minutes
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/template-messages
 */

export interface WhatsAppOtpConfig {
  phoneNumberId:  string;
  accessToken:    string;
  templateName:   string;
  templateLang:   string;
}

export interface WhatsAppSendResult {
  success:    boolean;
  messageId?: string;
  error?:     string;
}

/**
 * Send OTP via WhatsApp Authentication template.
 * Returns { success: true } on delivery acceptance by Meta.
 * Throws on network failure so caller can decide fallback behaviour.
 */
export async function sendWhatsAppRequest(
  cfg: WhatsAppOtpConfig,
  mobile: string,
  requestId: string,
): Promise<WhatsAppSendResult> {
  // Normalise mobile → E.164 without leading +
  const to = mobile.replace(/^\+/, '');

  const url = `https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:     cfg.templateName,
      language: { code: cfg.templateLang },
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: "User",      // {{1}}
            },
            {
              type: 'text',
              text: requestId,   // {{2}}
            },
          ],
        },
      ],
    },
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${cfg.accessToken}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    const errMsg =
      data?.error?.error_user_msg ||
      data?.error?.message ||
      JSON.stringify(data);
    console.error(`WhatsApp API error (${res.status}):`, errMsg);
    return { success: false, error: errMsg };
  }

  const messageId = data?.messages?.[0]?.id;
  return { success: true, messageId };
}

/**
 * Build WhatsApp config from env vars with optional DB overrides.
 * Pass an overrides object populated from payment_settings or app_settings.
 */
export function buildWhatsAppConfig(overrides: {
  phoneNumberId?: string;
  accessToken?:   string;
  templateName?:  string;
  templateLang?:  string;
} = {}): WhatsAppOtpConfig {
  return {
    phoneNumberId: overrides.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken:   overrides.accessToken   || process.env.WHATSAPP_ACCESS_TOKEN    || '',
    templateName:  overrides.templateName  || process.env.WHATSAPP_TEMPLATE_NAME   || 'bpsc_account_request',
    templateLang:  overrides.templateLang  || process.env.WHATSAPP_TEMPLATE_LANG   || 'en_US',
  };
}
