import { Blog } from "../../database/models";

// Flips SCHEDULED posts to PUBLISHED once their scheduledFor time has passed.
// Same shape as orderCleanup.ts's stale-order sweep: find due docs, act on
// each, count outcomes, never let one bad doc abort the run. Wired into
// server.ts on a 1-minute interval (finer than the media/order sweeps because
// a late publish is directly visible to readers).
export async function publishDueScheduledBlogs(): Promise<{ published: number; failed: number }> {
  const now = new Date();
  const due = await Blog.find({ status: "SCHEDULED", scheduledFor: { $lte: now } }).exec();

  let published = 0;
  let failed = 0;

  for (const doc of due) {
    try {
      doc.status = "PUBLISHED";
      // Honour the intended time as the canonical publish date even if the
      // sweep runs a few seconds late.
      doc.publishedAt = doc.publishedAt ?? doc.scheduledFor ?? now;
      doc.publishedBy = doc.publishedBy ?? doc.author;
      doc.scheduledFor = undefined;
      doc.statusHistory.push({ status: "PUBLISHED", at: now, note: "Auto-published (scheduled)" });
      await doc.save();
      published += 1;
    } catch (err) {
      failed += 1;
      console.error(`Scheduled publish failed for blog ${doc._id.toString()}:`, err);
    }
  }

  return { published, failed };
}
