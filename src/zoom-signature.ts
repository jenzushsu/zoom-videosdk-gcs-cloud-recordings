import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SIGNATURE_AGE_SECONDS = 300;

export const zoomSignature = (secret: string, timestamp: string, rawBody: Buffer): string => {
  const message = Buffer.concat([Buffer.from(`v0:${timestamp}:`), rawBody]);
  return `v0=${createHmac("sha256", secret).update(message).digest("hex")}`;
};

export const verifyZoomSignature = (
  secret: string,
  timestamp: string | undefined,
  provided: string | undefined,
  rawBody: Buffer,
  nowMs = Date.now()
): boolean => {
  if (!timestamp || !provided || !/^\d+$/.test(timestamp)) return false;
  const requestMs = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(requestMs) || Math.abs(nowMs - requestMs) > MAX_SIGNATURE_AGE_SECONDS * 1000)
    return false;

  const expected = Buffer.from(zoomSignature(secret, timestamp, rawBody));
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export const validationResponse = (secret: string, plainToken: string) => ({
  plainToken,
  encryptedToken: createHmac("sha256", secret).update(plainToken).digest("hex")
});
