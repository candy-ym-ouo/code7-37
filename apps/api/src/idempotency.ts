import { z } from "zod";
import { AppError } from "./errors";

const idempotencyKeySchema = z.string().trim().min(8).max(100);

export function parseIdempotencyKey(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_FAILED", "Idempotency-Key must be 8-100 characters");
  }
  return parsed.data;
}
