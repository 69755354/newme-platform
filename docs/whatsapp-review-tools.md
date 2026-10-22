# Internal WhatsApp App Review tools

The independent Tech Provider screen currently asks for separate recordings of
the application sending a message and creating a message template. An incoming
sample callback alone does not demonstrate either operation. These tools add
those two operations to Settings > WhatsApp without changing production phone
onboarding, message capture, the database schema or the existing Ads integration.

## Fixed test scope

- App: NEWME OS Messaging, 2295611971276443.
- Meta test WABA: 2153400175580231.
- Meta test phone ID: 1301171506423999; visible sender +1 555 664 0296.
- Only message recipient: the already verified internal Tanya number ending 9388.
- Only message content: Meta's existing `hello_world`, language `en_US`.
- Template creation: a uniquely named `newme_review_enquiry_...` English UTILITY
  template with the fixed enquiry acknowledgement shown before confirmation.
  Template creation itself sends no message. Meta approval is a separate outcome.

Before every operation, the server retrieves the phone list under the fixed test
WABA and checks both the phone ID and displayed test sender. A mismatched or
inaccessible account stops before a mutation. Neither a browser request nor a
runtime setting can choose another WABA, phone, recipient, message or template
body. If Meta does not allow template creation in this test WABA, retain that
failure as a blocker; do not fall back to a real business account automatically.

The API requires an active current-session boss/admin identity, exact same-origin
JSON requests, a bounded body and a UUID request ID. It limits each user to four
operations per hour and the single application process to eight in total. The
server and browser do not automatically retry uncertain sends or template
creation. The bounded replay cache lasts for the current app process only;
restarting does not revoke a previously accepted Meta request. A timeout must be
reconciled with Meta and the recipient before any further attempt.

## Disabled until explicit test authorisation

Deployment leaves the tools disabled. In the existing root-owned runtime store,
an approved operator may later configure:

- `WHATSAPP_REVIEW_TOOLS_ENABLED=true`;
- `WHATSAPP_REVIEW_ACCESS_TOKEN`, restricted to the fixed test WABA;
- `WHATSAPP_REVIEW_TOOLS_FROM` and `WHATSAPP_REVIEW_TOOLS_UNTIL`, UTC ISO timestamps
  to seconds, with an activation window no longer than 24 hours.

The existing `WHATSAPP_APP_SECRET` signs app-secret proof. No access token enters
browser storage, browser responses, source control or command history. Transfer
it through an approved private credential path. A missing credential, invalid
window, future start or expired window disables all Graph operations. The
observer's own runtime flag and enabled-channel rows are separate gates.

## Acceptance evidence still required

1. Verify current test-asset IDs in Meta before provisioning the test token.
2. Confirm the actual grant is limited to the test WABA and the required WhatsApp
   messaging/management permissions. Do not approve additional real assets.
3. In the published application, check the test connection. With specific human
   authorisation, send one internal message and create one review template.
4. Verify the same message on Tanya's phone and retain the Meta message ID. An
   accepted request is not proof of handset delivery.
5. Record the actual application and the actual recipient UI for messaging, and
   a separate actual template creation and resulting status. Mocked tests or
   synthetic slides are not production-function evidence.
6. Replace App Review draft descriptions with the functionality actually
   demonstrated; review all compliance declarations before submitting.

Meta requirements can change. References checked on 22 October 2026:

- [Business App coexistence](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
- [Meta's template-creation API example](https://www.postman.com/meta/whatsapp-business-platform/request/uvx80vi/create-template-w-text-header-text-body-text-footer-and-2-quick-reply-buttons)

This implementation alone is not Tech Provider approval, a submitted App Review,
a delivered WhatsApp message, a created/approved template, retention enforcement
or live capture. The 30-day retention/deletion control and official coexistence
acceptance for both company numbers remain prerequisites to enabling capture.
