import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, StoreSettings, STORE_SETTINGS_DEFAULTS } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import { getShippingPolicy, updateStoreSettings } from "../settings.service";
import { previewCheckout } from "../../checkout/checkout.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `73${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
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

beforeAll(async () => {
  await connectDatabase();
  // The settings doc is a singleton — reset it so ordering with other suites
  // that may have mutated it can't make these assertions flaky.
  await StoreSettings.deleteMany({});
});

afterAll(async () => {
  await StoreSettings.deleteMany({});
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("settings.service (unit)", () => {
  it("materialises the singleton with the shipped defaults on first read", async () => {
    const policy = await getShippingPolicy();
    expect(policy).toEqual({ ...STORE_SETTINGS_DEFAULTS });
    expect(await StoreSettings.countDocuments({})).toBe(1);
  });

  it("updates a single field and records who touched it", async () => {
    const admin = await makeUser("admin");
    const dto = await updateStoreSettings({ freeShippingThreshold: 799 }, admin._id.toString());
    expect(dto.freeShippingThreshold).toBe(799);
    expect(dto.flatShippingFee).toBe(STORE_SETTINGS_DEFAULTS.flatShippingFee);

    const doc = await StoreSettings.findOne({ key: "store" }).lean();
    expect(doc?.updatedBy?.toString()).toBe(admin._id.toString());
    expect(await StoreSettings.countDocuments({})).toBe(1);
  });
});

describe("Settings API — auth and validation", () => {
  it("public GET /settings returns the shipping policy unauthenticated", async () => {
    const res = await request(app).get("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toMatchObject({
      freeShippingThreshold: expect.any(Number),
      flatShippingFee: expect.any(Number),
    });
  });

  it("403s a non-admin on GET /admin/settings", async () => {
    const user = await makeUser("user");
    const res = await request(app).get("/api/admin/settings").set("Cookie", authCookie(user));
    expect(res.status).toBe(403);
  });

  it("401s an anonymous request to /admin/settings", async () => {
    const res = await request(app).get("/api/admin/settings");
    expect(res.status).toBe(401);
  });

  it("lets an admin PATCH the shipping policy", async () => {
    const admin = await makeUser("admin");
    const res = await request(app)
      .patch("/api/admin/settings")
      .set("Cookie", authCookie(admin))
      .send({ freeShippingThreshold: 599, flatShippingFee: 39 });
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toMatchObject({ freeShippingThreshold: 599, flatShippingFee: 39 });
  });

  it("rejects a negative amount", async () => {
    const admin = await makeUser("admin");
    const res = await request(app)
      .patch("/api/admin/settings")
      .set("Cookie", authCookie(admin))
      .send({ flatShippingFee: -10 });
    expect(res.status).toBe(400);
  });

  it("rejects an empty PATCH body", async () => {
    const admin = await makeUser("admin");
    const res = await request(app)
      .patch("/api/admin/settings")
      .set("Cookie", authCookie(admin))
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("checkout uses the configured shipping policy", () => {
  it("computeOrderTotals in previewCheckout reflects an admin change", async () => {
    // Threshold high enough that a small cart never reaches it, fee distinct
    // from the default so the assertion is unambiguous.
    await updateStoreSettings({ freeShippingThreshold: 5000, flatShippingFee: 77 });
    const preview = await previewCheckout({ items: [] });
    expect(preview.pricing.shippingFee).toBe(77);
  });
});
