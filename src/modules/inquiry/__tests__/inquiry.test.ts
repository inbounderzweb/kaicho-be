import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { User, Inquiry, InquiryNote, InquiryActivity } from "../../../database/models";
import { signSessionToken } from "../../auth/auth.service";
import {
  createInquiryFromForm,
  changeInquiryStatus,
  assignInquiry,
  addInquiryNote,
  deleteInquiryAdmin,
  getInquiryAdmin,
  listInquiriesAdmin,
  getInquiryStats,
} from "../inquiry.service";
import { submitBulkOrderSchema, submitContactSchema } from "../inquiry.validation";

const RUN_ID = Date.now().toString().slice(-6);
const userIds: mongoose.Types.ObjectId[] = [];
const inquiryIds: mongoose.Types.ObjectId[] = [];

let admin: InstanceType<typeof User>;
let normalUser: InstanceType<typeof User>;

async function makeUser(role: "user" | "admin" = "user") {
  const user = await User.create({
    phone: `7${RUN_ID}${String(userIds.length).padStart(3, "0")}`,
    countryCode: "+91",
    phoneVerified: true,
    role,
    firstName: role === "admin" ? "Sales" : "Cust",
    lastName: role === "admin" ? "Admin" : "Omer",
  });
  userIds.push(user._id);
  return user;
}

function authCookie(user: InstanceType<typeof User>) {
  return `kaicho_session=${signSessionToken(user as any)}`;
}

async function track(inq: { inquiryNumber: string }) {
  const doc = await Inquiry.findOne({ inquiryNumber: inq.inquiryNumber }).select("_id").lean();
  if (doc) inquiryIds.push(doc._id);
  return doc!._id.toString();
}

beforeAll(async () => {
  await connectDatabase();
  admin = await makeUser("admin");
  normalUser = await makeUser("user");
});

afterAll(async () => {
  await InquiryNote.deleteMany({ inquiryId: { $in: inquiryIds } });
  await InquiryActivity.deleteMany({ inquiryId: { $in: inquiryIds } });
  await Inquiry.deleteMany({ _id: { $in: inquiryIds } });
  await User.deleteMany({ _id: { $in: userIds } });
  await mongoose.connection.close();
});

// ---------------------------------------------------------------------------

describe("inquiry public submit", () => {
  it("accepts a valid contact submission unauthenticated and returns only the number", async () => {
    const res = await request(app)
      .post("/api/inquiries/contact")
      .send({ name: `Rahul ${RUN_ID}`, email: `rahul${RUN_ID}@example.com`, message: "Tell me more" });
    expect(res.status).toBe(201);
    expect(res.body.data.inquiryNumber).toMatch(/^INQ-\d{8}-[A-Z0-9]{6}$/);
    expect(Object.keys(res.body.data)).toEqual(["inquiryNumber"]);
    await track(res.body.data);
  });

  it("rejects a contact submission with no message", async () => {
    const res = await request(app)
      .post("/api/inquiries/contact")
      .send({ name: "X", email: "x@example.com" });
    expect(res.status).toBe(400);
  });

  it("rejects a bad email", async () => {
    const res = await request(app)
      .post("/api/inquiries/contact")
      .send({ name: "X", email: "not-an-email", message: "hi" });
    expect(res.status).toBe(400);
  });

  it("accepts a valid bulk-order submission", async () => {
    const res = await request(app).post("/api/inquiries/bulk-order").send({
      name: `Corp ${RUN_ID}`,
      email: `corp${RUN_ID}@example.com`,
      phone: "+91 90000 00000",
      quantity: 500,
      purpose: "Corporate Order",
      message: "For a company event",
    });
    expect(res.status).toBe(201);
    const id = await track(res.body.data);
    const inq = await getInquiryAdmin(id);
    expect(inq!.formType).toBe("bulk_order");
    expect(inq!.quantity).toBe(500);
    expect(inq!.purpose).toBe("Corporate Order");
    // Stored in canonical +91XXXXXXXXXX form regardless of how it was typed.
    expect(inq!.phone).toBe("+919000000000");
  });

  it("rejects a bulk-order submission missing quantity + purpose", async () => {
    const res = await request(app)
      .post("/api/inquiries/bulk-order")
      .send({ name: "X", email: "x@example.com", phone: "+919000000000" });
    expect(res.status).toBe(400);
  });

  // Phone-rule specifics are unit-tested against the schema (the HTTP layer is
  // rate-limited, so a loop of submits would trip the limiter).
  it("validates the mobile number on both submit schemas", () => {
    for (const phone of ["12345", "+++abc", "1234567890", "0000000000", "12345678901234"]) {
      expect(submitBulkOrderSchema.safeParse({ name: "X", email: "x@e.com", phone, quantity: 10, purpose: "P" }).success).toBe(false);
      expect(submitContactSchema.safeParse({ name: "X", email: "x@e.com", phone, message: "hi" }).success).toBe(false);
    }
    for (const phone of ["9876543210", "98765 43210", "+91 98765 43210", "09876543210"]) {
      expect(submitBulkOrderSchema.safeParse({ name: "X", email: "x@e.com", phone, quantity: 10, purpose: "P" }).success).toBe(true);
    }
    // Contact phone is optional.
    expect(submitContactSchema.safeParse({ name: "X", email: "x@e.com", message: "hi" }).success).toBe(true);
    expect(submitContactSchema.safeParse({ name: "X", email: "x@e.com", phone: "", message: "hi" }).success).toBe(true);
  });

  it("stores any accepted mobile format as canonical +91XXXXXXXXXX", async () => {
    const inq = await createInquiryFromForm("contact", {
      name: `Ph ${RUN_ID}`,
      email: `ph${RUN_ID}@example.com`,
      phone: "0 98765-43210",
      message: "hi",
    } as any);
    const id = await track(inq);
    expect((await getInquiryAdmin(id))!.phone).toBe("+919876543210");
  });
});

describe("inquiry admin auth", () => {
  it("rejects the list without a session", async () => {
    const res = await request(app).get("/api/admin/inquiries");
    expect(res.status).toBe(401);
  });

  it("rejects the list for a non-admin", async () => {
    const res = await request(app).get("/api/admin/inquiries").set("Cookie", authCookie(normalUser));
    expect(res.status).toBe(403);
  });

  it("serves the list for an admin, filtered by formType", async () => {
    const res = await request(app)
      .get("/api/admin/inquiries?formType=bulk_order")
      .set("Cookie", authCookie(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.items.every((i: any) => i.formType === "bulk_order")).toBe(true);
  });
});

describe("inquiry lifecycle (service)", () => {
  it("logs a CREATED activity on submission", async () => {
    const inq = await createInquiryFromForm("contact", {
      name: `Act ${RUN_ID}`,
      email: `act${RUN_ID}@example.com`,
      message: "hello",
    });
    const id = await track(inq);
    const detail = await getInquiryAdmin(id);
    expect(detail!.activity).toHaveLength(1);
    expect(detail!.activity[0].action).toBe("CREATED");
    expect(detail!.activity[0].userName).toBeNull();
  });

  it("records a STATUS_CHANGED activity with old → new", async () => {
    const inq = await createInquiryFromForm("contact", {
      name: `St ${RUN_ID}`,
      email: `st${RUN_ID}@example.com`,
      message: "x",
    });
    const id = await track(inq);
    await changeInquiryStatus(id, "CONTACTED", admin._id.toString());
    const detail = await getInquiryAdmin(id);
    const change = detail!.activity.find((a) => a.action === "STATUS_CHANGED");
    expect(change).toMatchObject({ oldValue: "NEW", newValue: "CONTACTED" });
    expect(detail!.status).toBe("CONTACTED");
  });

  it("refuses to assign to a non-admin, allows an admin, and logs it", async () => {
    const inq = await createInquiryFromForm("contact", {
      name: `As ${RUN_ID}`,
      email: `as${RUN_ID}@example.com`,
      message: "x",
    });
    const id = await track(inq);
    await expect(assignInquiry(id, normalUser._id.toString(), admin._id.toString())).rejects.toMatchObject({
      statusCode: 400,
    });
    const detail = await assignInquiry(id, admin._id.toString(), admin._id.toString());
    expect(detail!.assignedTo?.userId).toBe(admin._id.toString());
    expect(detail!.activity.some((a) => a.action === "ASSIGNED")).toBe(true);
  });

  it("adds an internal note with author + a NOTE_ADDED activity", async () => {
    const inq = await createInquiryFromForm("contact", {
      name: `No ${RUN_ID}`,
      email: `no${RUN_ID}@example.com`,
      message: "x",
    });
    const id = await track(inq);
    const detail = await addInquiryNote(id, admin._id.toString(), "Follow up tomorrow");
    expect(detail!.notes).toHaveLength(1);
    expect(detail!.notes[0]).toMatchObject({ note: "Follow up tomorrow", userName: "Sales Admin" });
    expect(detail!.activity.some((a) => a.action === "NOTE_ADDED")).toBe(true);
  });

  it("hard-deletes an inquiry and cascades its notes + activities", async () => {
    const inq = await createInquiryFromForm("contact", {
      name: `De ${RUN_ID}`,
      email: `de${RUN_ID}@example.com`,
      message: "x",
    });
    const id = await track(inq);
    await addInquiryNote(id, admin._id.toString(), "note");
    await deleteInquiryAdmin(id, admin._id.toString());
    expect(await Inquiry.findById(id)).toBeNull();
    expect(await InquiryNote.countDocuments({ inquiryId: id })).toBe(0);
    expect(await InquiryActivity.countDocuments({ inquiryId: id })).toBe(0);
  });
});

describe("inquiry stats", () => {
  it("returns a total and a per-status breakdown", async () => {
    const stats = await getInquiryStats();
    expect(typeof stats.total).toBe("number");
    expect(stats.byStatus).toHaveProperty("NEW");
    expect(stats.byStatus).toHaveProperty("CONVERTED");
  });

  it("search matches on name/email", async () => {
    const inq = await createInquiryFromForm("contact", {
      name: `SearchMe ${RUN_ID}`,
      email: `findme${RUN_ID}@example.com`,
      message: "x",
    });
    await track(inq);
    const res = await listInquiriesAdmin({ page: 1, pageSize: 20, search: `findme${RUN_ID}` });
    expect(res.items.some((i) => i.email === `findme${RUN_ID}@example.com`)).toBe(true);
  });
});
