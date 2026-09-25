import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { fingerprintRequest, requireIdempotencyKey } from "./idempotency-keys";

function requestWithHeader(value: string | string[] | undefined): FastifyRequest {
  return { headers: { "idempotency-key": value }, user: { id: "user-1" } } as unknown as FastifyRequest;
}

describe("idempotency request fingerprint", () => {
  it("is stable regardless of object key order", () => {
    const first = fingerprintRequest("POST", "/api/v1/features", { a: 1, b: 2 });
    const second = fingerprintRequest("POST", "/api/v1/features", { b: 2, a: 1 });
    expect(first).toBe(second);
  });

  it("is stable regardless of array ordering semantics inside nested payloads", () => {
    const first = fingerprintRequest("POST", "/features", { tags: ["a", "b"], nested: { x: 1 } });
    const second = fingerprintRequest("POST", "/features", { nested: { x: 1 }, tags: ["a", "b"] });
    expect(first).toBe(second);
  });

  it("changes when method, path or body differ", () => {
    const base = fingerprintRequest("POST", "/features", { title: "x" });
    expect(fingerprintRequest("PATCH", "/features", { title: "x" })).not.toBe(base);
    expect(fingerprintRequest("POST", "/features/x/submit", { title: "x" })).not.toBe(base);
    expect(fingerprintRequest("POST", "/features", { title: "y" })).not.toBe(base);
  });
});

describe("requireIdempotencyKey", () => {
  it("accepts keys of 8-128 visible ASCII characters", () => {
    expect(requireIdempotencyKey(requestWithHeader("sub-create-abc123"))).toBe("sub-create-abc123");
    expect(requireIdempotencyKey(requestWithHeader("  sub-create-abc123  "))).toBe("sub-create-abc123");
  });

  it.each([undefined, "", "short", "有中文的键", "a".repeat(129)])("rejects invalid key %j", (value) => {
    try {
      requireIdempotencyKey(requestWithHeader(value));
      throw new Error("expected IDEMPOTENCY_KEY_REQUIRED");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect((error as AppError).statusCode).toBe(400);
    }
  });
});
