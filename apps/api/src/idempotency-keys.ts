import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { AppError } from "./errors";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_TTL_HOURS = 24;

const KEY_PATTERN = /^[\x21-\x7E]{8,128}$/;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/** 同一请求方法、路径和规范化后的请求体必须得到同一指纹；字段顺序变化不会破坏幂等。 */
export function fingerprintRequest(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${path}\n${stableStringify(body ?? null)}`)
    .digest("hex");
}

/** 读取并校验 Idempotency-Key。创建/提交类接口必须携带。 */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || typeof key !== "string" || !KEY_PATTERN.test(key.trim())) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header (8-128 visible ASCII characters) is required"
    );
  }
  return key.trim();
}
