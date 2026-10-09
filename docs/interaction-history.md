# Interaction History Engine (Phase 1: reliable capture)

Private, consent-gated history of what a logged-in customer views, searches,
saves and buys. Phase 1 covers capture, deduplication, consent, deletion and
purchase recovery. Profile aggregation, AI analysis and promotions are later
phases and are **not built yet**.

Code: `src/modules/interaction/`. Collection: `user_interaction_events`.

## Master switch

`INTERACTION_TRACKING_ENABLED` (default **false**). When off: browser ingestion
returns `tracking: "disabled"` without writing, server events (`wishlist`,
`checkout_started`, `purchase`) are not recorded, the 15-minute recovery sweep
does nothing, `/api/auth/me` omits `trackingConsent`, and the storefront hides
the consent banner and the Privacy tab and never starts the tracker. Existing
events are NOT deleted; they expire by TTL or via `DELETE /api/me/interaction-data`.

## Event flow

```
Browser (kaicho-ui lib/interaction)           Server business boundaries
  product_view, category_view, search,          wishlist add/remove  (wishlist.controller)
  add/remove_from_cart                          checkout_started     (createCheckout)
        |  batched, <=20/request                purchase             (order first CONFIRMED)
        v                                              |
  POST /api/interactions                               v
  requireAuth -> interactionContext -> limiter   interactionTrackingService
        |                                         .track()          non-critical
        |                                         .trackCritical()  purchase
        v                                              |
  recordInteractions (source:"client")                 v
        |                                       bounded in-memory buffer (batched)
        |                                              |
        +------------------> writeEvents <-------------+     purchase writes directly
                       (one place that persists)
                    resolves product/category/price in 1-2 queries,
                    upserts on (userId, eventId)
                                |
                                v
                    user_interaction_events  --TTL--> deleted after 180 days

  every 15 min: reconcilePurchaseEvents()  re-derives purchase events from orders
```

## Who may send what (`interaction.events.ts` is the single rule table)

| Event | Source | Why |
|---|---|---|
| product_view, category_view, search, search_result_click, product_compare, offer_view | browser | Product/category pages are public and CDN/ISR-cached; the server never sees the visit. |
| add_to_cart, remove_from_cart, quantity_changed | browser | The cart is client-side; there is no server cart. |
| wishlist_add, wishlist_remove | **server** | Recorded only when the wishlist actually changed. |
| checkout_started | **server** | Recorded when an order is placed (not when the page opens). |
| purchase | **server** | Recorded when an order is first CONFIRMED (online: paid, COD: placed). One event per order line. |
| offer_accepted, offer_rejected | **server** | Reserved for the promotion phase. |

The browser is **rejected** (400) if it sends a server-owned type, or any of
`displayedPrice`, `orderId`, `userId`. Browser events are stored with
`source: "client"` so later phases can weight them lower. Prices are filled in
by the server from the current catalog (or the order line for purchases).

## Deduplication

* `eventId` is the idempotency key, unique per user (`{userId, eventId}`).
  Browser events carry a client-generated id; a network retry cannot double-count.
* Purchase ids are deterministic: `p-<orderId>-<lineIndex>`; `checkout_started` is
  `co-<orderId>`. The immediate write and the recovery sweep can both run safely.
* Legitimate repeats are **not** merged on the server (two add-to-carts are two
  events). The browser tracker only suppresses an identical view within 30 s
  (re-render / strict-mode double fire).

## Delivery guarantees (what is and is not promised)

* **Purchase**: written immediately (no buffer). If that write fails or the
  process dies first, `reconcilePurchaseEvents()` (every 15 min, looks back 24 h)
  recreates it from the order, which is the durable record. Consent must predate
  the purchase; opting in later does not backfill earlier orders. A later
  cancellation does not retract the purchase event.
* **Wishlist / checkout_started**: buffered (max `INTERACTION_BUFFER_MAX`, flushed
  every `INTERACTION_FLUSH_INTERVAL_MS` or at 200 events). A crash / SIGKILL loses
  what is still buffered; SIGTERM/SIGINT flush first. A full buffer **drops** new
  events and counts them. A failed flush is retried; after 3 consecutive failures
  the batch is dropped and counted. The buffer is per process.
* **Browser events**: best-effort; a failed send is dropped. The user can also
  fake their own browser events (affects only their own profile).
* Tracking never changes the result of the business action: `track()` never throws.

## Privacy

* Opt-in. Nothing is recorded until `PUT /api/me/tracking-consent {granted:true}`.
  Consent travels in `GET /api/auth/me` (`trackingConsent`), so the storefront
  needs no separate request.
* Withdrawing consent stops recording immediately and discards still-buffered events.
* `DELETE /api/me/interaction-data` deletes the caller's events (and purges the
  buffer). `deleteAllForUser(userId)` is exported for a future account-deletion flow.
* `GET /api/me/interaction-history` returns only the caller's own events.
* No endpoint takes a user id. `GET /api/admin/interaction-stats` (admin) exposes
  only counters, never events.
* Events expire after `INTERACTION_RETENTION_DAYS` (TTL on `expiresAt`).
  Orders are untouched by deletion or expiry.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| RATE_LIMIT_INTERACTION_MAX | 120 | Browser ingestion requests per user per rate-limit window |
| INTERACTION_RETENTION_DAYS | 180 | Event TTL |
| INTERACTION_BUFFER_MAX | 5000 | Server-side buffer cap per process |
| INTERACTION_FLUSH_INTERVAL_MS | 2000 | Max time an event waits in the buffer |

## Operations / monitoring

`GET /api/admin/interaction-stats` (this process only): `accepted`, `written`,
`duplicates`, `rejected`, `dropped`, `flushFailures`, `bufferDepth`, `lastFlushMs`.
Alert on `dropped > 0` or a growing `flushFailures`. Logs are prefixed
`[interaction]` and contain no event contents. With `WEB_CONCURRENCY > 1` each
worker has its own counters and buffer.

## Known limitations

* No profile aggregation, AI analysis, promotion engine or experiments yet.
* `occurredAt` for browser events is the client clock if within 24 h of the
  server, else the receipt time. `serverTs` is the trusted receipt time.
* The sweep scans orders from the last 24 h; a purchase older than that that was
  never recorded is not recovered.
* Counters are not aggregated across workers or restarts.
