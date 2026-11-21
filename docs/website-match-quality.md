# Website Lead event match quality (pixel 4476894535908766)

Diagnosis: the newme.ae website is NOT in this repository, so the browser half cannot be fixed here.

## Server half (this repo, fixed)
`src/lib/meta-capi.ts` + `src/app/api/public/leads/route.ts`:
- Dedup: the server event uses the browser's `event_id` (required by the route unless honeypot), so a matching browser `eventID` merges the two. OK.
- Phone: `ph` is the SHA-256 of E.164 digits without `+`. Fixed edge cases that produced a wrong hash: `+971 0501234567` (extra local 0), `00971...`.
  Only plausible numbers (8-15 digits) are sent.
- Added `country` (hashed `ae`, for UAE numbers or no number) and `fbc` rebuilt as `fb.1.<ms>.<fbclid>` when the site sends `fbclid` but not the `_fbc` cookie.
- Already sent: `em`, `fn`, `ln`, `external_id`, client IP, user agent, `fbp`. Events already queued keep their stored payload (by design).

## What the website must change (exactly)
1. On submit, create one id: `const eventId = crypto.randomUUID()`. Send it in the POST body as `event_id` AND fire the browser event with it:
   `fbq('track', 'Lead', {content_name: 'Smart Home Budget Estimator'}, {eventID: eventId})`. Different ids = double counting and no merge.
2. Fire the browser `Lead` AFTER the user typed phone/email, never on page load or on button render. Before it, pass the data to the pixel
   (advanced matching): `fbq('init', '4476894535908766', {em: email.trim().toLowerCase(), ph: e164digits, fn, ln, country: 'ae'})` re-run with the form values,
   or call `fbq('setUserData', {...})` (the pixel hashes). `ph` = digits only with country code, no `+`, no spaces, no leading 0 (`971501234567`). Same for the browser and for the POST body.
3. Turn on Automatic Advanced Matching in Events Manager for this pixel (Settings), and make sure the form inputs have `type=email` / `type=tel` and `name`s such as `email`, `phone`.
4. Send `fbp` (`_fbp` cookie), `fbc` (`_fbc` cookie) and `fbclid` from the URL in the POST body; read the cookies at submit time, not at page load.
5. Check in Events Manager > Test events: one submit must show a browser Lead and a server Lead with the same Event ID, marked "Deduplicated", both with em/ph.

## Also noticed
`src/components/MetaPixel.tsx` loads the OS app layout with pixel id `1612447067166445`, which is the Meta APP id used by the OAuth routes, not the pixel `4476894535908766`.
It is excluded on all backend pages so it does nothing useful; not changed here (decide: remove it or set the right id).
