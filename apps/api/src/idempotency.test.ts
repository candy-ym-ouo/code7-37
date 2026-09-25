import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { parseIdempotencyKey } from "./idempotency";

describe("parseIdempotencyKey", () => {
  it("returns null when the header is absent", () => {
    expect(parseIdempotencyKey(undefined)).toBeNull();
    expect(parseIdempotencyKey(["a", "b"])).toBeNull();
  });

  it("accepts and trims a valid key", () => {
    expect(parseIdempotencyKey("  550e8400-e29b-41d4-a716-446655440000  ")).toBe(
      "550e8400-e29b-41d4-a716-446655440000"
    );
  });

  it("rejects keys that are too short or too long", () => {
    for (const header of ["short", "x".repeat(101)]) {
      try {
        parseIdempotencyKey(header);
        expect.unreachable(`expected ${header.length} chars to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(400);
        expect((error as AppError).code).toBe("VALIDATION_FAILED");
      }
    }
  });
});
