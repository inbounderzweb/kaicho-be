import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sendEmail: vi.fn(), env: { adminNotificationEmail: "admin@example.test" } }));
vi.mock("../../../config/env", () => ({ env: state.env }));
vi.mock("../../../common/email/email.service", () => ({ sendEmail: state.sendEmail }));
import { sendNewOrderEmail } from "../email";

beforeEach(() => {
  state.sendEmail.mockReset().mockResolvedValue(undefined);
  state.env.adminNotificationEmail = "admin@example.test";
});

describe("admin new-order email", () => {
  it("uses shared delivery with escaped customer details and a plain-text alternative", async () => {
    await sendNewOrderEmail({ orderNumber: "ORD-100", customerName: '<img src="x"> & Customer', amount: 350, itemsCount: 2 });
    const mail = state.sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("admin@example.test");
    expect(mail.html).toContain("&lt;img src=&quot;x&quot;&gt; &amp; Customer");
    expect(mail.html).not.toContain("<img");
    expect(mail.text).toContain("Order: ORD-100");
    expect(mail.text).toContain("Amount: ₹350");
  });

  it("reports failures without rejecting the order flow", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.sendEmail.mockRejectedValue(new Error("SMTP rejected"));
    await expect(sendNewOrderEmail({ orderNumber: "ORD-100", customerName: "Customer", amount: 350, itemsCount: 2 })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ORD-100"), "SMTP rejected");
    log.mockRestore();
  });
});
