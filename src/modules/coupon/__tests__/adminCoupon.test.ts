import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Coupon, CouponUsage, CouponActivity } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { ensureCouponIndexes } from "../coupon.indexes";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];
const createdCouponIds: mongoose.Types.ObjectId[] = [];
let userSeq = 0;
let codeSeq = 0;

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `77${RUN_ID}${String(userSeq++).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
  });
  createdUserIds.push(user._id);
  return user;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

function code() {
  return `ADM${RUN_ID}${codeSeq++}`;
}

const validBody = (over: Record<string, unknown> = {}) => ({
  code: code(),
  name: "Admin test coupon",
  discountType: "PERCENTAGE",
  discountValue: 10,
  ...over,
});

let admin: InstanceType<typeof User>;
let normalUser: InstanceType<typeof User>;

beforeAll(async () => {
  await connectDatabase();
  await ensureCouponIndexes();
  admin = await makeUser("admin");
  normalUser = await makeUser("user");
});

afterAll(async () => {
  await CouponActivity.deleteMany({ couponId: { $in: createdCouponIds } });
  await CouponUsage.deleteMany({ couponId: { $in: createdCouponIds } });
  await Coupon.deleteMany({ _id: { $in: createdCouponIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

async function createCoupon(body: Record<string, unknown>) {
  const res = await request(app)
    .post("/api/admin/coupons")
    .set("Cookie", authCookie(admin))
    .send(body);
  if (res.status === 201) createdCouponIds.push(new mongoose.Types.ObjectId(res.body.data.coupon.id));
  return res;
}

describe("admin coupons — authorization", () => {
  it("401 without a session", async () => {
    const res = await request(app).get("/api/admin/coupons");
    expect(res.status).toBe(401);
  });
  it("403 for a non-admin user", async () => {
    const res = await request(app)
      .get("/api/admin/coupons")
      .set("Cookie", authCookie(normalUser));
    expect(res.status).toBe(403);
  });
  it("403 for a non-admin trying to create", async () => {
    const res = await request(app)
      .post("/api/admin/coupons")
      .set("Cookie", authCookie(normalUser))
      .send(validBody());
    expect(res.status).toBe(403);
  });
});

describe("admin coupons — create", () => {
  it("creates a percentage coupon, canonicalising the code, and logs CREATED", async () => {
    const raw = code().toLowerCase();
    const res = await createCoupon(validBody({ code: `  ${raw} `, discountValue: 15 }));
    expect(res.status).toBe(201);
    expect(res.body.data.coupon.code).toBe(raw.toUpperCase());
    expect(res.body.data.coupon.status).toBe("DRAFT");
    expect(res.body.data.coupon.effectiveStatus).toBe("DRAFT");
    expect(res.body.data.coupon.usedCount).toBe(0);

    const activity = await CouponActivity.findOne({
      couponId: res.body.data.coupon.id,
      action: "CREATED",
    }).lean();
    expect(activity).toBeTruthy();
  });

  it("creates a fixed and a free-delivery coupon", async () => {
    const fixed = await createCoupon(validBody({ discountType: "FIXED", discountValue: 200 }));
    expect(fixed.status).toBe(201);
    expect(fixed.body.data.coupon.discountType).toBe("FIXED");

    const free = await createCoupon(
      validBody({ discountType: "FREE_DELIVERY", discountValue: 0 })
    );
    expect(free.status).toBe(201);
    expect(free.body.data.coupon.discountValue).toBe(0);
  });

  it("rejects a duplicate code with 409", async () => {
    const c = code();
    const first = await createCoupon(validBody({ code: c }));
    expect(first.status).toBe(201);
    const dup = await createCoupon(validBody({ code: c.toLowerCase() }));
    expect(dup.status).toBe(409);
  });

  it("rejects invalid combinations with 400", async () => {
    const cases: Record<string, unknown>[] = [
      { discountType: "PERCENTAGE", discountValue: 120 },
      { discountValue: -100 },
      { minOrderValue: -500 },
      { startsAt: "2026-10-01", expiresAt: "2026-09-01" },
      { usageLimit: 0 },
      { usageLimit: 5, usageLimitPerUser: 10 },
    ];
    for (const over of cases) {
      const res = await createCoupon(validBody(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
  });
});

describe("admin coupons — list", () => {
  it("paginates, searches by code/name and filters by status", async () => {
    const marker = `FIND${RUN_ID}${codeSeq++}`;
    await createCoupon(validBody({ code: marker, name: "Findable coupon", status: "ACTIVE" }));

    const search = await request(app)
      .get(`/api/admin/coupons?search=${marker.toLowerCase()}`)
      .set("Cookie", authCookie(admin));
    expect(search.status).toBe(200);
    expect(search.body.data.items).toHaveLength(1);
    expect(search.body.data.items[0].code).toBe(marker);

    const byName = await request(app)
      .get("/api/admin/coupons?search=Findable")
      .set("Cookie", authCookie(admin));
    expect(byName.body.data.items.some((c: { code: string }) => c.code === marker)).toBe(true);

    const active = await request(app)
      .get("/api/admin/coupons?status=ACTIVE&pageSize=100")
      .set("Cookie", authCookie(admin));
    expect(active.body.data.items.every((c: { status: string }) => c.status === "ACTIVE")).toBe(true);
  });

  it("surfaces EXPIRED as an effective status even when stored status is ACTIVE", async () => {
    const res = await createCoupon(
      validBody({ status: "ACTIVE", expiresAt: new Date(Date.now() - 86_400_000).toISOString() })
    );
    expect(res.status).toBe(201);
    expect(res.body.data.coupon.status).toBe("ACTIVE");
    expect(res.body.data.coupon.effectiveStatus).toBe("EXPIRED");

    const filtered = await request(app)
      .get("/api/admin/coupons?status=EXPIRED&pageSize=100")
      .set("Cookie", authCookie(admin));
    expect(filtered.body.data.items.some((c: { id: string }) => c.id === res.body.data.coupon.id)).toBe(true);
  });
});

describe("admin coupons — update", () => {
  it("records a field-level diff in the activity trail", async () => {
    const created = await createCoupon(validBody({ discountValue: 20, maxDiscountAmount: 300 }));
    const id = created.body.data.coupon.id;

    const res = await request(app)
      .patch(`/api/admin/coupons/${id}`)
      .set("Cookie", authCookie(admin))
      .send({ discountValue: 25, maxDiscountAmount: 500 });
    expect(res.status).toBe(200);
    expect(res.body.data.coupon.discountValue).toBe(25);

    const activity = await CouponActivity.findOne({ couponId: id, action: "UPDATED" }).lean();
    expect(activity).toBeTruthy();
    const fields = activity!.changes.map((c) => `${c.field}: ${c.from} -> ${c.to}`);
    expect(fields).toContain("Discount: 20% -> 25%");
    expect(fields).toContain("Maximum discount: ₹300 -> ₹500");
  });

  it("rejects lowering the usage limit below what's already been redeemed", async () => {
    const created = await createCoupon(validBody({ usageLimit: 100 }));
    const id = created.body.data.coupon.id;
    await Coupon.updateOne({ _id: id }, { $set: { usedCount: 12 } });

    const res = await request(app)
      .patch(`/api/admin/coupons/${id}`)
      .set("Cookie", authCookie(admin))
      .send({ usageLimit: 5 });
    expect(res.status).toBe(400);
  });

  it("refuses to change the code once the coupon has been redeemed", async () => {
    const created = await createCoupon(validBody());
    const id = created.body.data.coupon.id;
    await Coupon.updateOne({ _id: id }, { $set: { usedCount: 1 } });

    const res = await request(app)
      .patch(`/api/admin/coupons/${id}`)
      .set("Cookie", authCookie(admin))
      .send({ code: `${code()}` });
    expect(res.status).toBe(409);
  });
});

describe("admin coupons — status lifecycle", () => {
  it("DRAFT → ACTIVE → PAUSED → ARCHIVED, and ARCHIVED is terminal", async () => {
    const created = await createCoupon(validBody());
    const id = created.body.data.coupon.id;

    const activate = await request(app)
      .post(`/api/admin/coupons/${id}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "ACTIVE" });
    expect(activate.status).toBe(200);
    expect(activate.body.data.coupon.status).toBe("ACTIVE");
    expect(await CouponActivity.countDocuments({ couponId: id, action: "ACTIVATED" })).toBe(1);

    const pause = await request(app)
      .post(`/api/admin/coupons/${id}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "PAUSED" });
    expect(pause.body.data.coupon.status).toBe("PAUSED");

    const archive = await request(app)
      .post(`/api/admin/coupons/${id}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "ARCHIVED" });
    expect(archive.body.data.coupon.status).toBe("ARCHIVED");

    const reactivate = await request(app)
      .post(`/api/admin/coupons/${id}/status`)
      .set("Cookie", authCookie(admin))
      .send({ status: "ACTIVE" });
    expect(reactivate.status).toBe(409);

    const edit = await request(app)
      .patch(`/api/admin/coupons/${id}`)
      .set("Cookie", authCookie(admin))
      .send({ name: "new name" });
    expect(edit.status).toBe(409);
  });
});

describe("admin coupons — usage history", () => {
  it("returns paginated redemptions with a customer label and the running total", async () => {
    const created = await createCoupon(validBody());
    const id = created.body.data.coupon.id;
    const buyer = await makeUser("user");
    buyer.firstName = "Asha";
    buyer.lastName = "Menon";
    await buyer.save();

    await Coupon.updateOne({ _id: id }, { $set: { usedCount: 1 } });
    await CouponUsage.create({
      couponId: new mongoose.Types.ObjectId(id),
      couponCode: created.body.data.coupon.code,
      userId: buyer._id,
      orderId: new mongoose.Types.ObjectId(),
      orderNumber: "ORD-USAGE-1",
      discountType: "PERCENTAGE",
      discountAmount: 100,
      freeDelivery: false,
      perUserSeq: 1,
      usedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/admin/coupons/${id}/usages`)
      .set("Cookie", authCookie(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.totalUsage).toBe(1);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].customer).toBe("Asha Menon");
    expect(res.body.data.items[0].orderNumber).toBe("ORD-USAGE-1");
    expect(res.body.data.items[0].discountAmount).toBe(100);
  });
});
