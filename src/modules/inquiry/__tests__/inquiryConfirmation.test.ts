import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";

const sendEmail = vi.fn();
vi.mock("../../../common/email/email.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../common/email/email.service")>()),
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

import app from "../../../app";
import { connectDatabase } from "../../../database/connection";
import { Inquiry, InquiryActivity } from "../../../database/models";
import { createInquiryFromForm } from "../inquiry.service";

const RUN_ID = Date.now().toString().slice(-6);
const numbers: string[] = [];

// The email is sent fire-and-forget, so let it settle.
const settle = () => new Promise((r) => setTimeout(r, 300));

beforeAll(async () => {
  await connectDatabase();
});

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue(undefined);
});

afterAll(async () => {
  const docs = await Inquiry.find({ inquiryNumber: { $in: numbers } }).select("_id").lean();
  const ids = docs.map((d) => d._id);
  await InquiryActivity.deleteMany({ inquiryId: { $in: ids } });
  await Inquiry.deleteMany({ _id: { $in: ids } });
  await mongoose.connection.close();
});

describe("inquiry confirmation email", () => {
  it("emails the sender a confirmation with their reference number (contact form)", async () => {
    const email = `contact-${RUN_ID}@example.com`;
    const res = await request(app)
      .post("/api/inquiries/contact")
      .send({ name: "Asha", email, message: "my secret question text" });
    expect(res.status).toBe(201);
    numbers.push(res.body.data.inquiryNumber);
    await settle();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe(email);
    expect(mail.subject).toContain(res.body.data.inquiryNumber);
    expect(mail.text).toContain(res.body.data.inquiryNumber);
    // never reflects what the submitter typed back at the address they supplied
    expect(mail.html + mail.text).not.toContain("my secret question text");
  });

  it("emails the sender for a B2B / bulk-order enquiry too", async () => {
    const email = `bulk-${RUN_ID}@example.com`;
    const res = await request(app)
      .post("/api/inquiries/bulk-order")
      .send({ name: "Ravi <b>Traders</b>", email, phone: "9876543210", quantity: 500, purpose: "Retail resale" });
    expect(res.status).toBe(201);
    numbers.push(res.body.data.inquiryNumber);
    await settle();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe(email);
    expect(mail.subject).toMatch(/bulk \/ B2B/);
    expect(mail.html).not.toContain("<b>Traders</b>"); // submitter-controlled name is escaped
  });

  it("still accepts the enquiry when sending the email fails", async () => {
    sendEmail.mockRejectedValue(new Error("smtp down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request(app)
      .post("/api/inquiries/contact")
      .send({ name: "Meera", email: `fail-${RUN_ID}@example.com`, message: "hello" });
    quiet.mockRestore();
    expect(res.status).toBe(201);
    numbers.push(res.body.data.inquiryNumber);
    await settle();
    expect(await Inquiry.countDocuments({ inquiryNumber: res.body.data.inquiryNumber })).toBe(1);
  });

  it("caps confirmations per address so the form can't flood someone's inbox", async () => {
    const email = `flood-${RUN_ID}@example.com`;
    for (let i = 0; i < 5; i++) {
      const { inquiryNumber } = await createInquiryFromForm("contact", { name: "Spam", email, message: `m${i}` });
      numbers.push(inquiryNumber);
    }
    await settle();
    expect(sendEmail).toHaveBeenCalledTimes(3); // all 5 enquiries stored, only 3 emails sent
    expect(await Inquiry.countDocuments({ email })).toBe(5);
  });
});
