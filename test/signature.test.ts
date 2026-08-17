import { describe, expect, it } from "vitest";
import { validationResponse, verifyZoomSignature, zoomSignature } from "../src/zoom-signature.js";

describe("Zoom webhook authentication", () => {
  const secret = "webhook-secret";
  const timestamp = "1700000000";
  const body = Buffer.from('{ "event": "test", "spacing": true }');

  it("verifies the exact raw body", () => {
    const signature = zoomSignature(secret, timestamp, body);
    expect(verifyZoomSignature(secret, timestamp, signature, body, 1_700_000_000_000)).toBe(true);
    expect(
      verifyZoomSignature(
        secret,
        timestamp,
        signature,
        Buffer.from('{"event":"test","spacing":true}'),
        1_700_000_000_000
      )
    ).toBe(false);
  });

  it("rejects missing, malformed, stale, and invalid signatures", () => {
    const signature = zoomSignature(secret, timestamp, body);
    expect(verifyZoomSignature(secret, undefined, signature, body, 1_700_000_000_000)).toBe(false);
    expect(verifyZoomSignature(secret, "invalid", signature, body, 1_700_000_000_000)).toBe(false);
    expect(verifyZoomSignature(secret, timestamp, signature, body, 1_700_001_000_000)).toBe(false);
    expect(verifyZoomSignature(secret, timestamp, "v0=wrong", body, 1_700_000_000_000)).toBe(false);
  });

  it("creates endpoint validation responses", () => {
    expect(validationResponse(secret, "plain")).toEqual({
      plainToken: "plain",
      encryptedToken: "a72ddf51a8b7764fb3c2d14ec3393c1daf85923c7b2e139c8bb9ed2c2038602e"
    });
  });
});
