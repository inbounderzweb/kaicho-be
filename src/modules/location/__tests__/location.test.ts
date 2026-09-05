import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import app from "../../../app";

// This module never touches Mongo — it's a pure proxy over `fetch` — so these
// tests stub global.fetch and hit the routes through supertest. No DB.

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 502,
    json: async () => body,
  } as unknown as Response;
}

const NOMINATIM_REVERSE = {
  lat: "12.9716",
  lon: "77.5946",
  display_name: "MG Road, Bengaluru, Karnataka, 560001, India",
  address: {
    road: "MG Road",
    suburb: "Shivaji Nagar",
    city: "Bengaluru",
    state: "Karnataka",
    postcode: "560001",
    country: "India",
    country_code: "in",
  },
};

const NOMINATIM_SEARCH = [
  {
    lat: "12.9716",
    lon: "77.5946",
    display_name: "Bengaluru, Karnataka, India",
    address: { city: "Bengaluru", state: "Karnataka", country: "India" },
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/location/reverse", () => {
  it("normalizes the provider response and echoes the caller's precise coords", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(NOMINATIM_REVERSE));

    const res = await request(app)
      .post("/api/location/reverse")
      .send({ lat: 12.34599, lng: 77.65432 });

    expect(res.status).toBe(200);
    expect(res.body.data.location).toMatchObject({
      city: "Bengaluru",
      state: "Karnataka",
      country: "India",
      postalCode: "560001",
      provider: "nominatim",
      approximate: false,
    });
    // The caller's exact fix is returned, not the rounded cache key.
    expect(res.body.data.location.latitude).toBe(12.34599);
    expect(res.body.data.location.longitude).toBe(77.65432);
    expect(res.body.data.location.displayName).toBe("Bengaluru, Karnataka");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects out-of-range coordinates with 400 and never calls the provider", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const res = await request(app).post("/api/location/reverse").send({ lat: 999, lng: 0 });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves an identical lookup from cache without a second upstream call", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(NOMINATIM_REVERSE));
    await request(app).post("/api/location/reverse").send({ lat: 19.111, lng: 72.222 });
    await request(app).post("/api/location/reverse").send({ lat: 19.1111, lng: 72.2222 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/location/search", () => {
  it("returns normalized suggestions", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse(NOMINATIM_SEARCH));
    const res = await request(app).get("/api/location/search").query({ q: "Bengaluru" });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(1);
    expect(res.body.data.results[0]).toMatchObject({ city: "Bengaluru", provider: "nominatim" });
  });

  it("rejects a too-short query", async () => {
    const res = await request(app).get("/api/location/search").query({ q: "a" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/location/serviceability", () => {
  it("reports India PIN codes as serviceable", async () => {
    const res = await request(app).get("/api/location/serviceability").query({ pincode: "560001" });
    expect(res.status).toBe(200);
    expect(res.body.data.serviceability).toMatchObject({ serviceable: true, pincode: "560001" });
  });

  it("reports a non-India country as not serviceable", async () => {
    const res = await request(app).get("/api/location/serviceability").query({ country: "Nepal" });
    expect(res.body.data.serviceability.serviceable).toBe(false);
  });

  it("rejects an invalid PIN", async () => {
    const res = await request(app).get("/api/location/serviceability").query({ pincode: "12ab" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/location/ip", () => {
  it("degrades gracefully for a loopback/private caller and never echoes the address", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const res = await request(app).get("/api/location/ip");
    // supertest connects over 127.0.0.1 → the private-IP guard short-circuits.
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("127.0.0.1");
  });
});
