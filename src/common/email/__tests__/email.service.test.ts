import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sendMail: vi.fn(),
  createTransport: vi.fn(),
  env: {
    smtpHost: "smtp.example.test", smtpPort: 587,
    smtpUser: "sender@example.test", smtpPass: "test-password", smtpFrom: "Kaicho <sender@example.test>",
  },
}));
vi.mock("../../../config/env", () => ({ env: state.env }));
vi.mock("nodemailer", () => ({ default: { createTransport: state.createTransport } }));

const message = { to: "customer@example.test", subject: "Order confirmed", html: "<p>Private order</p>", text: "Private order" };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  state.env.smtpHost = "smtp.example.test";
  state.env.smtpPort = 587;
  state.sendMail.mockReset().mockResolvedValue({ accepted: [message.to], rejected: [], pending: [] });
  state.createTransport.mockReset().mockReturnValue({ sendMail: state.sendMail });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SMTP email delivery", () => {
  it("uses one transport with bounded timeouts and submits text and HTML", async () => {
    const { sendEmail } = await import("../email.service");
    await sendEmail(message);
    await sendEmail(message);
    expect(state.createTransport).toHaveBeenCalledTimes(1);
    expect(state.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      port: 587, secure: false, connectionTimeout: 10_000,
      greetingTimeout: 10_000, socketTimeout: 10_000, dnsTimeout: 10_000,
    }));
    expect(state.sendMail).toHaveBeenCalledWith({ ...message, from: state.env.smtpFrom });
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("c***@example.test"));
    expect(console.info).not.toHaveBeenCalledWith(expect.stringContaining(message.to));
  });

  it("requires immediate TLS on port 465", async () => {
    state.env.smtpPort = 465;
    const { sendEmail } = await import("../email.service");
    await sendEmail(message);
    expect(state.createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
  });

  it("reports missing or invalid SMTP configuration instead of claiming success", async () => {
    const { sendEmail } = await import("../email.service");
    state.env.smtpHost = "";
    await expect(sendEmail(message)).rejects.toThrow("configure SMTP_HOST");
    state.env.smtpHost = "smtp.example.test";
    state.env.smtpPort = NaN;
    await expect(sendEmail(message)).rejects.toThrow("SMTP_PORT");
    expect(state.sendMail).not.toHaveBeenCalled();
  });

  it("retries an explicit temporary SMTP refusal", async () => {
    state.sendMail.mockRejectedValueOnce({ code: "EENVELOPE", responseCode: 450, command: "RCPT TO" });
    const { sendEmail } = await import("../email.service");
    const delivery = sendEmail(message);
    await vi.runAllTimersAsync();
    await delivery;
    expect(state.sendMail).toHaveBeenCalledTimes(2);
  });

  it("bounds retries and logs no private body or raw response", async () => {
    state.sendMail.mockRejectedValue({ code: "EENVELOPE", responseCode: 451, command: "RCPT TO", message: message.text, response: message.to });
    const { sendEmail } = await import("../email.service");
    const delivery = expect(sendEmail(message)).rejects.toThrow("EENVELOPE, SMTP 451");
    await vi.runAllTimersAsync();
    await delivery;
    expect(state.sendMail).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(message.to);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(message.text);
  });

  it.each([
    { code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" },
    { code: "ETIMEDOUT", command: "CONN" },
    { code: "ESOCKET", command: "CONN" },
  ])("does not retry permanent or ambiguous failures ($code)", async (failure) => {
    state.sendMail.mockRejectedValue(failure);
    const { sendEmail } = await import("../email.service");
    await expect(sendEmail(message)).rejects.toThrow(failure.code);
    expect(state.sendMail).toHaveBeenCalledTimes(1);
  });

  it("reports partial recipient rejection without duplicating accepted mail", async () => {
    state.sendMail.mockResolvedValue({ accepted: [message.to], rejected: ["other@example.test"], pending: [] });
    const { sendEmail } = await import("../email.service");
    await expect(sendEmail({ ...message, to: `${message.to}, other@example.test` })).rejects.toThrow("1 accepted, 1 rejected");
    expect(state.sendMail).toHaveBeenCalledTimes(1);
  });
});
