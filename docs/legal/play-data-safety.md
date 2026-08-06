# Play Console — Data Safety answers for BPSCNotes

Fill the Console form (**App content → Data safety**) with these answers. They
are derived from what the code actually does, and they match
`privacy-policy.html` in this folder. Play compares the three against each
other — the form, the policy page, and the permissions in the uploaded AAB —
and a disagreement between any two is a rejection.

Verified against `versionCode 18` / `versionName 1.0.5`.

---

## Section 1 — Data collection and security

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** — release builds set `cleartextTrafficPermitted="false"`; the only cleartext exceptions are localhost and the emulator host, which never resolve on a user's device |
| Do you provide a way for users to request that their data is deleted? | **Yes** — in-app (Settings → Delete Account) and at `https://bpscnotes.in/account-deletion/` |

Enter the deletion URL in the field Play shows once you answer Yes. It must be
live before you submit, or the review fails on a dead link.

---

## Section 2 — Data types

For every row below: **Collected = Yes**, **Shared = No** unless stated,
**Processed ephemerally = No** unless stated, **Required or optional** as noted.

### Personal info

| Data type | Collected | Purposes | Required? |
|---|---|---|---|
| Name | Yes | App functionality, Personalisation | Required |
| Phone number | Yes | App functionality, Account management | Required |
| User IDs | Yes | App functionality, Analytics | Required |
| Other info (district, target exam, prep level) | Yes | App functionality, Personalisation | Optional |

### Financial info

| Data type | Collected | Purposes | Required? |
|---|---|---|---|
| Purchase history | Yes | App functionality | Required |

Do **not** tick "Payment info". Card, UPI and bank details go to Google Play
Billing or Cashfree directly and never reach our servers or the app process.

### Photos and videos

| Data type | Collected | Purposes | Required? |
|---|---|---|---|
| Photos | Yes | App functionality | Optional |

Answer photos of handwritten answers, and profile pictures. Camera use inside a
live class is **not** collected — it is streamed to the class and never
recorded, so it is not "collected" under Play's definition.

### Audio

Microphone input in a live class is streamed and never recorded or uploaded to
us. Under Play's definitions this is **not collected**, so leave the Audio
section unticked — but be ready to explain it if asked, because the manifest
does declare `RECORD_AUDIO`.

### Messages

| Data type | Collected | Purposes | Required? |
|---|---|---|---|
| Other in-app messages | Yes | App functionality | Optional |

Study room chat, peer reviews, and reports.

### Files and docs

| Data type | Collected | Purposes | Required? |
|---|---|---|---|
| Files and docs | Yes | App functionality | Optional |

PDFs uploaded to the study material marketplace. Mark **Shared = Yes** — other
users can buy and download them, which is the point of the feature.

### App activity

| Data type | Collected | Purposes | Required? |
|---|---|---|---|
| App interactions | Yes | Analytics, App functionality | Required |
| Other user-generated content | Yes | App functionality | Optional |

Written answers, notebook notes, study progress.

### App info and performance

| Data type | Collected | Purposes | Required? |
|---|---|---|---|
| Crash logs | Yes | Analytics | Required |
| Diagnostics | Yes | Analytics | Required |

### Device or other IDs

| Data type | Collected | Shared | Purposes | Required? |
|---|---|---|---|---|
| Device or other IDs | Yes | **Yes** | Advertising or marketing, Analytics | Required |

**This is the row that is currently missing and will get the app rejected.**
The AAB requests `com.google.android.gms.permission.AD_ID` plus the three
`ACCESS_ADSERVICES_*` permissions, because AdMob is integrated. Shared = Yes,
because the ID goes to Google for ad selection and measurement.

---

## Section 3 — Other declarations

| Question | Answer |
|---|---|
| Does your app contain ads? | **Yes** — banner, interstitial, rewarded and native, via AdMob |
| Target audience | **18 and over** (BPSC candidates); the app is not directed at children |
| Does your app allow users to create or share content? | **Yes** |
| News app? | **No** — Current Affairs is exam-prep study material, not journalism |
| COVID-19 contact tracing? | **No** |
| Government app? | **No** — BPSCNotes is independent and not affiliated with the Bihar Public Service Commission |

That last one matters: an app named after a government exam gets checked for
impersonation. Make sure the store listing says plainly that BPSCNotes is an
independent preparation app and is not affiliated with or endorsed by the BPSC.

---

## Section 4 — Content rating questionnaire

Answer **Yes** to "Does the app allow users to interact or exchange content
with other users?" and to the follow-ups about user-to-user communication and
user-generated content sharing.

Understating this is treated as a misdeclaration, and it is easy for a reviewer
to disprove — study room chat is two taps from the home screen.

When asked what moderation exists, the answer is: in-app reporting on every
UGC surface, in-app user blocking, and an admin review queue
(Admin panel → Users → Content Reports) with a stated 24-hour review target.

---

## Section 5 — Still to confirm outside the code

These cannot be verified from the repository. Check each before submitting.

1. **User Choice Billing enrolment.** `BillingClientWrapper.kt` calls
   `enableUserChoiceBilling()`. That API requires approval for Google Play's
   User Choice Billing programme in India. If the enrolment has not been
   granted, remove the call before shipping — the rest of the billing flow
   works on standard Play Billing without it.
2. **Play Console products.** Every product ID the app queries must exist and
   be active, or checkout fails with "Plan not found on Play Store". This
   covers the subscription plans in `PLAN_TO_GPLAY_PRODUCT` plus a product per
   purchasable course and study material.
3. **Privacy policy URL live** with the replacement content, before you submit.
4. **Account deletion URL live** and entered in the Data safety form.
5. **Ad unit approval.** The production AdMob units only start filling once the
   app is live and the units are approved on the AdMob side. Empty ad slots in
   the first days after launch are expected and are not a code bug.
