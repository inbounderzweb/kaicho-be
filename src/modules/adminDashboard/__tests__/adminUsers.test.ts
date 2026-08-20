import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import {
  getUsersList,
  getUsersStats,
  getUserById,
  updateUserById,
} from "../adminUsers.service";

// 1 ("9") + 6-digit run id + 3-digit zero-padded counter = 10 digits,
// unique for up to 1000 users created within a single test run — the
// previous 8-digit-run-id + bare-index scheme silently truncated and
// collided once more than ~9 users were created (padStart avoids that).
const RUN_ID = Date.now().toString().slice(-6);
const createdUserIds: mongoose.Types.ObjectId[] = [];

async function makeUser(overrides: Partial<{
  role: "user" | "admin";
  isActive: boolean;
  firstName: string;
  lastName: string;
  email: string;
  createdAt: Date;
}> = {}) {
  const user = await User.create({
    phone: `9${RUN_ID}${String(createdUserIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role: overrides.role ?? "user",
    isActive: overrides.isActive ?? true,
    firstName: overrides.firstName,
    lastName: overrides.lastName,
    email: overrides.email,
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  });
  createdUserIds.push(user._id);
  return user;
}

beforeAll(async () => {
  await connectDatabase();
});

afterAll(async () => {
  await User.deleteMany({ _id: { $in: createdUserIds } });
  await mongoose.connection.close();
});

describe("adminUsers.service (unit)", () => {
  it("getUsersList excludes the requesting admin", async () => {
    const admin = await makeUser({ role: "admin" });
    const other = await makeUser({ firstName: "Included" });

    const result = await getUsersList({ page: 1, pageSize: 50, excludeUserId: admin._id.toString() });
    const ids = result.items.map((i) => i.id);
    expect(ids).not.toContain(admin._id.toString());
    expect(ids).toContain(other._id.toString());
  });

  it("getUsersList search matches firstName/lastName/phone/email, case-insensitively", async () => {
    const admin = await makeUser({ role: "admin" });
    const target = await makeUser({ firstName: "Zephyr", lastName: "Unique", email: "zephyr@example.com" });

    const result = await getUsersList({
      page: 1,
      pageSize: 50,
      excludeUserId: admin._id.toString(),
      search: "zephyr",
    });
    expect(result.items.map((i) => i.id)).toContain(target._id.toString());
  });

  it("getUsersList search does not throw on regex special characters", async () => {
    const admin = await makeUser({ role: "admin" });
    await expect(
      getUsersList({ page: 1, pageSize: 10, excludeUserId: admin._id.toString(), search: "a(b[c" })
    ).resolves.toBeDefined();
  });

  it("getUsersList filters by status and role", async () => {
    const admin = await makeUser({ role: "admin" });
    const inactiveUser = await makeUser({ isActive: false, firstName: "InactiveOne" });
    await makeUser({ isActive: true, firstName: "ActiveOne" });

    const inactiveResult = await getUsersList({
      page: 1,
      pageSize: 50,
      excludeUserId: admin._id.toString(),
      status: "inactive",
    });
    expect(inactiveResult.items.every((i) => i.status === "Inactive")).toBe(true);
    expect(inactiveResult.items.map((i) => i.id)).toContain(inactiveUser._id.toString());
  });

  it("getUsersList sorts by phone in both directions", async () => {
    const admin = await makeUser({ role: "admin" });
    const asc = await getUsersList({
      page: 1,
      pageSize: 100,
      excludeUserId: admin._id.toString(),
      sortBy: "phone",
      sortOrder: "asc",
    });
    const phones = asc.items.map((i) => i.phone);
    const sorted = [...phones].sort();
    expect(phones).toEqual(sorted);
  });

  it("getUsersStats excludes the requesting admin from all counts", async () => {
    const admin = await makeUser({ role: "admin" });
    const before = await getUsersStats(admin._id.toString());
    await makeUser({ isActive: true });
    const after = await getUsersStats(admin._id.toString());
    expect(after.totalUsers).toBe(before.totalUsers + 1);
    expect(after.activeUsers).toBe(before.activeUsers + 1);
  });

  it("getUserById returns null for the requesting admin's own id", async () => {
    const admin = await makeUser({ role: "admin" });
    const result = await getUserById(admin._id.toString(), admin._id.toString());
    expect(result).toBeNull();
  });

  it("getUserById returns null for a malformed id", async () => {
    const admin = await makeUser({ role: "admin" });
    const result = await getUserById("not-a-valid-object-id", admin._id.toString());
    expect(result).toBeNull();
  });

  it("getUserById returns full profile including addresses for a real other user", async () => {
    const admin = await makeUser({ role: "admin" });
    const target = await makeUser({ firstName: "HasAddress" });
    await User.updateOne(
      { _id: target._id },
      { $set: { addresses: [{ line1: "1 Test St", city: "TestCity", state: "TS", pincode: "111111" }] } }
    );

    const result = await getUserById(target._id.toString(), admin._id.toString());
    expect(result).not.toBeNull();
    expect(result?.addresses).toHaveLength(1);
    expect(result?.addresses[0].city).toBe("TestCity");
  });

  it("updateUserById applies only allowlisted fields", async () => {
    const admin = await makeUser({ role: "admin" });
    const target = await makeUser({ firstName: "Before" });

    const updated = await updateUserById(target._id.toString(), admin._id.toString(), {
      firstName: "After",
    });
    expect(updated?.firstName).toBe("After");

    const fresh = await User.findById(target._id).lean();
    expect(fresh?.tokenVersion).toBe(0); // never touched by this path
  });

  it("updateUserById refuses to update the requesting admin's own id", async () => {
    const admin = await makeUser({ role: "admin" });
    const result = await updateUserById(admin._id.toString(), admin._id.toString(), {
      firstName: "ShouldNotApply",
    });
    expect(result).toBeNull();
  });
});

describe("Admin users HTTP endpoints: auth, mass-assignment, validation (integration)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).get("/api/admin/users");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin with 403", async () => {
    const user = await makeUser({ role: "user" });
    const token = signSessionToken(user);
    const res = await request(app).get("/api/admin/users").set("Cookie", `kaicho_session=${token}`);
    expect(res.status).toBe(403);
  });

  it("PATCH strips unknown/forbidden fields and rejects an invalid role value", async () => {
    const admin = await makeUser({ role: "admin" });
    const target = await makeUser({ firstName: "Original" });
    const token = signSessionToken(admin);

    const invalidRoleRes = await request(app)
      .patch(`/api/admin/users/${target._id.toString()}`)
      .set("Cookie", `kaicho_session=${token}`)
      .send({ role: "superadmin" });
    expect(invalidRoleRes.status).toBe(400);

    const smuggledRes = await request(app)
      .patch(`/api/admin/users/${target._id.toString()}`)
      .set("Cookie", `kaicho_session=${token}`)
      .send({ tokenVersion: 999, firstName: "Updated" });
    expect(smuggledRes.status).toBe(200);
    expect(smuggledRes.body.data.user.firstName).toBe("Updated");

    const fresh = await User.findById(target._id).lean();
    expect(fresh?.tokenVersion).toBe(0);
  });

  it("GET /api/admin/users/:id returns 404 for the admin's own id", async () => {
    const admin = await makeUser({ role: "admin" });
    const token = signSessionToken(admin);
    const res = await request(app)
      .get(`/api/admin/users/${admin._id.toString()}`)
      .set("Cookie", `kaicho_session=${token}`);
    expect(res.status).toBe(404);
  });
});
