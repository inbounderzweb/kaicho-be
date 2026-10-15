# Order notifications

COD checkout confirms an order immediately. Online checkout sends confirmation
only when the payment is verified or captured by webhook. Both paths notify
admins and send a confirmation email to the customer's verified account email.
Phone-only accounts receive in-app notifications; they have no email recipient.

The admin bell reads confirmed order history and also listens for live socket
events. Its feed restores missed alerts after a disconnect, refresh or an event
on a different backend instance. Reading the bell acknowledges the displayed
orders for that admin; an unseen concurrent order remains unread. The feed and
badge show the latest 20 confirmations within 30 days. Customer order
notifications include confirmation and later status updates.

Required backend configuration:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`: SMTP provider credentials.
- `SMTP_FROM`: the sender authorized by that provider.
- `ADMIN_NOTIFICATION_EMAIL`: admin recipient(s), separated by commas.
- `APP_URL`: the publicly reachable storefront URL used in customer email links.
- `FRONTEND_ORIGIN`: includes the browser origin allowed to connect to sockets.

Deploy/restart both backend and storefront after changes. Test a COD order and
an online payment with a verified customer account. A pending online checkout
must not trigger a confirmation. Verify the admin bell again after refreshing
and after temporarily disconnecting the socket.

Mail logs distinguish SMTP acceptance, missing configuration, provider refusal,
partial recipient rejection, and skipped customer addresses. Acceptance means
the provider accepted submission; subsequent bounces or spam filtering must be
checked with the provider. Explicit temporary SMTP refusals get at most three
attempts. Permanent refusals and ambiguous connection failures are logged; they
are not retried automatically. Email failures never undo a saved order.

Regression tests must use an isolated database via `MONGO_URI`; the existing
project environment may point at a remote database. The test setup disables real
SMTP delivery. Notification transport tests also mock the sender explicitly.
