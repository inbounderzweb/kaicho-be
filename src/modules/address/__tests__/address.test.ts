import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";

const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];

async function makeUser() {
  const user = await User.create({
    phone: `71${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: "user",
  });
  createdUserIds.push(user._id);
  return user;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user)}`;
}

const VALID_ADDRESS = {
  label: "Home",
  line1: "12 Marine Drive",
  line2: "Near the pier",
  city: "Mumbai",
  state: "Maharashtra",
  pincode: "400020",
};

async function addAddress(user: InstanceType<typeof User>, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/addresses")
    .set("Cookie", authCookie(user))
    .send({ ...VALID_ADDRESS, ...overrides });
  return res;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("Address API — auth requirement", () => {
  it("401s without a session", async () => {
    expect((await request(app).get("/api/addresses")).status).toBe(401);
    expect((await request(app).post("/api/addresses").send(VALID_ADDRESS)).status).toBe(401);
  });
});

describe("Address API — CRUD", () => {
  it("starts empty and adds an address", async () => {
    const user = await makeUser();

    const empty = await request(app).get("/api/addresses").set("Cookie", authCookie(user));
    expect(empty.status).toBe(200);
    expect(empty.body.data.items).toEqual([]);

    const created = await addAddress(user);
    expect(created.status).toBe(201);
    expect(created.body.data.address.line1).toBe(VALID_ADDRESS.line1);

    const list = await request(app).get("/api/addresses").set("Cookie", authCookie(user));
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items[0].city).toBe("Mumbai");
  });

  it("makes the first address the default automatically", async () => {
    const user = await makeUser();
    const created = await addAddress(user);
    expect(created.body.data.address.isDefault).toBe(true);
  });

  it("rejects an invalid pincode with 400", async () => {
    const user = await makeUser();
    const res = await addAddress(user, { pincode: "12" });
    expect(res.status).toBe(400);
  });

  it("updates an address in place", async () => {
    const user = await makeUser();
    const created = await addAddress(user);
    const addressId = created.body.data.address.addressId;

    const res = await request(app)
      .patch(`/api/addresses/${addressId}`)
      .set("Cookie", authCookie(user))
      .send({ city: "Pune", label: "Office" });

    expect(res.status).toBe(200);
    expect(res.body.data.address.city).toBe("Pune");
    expect(res.body.data.address.label).toBe("Office");
    // Untouched fields survive a partial patch.
    expect(res.body.data.address.line1).toBe(VALID_ADDRESS.line1);
  });

  it("404s updating an address that does not exist", async () => {
    const user = await makeUser();
    const res = await request(app)
      .patch(`/api/addresses/${new mongoose.Types.ObjectId().toString()}`)
      .set("Cookie", authCookie(user))
      .send({ city: "Pune" });
    expect(res.status).toBe(404);
  });

  it("deletes an address", async () => {
    const user = await makeUser();
    const created = await addAddress(user);
    const addressId = created.body.data.address.addressId;

    const res = await request(app)
      .delete(`/api/addresses/${addressId}`)
      .set("Cookie", authCookie(user));
    expect(res.status).toBe(200);

    const list = await request(app).get("/api/addresses").set("Cookie", authCookie(user));
    expect(list.body.data.items).toEqual([]);
  });
});

describe("Address API — default flag exclusivity", () => {
  it("only ever has one default address", async () => {
    const user = await makeUser();
    const first = await addAddress(user, { label: "First" });
    const second = await addAddress(user, { label: "Second", isDefault: true });

    const list = await request(app).get("/api/addresses").set("Cookie", authCookie(user));
    const defaults = list.body.data.items.filter((a: { isDefault: boolean }) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].addressId).toBe(second.body.data.address.addressId);
    expect(defaults[0].addressId).not.toBe(first.body.data.address.addressId);
  });

  it("PATCH /:addressId/default moves the flag", async () => {
    const user = await makeUser();
    const first = await addAddress(user, { label: "First" });
    await addAddress(user, { label: "Second", isDefault: true });

    const res = await request(app)
      .patch(`/api/addresses/${first.body.data.address.addressId}/default`)
      .set("Cookie", authCookie(user));
    expect(res.status).toBe(200);
    expect(res.body.data.address.isDefault).toBe(true);

    const list = await request(app).get("/api/addresses").set("Cookie", authCookie(user));
    const defaults = list.body.data.items.filter((a: { isDefault: boolean }) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].addressId).toBe(first.body.data.address.addressId);
  });

  it("promotes another address when the default one is deleted", async () => {
    const user = await makeUser();
    const first = await addAddress(user, { label: "First" });
    await addAddress(user, { label: "Second" });

    await request(app)
      .delete(`/api/addresses/${first.body.data.address.addressId}`)
      .set("Cookie", authCookie(user));

    const list = await request(app).get("/api/addresses").set("Cookie", authCookie(user));
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].isDefault).toBe(true);
  });

  it("one user cannot touch another user's address", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const created = await addAddress(userA);
    const addressId = created.body.data.address.addressId;

    const read = await request(app).get("/api/addresses").set("Cookie", authCookie(userB));
    expect(read.body.data.items).toEqual([]);

    const patched = await request(app)
      .patch(`/api/addresses/${addressId}`)
      .set("Cookie", authCookie(userB))
      .send({ city: "Hacked" });
    expect(patched.status).toBe(404);

    const deleted = await request(app)
      .delete(`/api/addresses/${addressId}`)
      .set("Cookie", authCookie(userB));
    expect(deleted.status).toBe(404);

    // A's address is untouched.
    const listA = await request(app).get("/api/addresses").set("Cookie", authCookie(userA));
    expect(listA.body.data.items[0].city).toBe("Mumbai");
  });
});
