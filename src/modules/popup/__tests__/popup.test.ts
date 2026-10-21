import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Popup } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { ensurePopupIndexes } from "../popup.indexes";
import { crossFieldIssues, isSafePopupHref } from "../popup.validation";
import { getEffectivePopupState } from "../popup.service";

const RUN_ID = Date.now().toString().slice(-6);
const NAME_PREFIX = `T${RUN_ID}`;
const createdUserIds: mongoose.Types.ObjectId[] = [];
let userSeq = 0;
let nameSeq = 0;

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `79${RUN_ID}${String(userSeq++).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  createdUserIds.push(user._id);
  return user;
}

const authCookie = (user: InstanceType<typeof User>) => `kaicho_session=${signSessionToken(user)}`;

const timing = (over: Record<string, unknown> = {}) => ({
  initialDelaySeconds: 3,
  autoCloseEnabled: true,
  autoCloseAfterSeconds: 10,
  countdownVisible: false,
  closeButtonEnabled: true,
  closeButtonPosition: "TOP_RIGHT",
  backdropDismissEnabled: true,
  escapeDismissEnabled: true,
  ...over,
});

function body(over: Record<string, unknown> = {}) {
  return {
    name: `${NAME_PREFIX}-${nameSeq++}`,
    priority: 100,
    content: { heading: "Welcome", body: "10% off your first order" },
    design: { theme: "LIGHT", size: "MD" },
    devices: {
      desktop: { enabled: true, placement: "CENTER" },
      mobile: { enabled: true, placement: "BOTTOM_SHEET" },
    },
    timing: {
      useSharedTimingSettings: true,
      shared: timing(),
      desktop: timing(),
      mobile: timing(),
    },
    display: {
      maxDisplaySeconds: 60,
      allowEarlyDismiss: true,
      closeButtonSize: "MD",
      closeButtonStyle: "SOLID",
      dismissalPolicy: "SESSION_SUPPRESS",
      dismissalWaitSeconds: 86400,
      sessionDisplayLimit: 1,
      repeatIntervalSeconds: 0,
      minReappearanceSeconds: 30,
    },
    targeting: { includePaths: [] },
    schedule: {},
    ...over,
  };
}

let admin: InstanceType<typeof User>;
let normalUser: InstanceType<typeof User>;

const create = (over: Record<string, unknown> = {}) =>
  request(app).post("/api/admin/popups").set("Cookie", authCookie(admin)).send(body(over));

async function createAndPublish(over: Record<string, unknown> = {}) {
  const res = await create(over);
  expect(res.status).toBe(201);
  const id = res.body.data.popup.id as string;
  const pub = await request(app)
    .patch(`/api/admin/popups/${id}/status`)
    .set("Cookie", authCookie(admin))
    .send({ status: "PUBLISHED" });
  return { id, pub };
}

const livePopups = async () => {
  const res = await request(app).get("/api/popups");
  expect(res.status).toBe(200);
  return res.body.data.popups as { id: string }[];
};

beforeAll(async () => {
  await connectDatabase();
  await ensurePopupIndexes();
  admin = await makeUser("admin");
  normalUser = await makeUser("user");
});

afterAll(async () => {
  await Popup.deleteMany({ name: new RegExp(`^${NAME_PREFIX}`) });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("popup validation (pure)", () => {
  it("accepts only https and same-site relative hrefs", () => {
    expect(isSafePopupHref("https://kaicho.in/x")).toBe(true);
    expect(isSafePopupHref("/products")).toBe(true);
    expect(isSafePopupHref("javascript:alert(1)")).toBe(false);
    expect(isSafePopupHref("http://kaicho.in")).toBe(false);
    expect(isSafePopupHref("//evil.com")).toBe(false);
    expect(isSafePopupHref("data:text/html,x")).toBe(false);
  });

  it("flags auto-close longer than the max display time", () => {
    const b = body();
    b.timing.shared = timing({ autoCloseAfterSeconds: 90 });
    expect(crossFieldIssues(b as never).some((i) => /exceed the maximum display/.test(i.message))).toBe(true);
  });

  it("derives effective state from status + schedule", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    const d = (status: string, startsAt?: string, endsAt?: string) =>
      ({
        status,
        schedule: {
          startsAt: startsAt ? new Date(startsAt) : undefined,
          endsAt: endsAt ? new Date(endsAt) : undefined,
        },
      }) as never;
    expect(getEffectivePopupState(d("PUBLISHED"), now)).toBe("LIVE");
    expect(getEffectivePopupState(d("PUBLISHED", "2026-02-01T00:00:00Z"), now)).toBe("SCHEDULED");
    expect(getEffectivePopupState(d("PUBLISHED", undefined, "2026-01-01T00:00:00Z"), now)).toBe("EXPIRED");
    expect(getEffectivePopupState(d("PAUSED"), now)).toBe("PAUSED");
    expect(getEffectivePopupState(d("DRAFT"), now)).toBe("DRAFT");
  });
});

describe("admin authz", () => {
  it("rejects anonymous and non-admin callers on every admin route", async () => {
    expect((await request(app).get("/api/admin/popups")).status).toBe(401);
    const asUser = await request(app).get("/api/admin/popups").set("Cookie", authCookie(normalUser));
    expect(asUser.status).toBe(403);
    const post = await request(app).post("/api/admin/popups").set("Cookie", authCookie(normalUser)).send(body());
    expect(post.status).toBe(403);
  });
});

describe("create / update validation", () => {
  it("creates a DRAFT with the timing config round-tripped", async () => {
    const res = await create({
      timing: {
        useSharedTimingSettings: false,
        shared: timing(),
        desktop: timing({ initialDelaySeconds: 3, autoCloseAfterSeconds: 10 }),
        mobile: timing({ initialDelaySeconds: 8, autoCloseEnabled: false, closeButtonPosition: "TOP_LEFT" }),
      },
    });
    expect(res.status).toBe(201);
    const p = res.body.data.popup;
    expect(p.status).toBe("DRAFT");
    expect(p.timing.useSharedTimingSettings).toBe(false);
    expect(p.timing.desktop.initialDelaySeconds).toBe(3);
    expect(p.timing.mobile.initialDelaySeconds).toBe(8);
    expect(p.timing.mobile.autoCloseEnabled).toBe(false);
    expect(p.timing.mobile.closeButtonPosition).toBe("TOP_LEFT");
  });

  it("ignores a client-supplied status on create (always DRAFT)", async () => {
    const res = await request(app)
      .post("/api/admin/popups")
      .set("Cookie", authCookie(admin))
      .send({ ...body(), status: "PUBLISHED" });
    // strict schema → unknown key rejected outright
    expect(res.status).toBe(400);
  });

  it.each([
    ["negative initial delay", { initialDelaySeconds: -1 }],
    ["initial delay above max", { initialDelaySeconds: 301 }],
    ["auto-close below min", { autoCloseAfterSeconds: 1 }],
    ["fractional seconds", { initialDelaySeconds: 2.5 }],
  ])("rejects %s", async (_label, over) => {
    const b = body();
    b.timing.shared = timing(over);
    const res = await request(app).post("/api/admin/popups").set("Cookie", authCookie(admin)).send(b);
    expect(res.status).toBe(400);
  });

  it("rejects unknown keys inside structured groups", async () => {
    const b = body();
    (b.timing.shared as Record<string, unknown>).evilKey = "x";
    const res = await request(app).post("/api/admin/popups").set("Cookie", authCookie(admin)).send(b);
    expect(res.status).toBe(400);
  });

  it("rejects a maxDisplaySeconds above the hard ceiling", async () => {
    const b = body();
    b.display.maxDisplaySeconds = 601;
    expect((await request(app).post("/api/admin/popups").set("Cookie", authCookie(admin)).send(b)).status).toBe(400);
  });

  it("rejects auto-close longer than max display time", async () => {
    const b = body();
    b.display.maxDisplaySeconds = 20;
    b.timing.desktop = timing({ autoCloseAfterSeconds: 30 });
    const res = await request(app).post("/api/admin/popups").set("Cookie", authCookie(admin)).send(b);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/maximum display time/);
  });

  it("disallowing early dismissal requires a short auto-close (no trapping)", async () => {
    const b = body();
    b.display.allowEarlyDismiss = false;
    b.timing.shared = timing({ autoCloseEnabled: false });
    expect((await request(app).post("/api/admin/popups").set("Cookie", authCookie(admin)).send(b)).status).toBe(400);

    const b2 = body();
    b2.display.allowEarlyDismiss = false;
    b2.timing = { useSharedTimingSettings: true, shared: timing({ autoCloseAfterSeconds: 11 }), desktop: timing(), mobile: timing() };
    expect((await request(app).post("/api/admin/popups").set("Cookie", authCookie(admin)).send(b2)).status).toBe(400);

    const ok = body();
    ok.display.allowEarlyDismiss = false;
    ok.timing = {
      useSharedTimingSettings: true,
      shared: timing({ autoCloseAfterSeconds: 10 }),
      desktop: timing({ autoCloseAfterSeconds: 10 }),
      mobile: timing({ autoCloseAfterSeconds: 10 }),
    };
    expect((await request(app).post("/api/admin/popups").set("Cookie", authCookie(admin)).send(ok)).status).toBe(201);
  });

  it("allows hiding the close button / disabling backdrop+escape (runtime keeps a fallback)", async () => {
    const res = await create({
      timing: {
        useSharedTimingSettings: true,
        shared: timing({ closeButtonEnabled: false, backdropDismissEnabled: false, escapeDismissEnabled: false, autoCloseEnabled: false }),
        desktop: timing(),
        mobile: timing(),
      },
    });
    expect(res.status).toBe(201);
  });

  it("rejects repeat interval below the minimum reappearance delay", async () => {
    const b = body();
    b.display.repeatIntervalSeconds = 10;
    b.display.minReappearanceSeconds = 30;
    expect((await request(app).post("/api/admin/popups").set("Cookie", authCookie(admin)).send(b)).status).toBe(400);
  });

  it("rejects unsafe CTA links and half-specified CTAs", async () => {
    const bad = await create({ content: { heading: "x", body: "", ctaLabel: "Go", ctaUrl: "javascript:alert(1)" } });
    expect(bad.status).toBe(400);
    const half = await create({ content: { heading: "x", body: "", ctaLabel: "Go" } });
    expect(half.status).toBe(400);
    const good = await create({ content: { heading: "x", body: "", ctaLabel: "Go", ctaUrl: "/products" } });
    expect(good.status).toBe(201);
  });

  it("rejects an end time before the start time", async () => {
    const res = await create({
      schedule: { startsAt: "2030-01-02T00:00:00Z", endsAt: "2030-01-01T00:00:00Z" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH re-validates cross-group rules against the stored document", async () => {
    const c = await create();
    const id = c.body.data.popup.id;
    // timing alone, but conflicts with stored display.maxDisplaySeconds (60)
    const res = await request(app)
      .patch(`/api/admin/popups/${id}`)
      .set("Cookie", authCookie(admin))
      .send({ timing: { useSharedTimingSettings: true, shared: timing({ autoCloseAfterSeconds: 120 }), desktop: timing(), mobile: timing() } });
    expect(res.status).toBe(400);
  });

  it("PATCH updates a group and bumps updatedAt", async () => {
    const c = await create();
    const id = c.body.data.popup.id;
    await new Promise((r) => setTimeout(r, 15));
    const res = await request(app)
      .patch(`/api/admin/popups/${id}`)
      .set("Cookie", authCookie(admin))
      .send({ name: `${NAME_PREFIX}-renamed`, content: { heading: "New", body: "" } });
    expect(res.status).toBe(200);
    expect(res.body.data.popup.content.heading).toBe("New");
    expect(res.body.data.popup.updatedAt).not.toBe(c.body.data.popup.updatedAt);
  });
});

describe("publish / public visibility", () => {
  it("drafts are never public", async () => {
    const c = await create();
    expect((await livePopups()).some((p) => p.id === c.body.data.popup.id)).toBe(false);
  });

  it("publishing makes it public with runtime config and no admin-only fields", async () => {
    const { id, pub } = await createAndPublish();
    expect(pub.status).toBe(200);
    const list = await request(app).get("/api/popups");
    const p = list.body.data.popups.find((x: { id: string }) => x.id === id);
    expect(p).toBeTruthy();
    expect(p.timing.shared.initialDelaySeconds).toBe(3);
    expect(p.revision).toBeTruthy();
    expect(p.analytics).toBeUndefined();
    expect(p.name).toBeUndefined();
    expect(p.schedule).toBeUndefined();
    expect(list.headers["cache-control"]).toContain("max-age=15");
    expect(list.headers["cache-control"]).not.toContain("stale-while-revalidate");
  });

  it("refuses to publish an empty popup or one with no device enabled", async () => {
    const empty = await createAndPublish({ content: { heading: "", body: "" } });
    expect(empty.pub.status).toBe(400);
    const noDev = await createAndPublish({
      devices: { desktop: { enabled: false, placement: "CENTER" }, mobile: { enabled: false, placement: "CENTER" } },
    });
    expect(noDev.pub.status).toBe(400);
  });

  it("paused and archived popups disappear; republishing restores", async () => {
    const { id } = await createAndPublish();
    const set = (status: string) =>
      request(app).patch(`/api/admin/popups/${id}/status`).set("Cookie", authCookie(admin)).send({ status });
    await set("PAUSED");
    expect((await livePopups()).some((p) => p.id === id)).toBe(false);
    await set("PUBLISHED");
    expect((await livePopups()).some((p) => p.id === id)).toBe(true);
    await request(app).delete(`/api/admin/popups/${id}`).set("Cookie", authCookie(admin)).expect(200);
    expect((await livePopups()).some((p) => p.id === id)).toBe(false);
  });

  it("scheduled (future) and expired (past) popups never appear", async () => {
    const future = await createAndPublish({ schedule: { startsAt: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(future.pub.status).toBe(200);
    expect((await livePopups()).some((p) => p.id === future.id)).toBe(false);

    const created = await create({});
    const id = created.body.data.popup.id;
    await request(app).patch(`/api/admin/popups/${id}/status`).set("Cookie", authCookie(admin)).send({ status: "PUBLISHED" }).expect(200);
    // Force the window into the past directly: simulates time passing.
    await Popup.updateOne({ _id: id }, { $set: { "schedule.endsAt": new Date(Date.now() - 1000) } });
    expect((await livePopups()).some((p) => p.id === id)).toBe(false);
    const adminView = await request(app).get(`/api/admin/popups/${id}`).set("Cookie", authCookie(admin));
    expect(adminView.body.data.popup.effectiveState).toBe("EXPIRED");
  });

  it("orders by priority (lower first)", async () => {
    const a = await createAndPublish({ priority: 900 });
    const b = await createAndPublish({ priority: 1 });
    const ids = (await livePopups()).map((p) => p.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
  });

  it("editing a published popup keeps it publishable", async () => {
    const { id } = await createAndPublish();
    const res = await request(app)
      .patch(`/api/admin/popups/${id}`)
      .set("Cookie", authCookie(admin))
      .send({ content: { heading: "", body: "" } });
    expect(res.status).toBe(400);
  });
});

describe("analytics events", () => {
  const send = (id: string, payload: unknown) => request(app).post(`/api/popups/${id}/events`).send(payload as object);

  it("counts events for live popups per device", async () => {
    const { id } = await createAndPublish();
    await send(id, { type: "IMPRESSION", device: "desktop" }).expect(204);
    await send(id, { type: "IMPRESSION", device: "mobile" }).expect(204);
    await send(id, { type: "CLICK", device: "desktop" }).expect(204);
    await send(id, { type: "DISMISS", device: "mobile" }).expect(204);
    await send(id, { type: "AUTO_CLOSE", device: "desktop" }).expect(204);
    const p = (await request(app).get(`/api/admin/popups/${id}`).set("Cookie", authCookie(admin))).body.data.popup;
    expect(p.analytics.desktop).toMatchObject({ impressions: 1, clicks: 1, autoCloses: 1, manualCloses: 0 });
    expect(p.analytics.mobile).toMatchObject({ impressions: 1, manualCloses: 1 });
  });

  it("does not count events for drafts, paused or unknown popups", async () => {
    const draft = await create();
    const did = draft.body.data.popup.id;
    await send(did, { type: "IMPRESSION", device: "desktop" }).expect(204);
    expect((await Popup.findById(did))!.analytics.desktop.impressions).toBe(0);

    const { id } = await createAndPublish();
    await request(app).patch(`/api/admin/popups/${id}/status`).set("Cookie", authCookie(admin)).send({ status: "PAUSED" });
    await send(id, { type: "IMPRESSION", device: "desktop" }).expect(204);
    expect((await Popup.findById(id))!.analytics.desktop.impressions).toBe(0);

    await send(new mongoose.Types.ObjectId().toString(), { type: "IMPRESSION", device: "desktop" }).expect(204);
    await send("not-an-id", { type: "IMPRESSION", device: "desktop" }).expect(204);
  });

  it("rejects malformed event payloads", async () => {
    const { id } = await createAndPublish();
    await send(id, { type: "HACK", device: "desktop" }).expect(400);
    await send(id, { type: "IMPRESSION", device: "tv" }).expect(400);
    await send(id, { type: "IMPRESSION", device: "desktop", extra: 1 }).expect(400);
  });
});

describe("list", () => {
  it("hides archived by default, finds by name, and exposes effectiveState", async () => {
    const c = await create({ name: `${NAME_PREFIX}-findme` });
    const id = c.body.data.popup.id;
    const found = await request(app).get(`/api/admin/popups?search=${NAME_PREFIX}-findme`).set("Cookie", authCookie(admin));
    expect(found.body.data.items[0].effectiveState).toBe("DRAFT");
    await request(app).delete(`/api/admin/popups/${id}`).set("Cookie", authCookie(admin)).expect(200);
    const after = await request(app).get(`/api/admin/popups?search=${NAME_PREFIX}-findme`).set("Cookie", authCookie(admin));
    expect(after.body.data.items).toHaveLength(0);
    const archived = await request(app).get(`/api/admin/popups?search=${NAME_PREFIX}-findme&status=ARCHIVED`).set("Cookie", authCookie(admin));
    expect(archived.body.data.items).toHaveLength(1);
    const edit = await request(app).patch(`/api/admin/popups/${id}`).set("Cookie", authCookie(admin)).send({ name: "x" });
    expect(edit.status).toBe(409);
  });
});

describe("offer countdown", () => {
  const future = () => new Date(Date.now() + 86_400_000).toISOString();

  it("defaults to off and is exposed on the public DTO", async () => {
    const { id } = await createAndPublish();
    const p = (await livePopups()).find((x) => x.id === id) as unknown as { countdown: unknown };
    expect(p.countdown).toEqual({ enabled: false, endsAt: null });
  });

  it("round-trips an enabled countdown to the public DTO", async () => {
    const ends = future();
    const { id } = await createAndPublish({ countdown: { enabled: true, endsAt: ends } });
    const p = (await livePopups()).find((x) => x.id === id) as unknown as { countdown: { enabled: boolean; endsAt: string } };
    expect(p.countdown.enabled).toBe(true);
    expect(new Date(p.countdown.endsAt).getTime()).toBe(new Date(ends).getTime());
  });

  it("rejects enabled without an end time (create and PATCH)", async () => {
    expect((await create({ countdown: { enabled: true } })).status).toBe(400);
    const c = await create();
    const res = await request(app)
      .patch(`/api/admin/popups/${c.body.data.popup.id}`)
      .set("Cookie", authCookie(admin))
      .send({ countdown: { enabled: true, endsAt: null } });
    expect(res.status).toBe(400);
  });

  it("PATCH can turn it on and off", async () => {
    const c = await create();
    const id = c.body.data.popup.id;
    const on = await request(app).patch(`/api/admin/popups/${id}`).set("Cookie", authCookie(admin)).send({ countdown: { enabled: true, endsAt: future() } });
    expect(on.body.data.popup.countdown.enabled).toBe(true);
    const off = await request(app).patch(`/api/admin/popups/${id}`).set("Cookie", authCookie(admin)).send({ countdown: { enabled: false } });
    expect(off.body.data.popup.countdown.enabled).toBe(false);
  });
});
