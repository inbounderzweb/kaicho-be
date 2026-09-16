import crypto from "crypto";
import { env } from "../../config/env";

// GA4 Measurement Protocol — server-to-server event reporting, independent
// of the browser/GTM pipeline (kaicho-ui's lib/analytics/*). Exists because
// the browser-side `purchase` event (fired from the customer's
// OrderDetailClient.tsx) is silently dropped whenever an ad blocker strips
// googletagmanager.com or the tab closes before it loads — this is the
// reliable backup specifically for that one revenue-critical event.
//
// client_id below is a fresh random id per call, NOT the visitor's real GA
// client_id — that would require threading the browser's _ga cookie through
// checkout → order → payment verification, which nothing in the app does
// today. Purchases still land correctly in GA4's revenue/conversion totals,
// but aren't attributed to the visitor's original session, traffic source,
// or campaign. Accepted limitation of the backend-only setup; upgrade path
// is passing a real client_id through PlaceOrderInput if that's ever needed.

const GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect";

interface Ga4Item {
  item_id: string;
  item_name: string;
  price: number;
  quantity: number;
}

export interface Ga4PurchaseParams {
  transaction_id: string;
  currency: string;
  value: number;
  items: Ga4Item[];
}

// Never throws — analytics failing must never affect the order flow that
// triggered it, same treatment as sendNewOrderEmail.
export async function trackServerPurchase(params: Ga4PurchaseParams): Promise<void> {
  if (!env.ga4MeasurementId || !env.ga4ApiSecret) {
    console.warn(
      "[analytics] GA4_MEASUREMENT_ID or GA4_API_SECRET not configured — skipping server-side purchase event"
    );
    return;
  }

  const url = `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(env.ga4MeasurementId)}&api_secret=${encodeURIComponent(env.ga4ApiSecret)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: crypto.randomUUID(),
        events: [{ name: "purchase", params }],
      }),
    });
    if (!res.ok) {
      console.error("[analytics] GA4 Measurement Protocol call failed", { status: res.status });
    }
  } catch (err) {
    console.error("[analytics] GA4 Measurement Protocol call errored", {
      reason: err instanceof Error ? err.message : "unknown error",
    });
  }
}
