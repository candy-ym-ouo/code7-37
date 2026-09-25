import { describe, expect, it } from "vitest";
import { ApiError } from "./api";

describe("ApiError", () => {
  it("preserves status, code and details", () => {
    const error = new ApiError(409, "MEDIA_NOT_READY", "not ready", { mediaStatus: "processing" });
    expect(error.status).toBe(409);
    expect(error.code).toBe("MEDIA_NOT_READY");
    expect(error.details).toEqual({ mediaStatus: "processing" });
  });

  it("marks server/network failures and expected conflicts as retryable", () => {
    expect(new ApiError(503, "QUEUE_UNAVAILABLE", "down").isRetryable).toBe(true);
    expect(new ApiError(429, "RATE_LIMITED", "slow down").isRetryable).toBe(true);
    expect(new ApiError(409, "ALREADY_SUBMITTED", "duplicate").isRetryable).toBe(true);
    expect(new ApiError(409, "MEDIA_OCCUPIED", "occupied").isRetryable).toBe(true);
  });

  it("does not suggest retrying definitive validation/auth responses", () => {
    expect(new ApiError(400, "VALIDATION_FAILED", "bad input").isRetryable).toBe(false);
    expect(new ApiError(401, "AUTH_REQUIRED", "login").isRetryable).toBe(false);
    expect(new ApiError(403, "FORBIDDEN", "nope").isRetryable).toBe(false);
    expect(new ApiError(404, "NOT_FOUND", "missing").isRetryable).toBe(false);
  });
});
