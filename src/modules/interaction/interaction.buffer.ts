import { env } from "../../config/env";
import type { PreparedEvent } from "./interaction.events";
import { writeEvents } from "./interaction.persistence";

// Bounded in-memory buffer for NON-critical, server-recorded events (wishlist,
// checkout started). Batches writes so a burst costs one bulkWrite, and caps
// memory: when full, new events are DROPPED and counted (backpressure) rather
// than growing without limit.
//
// Failure guarantees (be honest about these):
//  - A crash or SIGKILL loses whatever is still buffered (up to
//    INTERACTION_FLUSH_INTERVAL_MS of events). SIGTERM/SIGINT flush first.
//  - A failed flush is retried; after MAX_CONSECUTIVE_FAILURES the batch is
//    dropped and counted so a broken database can't wedge or exhaust memory.
//  - Critical events (purchase) NEVER use this buffer - see
//    interactionTrackingService.trackCritical and the recovery sweep.
//  - The buffer is per process; under clustering each worker has its own.

const FLUSH_AT = 200;
const MAX_BATCH = 500;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface InteractionStats {
  accepted: number;
  written: number;
  duplicates: number;
  rejected: number;
  dropped: number;
  flushFailures: number;
  bufferDepth: number;
  lastFlushMs: number | null;
}

const stats = { accepted: 0, written: 0, duplicates: 0, rejected: 0, dropped: 0, flushFailures: 0, lastFlushMs: null as number | null };
let buffer: PreparedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let consecutiveFailures = 0;

export function bufferStats(): InteractionStats {
  return { ...stats, bufferDepth: buffer.length };
}

export function recordWriteStats(r: { written: number; duplicates: number; rejected: number }) {
  stats.written += r.written;
  stats.duplicates += r.duplicates;
  stats.rejected += r.rejected;
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushBuffer();
  }, env.interactionFlushIntervalMs);
  timer.unref?.(); // never keep the process alive just to flush
}

// Returns false (and counts a drop) when the buffer is full.
export function enqueue(event: PreparedEvent): boolean {
  if (buffer.length >= env.interactionBufferMax) {
    stats.dropped += 1;
    return false;
  }
  buffer.push(event);
  stats.accepted += 1;
  if (buffer.length >= FLUSH_AT) void flushBuffer();
  else schedule();
  return true;
}

// Single-flight: concurrent callers share one in-progress flush. A caller that
// joins a flush which is already finishing still gets its own events written:
// anything enqueued meanwhile triggers a follow-up pass before this resolves.
export function flushBuffer(): Promise<void> {
  if (flushing) return flushing.then(() => (buffer.length > 0 ? flushBuffer() : undefined));
  if (buffer.length === 0) return Promise.resolve();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  // .finally (always asynchronous) clears the marker; clearing it inside the
  // async body would run before this assignment when the body finishes
  // synchronously, leaving a stale "in flight" marker behind.
  flushing = drain().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function drain(): Promise<void> {
  while (buffer.length > 0) {
    const batch = buffer.splice(0, MAX_BATCH);
    const startedAt = Date.now();
    try {
      recordWriteStats(await writeEvents(batch, { requireKnownRefs: false }));
      stats.lastFlushMs = Date.now() - startedAt;
      consecutiveFailures = 0;
    } catch (err) {
      stats.flushFailures += 1;
      consecutiveFailures += 1;
      console.error("[interaction] buffer flush failed:", err instanceof Error ? err.message : "unknown error");
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stats.dropped += batch.length;
        consecutiveFailures = 0;
      } else {
        // Put it back (bounded) and let the next timer tick retry.
        const room = Math.max(0, env.interactionBufferMax - buffer.length);
        buffer.unshift(...batch.slice(0, room));
        stats.dropped += Math.max(0, batch.length - room);
        schedule();
        return;
      }
    }
  }
}

// Consent withdrawn / data deleted: don't let still-buffered events land
// after the user asked for them to go.
export function purgeBufferedForUser(userId: string): number {
  const before = buffer.length;
  buffer = buffer.filter((e) => e.userId !== userId);
  return before - buffer.length;
}

let shutdownRegistered = false;
// Flush on SIGTERM/SIGINT, then re-raise so the default exit still happens.
export function registerInteractionShutdownFlush() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      const done = () => process.kill(process.pid, signal);
      Promise.race([flushBuffer(), new Promise((r) => setTimeout(r, 3000))]).finally(done);
    });
  }
}

export function __resetBufferForTests() {
  buffer = [];
  if (timer) clearTimeout(timer);
  timer = null;
  flushing = null;
  consecutiveFailures = 0;
  Object.assign(stats, { accepted: 0, written: 0, duplicates: 0, rejected: 0, dropped: 0, flushFailures: 0, lastFlushMs: null });
}
