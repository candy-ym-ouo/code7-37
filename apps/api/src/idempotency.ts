import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { AppError } from "./errors";
import { pool } from "./db";
import { fingerprintRequest } from "./idempotency-keys";

export {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_TTL_HOURS,
  fingerprintRequest,
  requireIdempotencyKey,
  stableStringify
} from "./idempotency-keys";

export type StoredResponse = {
  replay: true;
  status: number;
  body: unknown;
};

export type IdempotentHandle = {
  kind: "run";
  client: PoolClient;
};

type IdempotentOutcome = IdempotentHandle | StoredResponse;

/**
 * 以 (user_id, idempotency_key) 为唯一约束串行化同一逻辑请求：
 * - 首次请求：插入占位列并在同一事务内执行业务，提交时写入响应；
 * - 重试命中已完成记录：重放原状态码与响应体；
 * - 重试命中进行中记录：在记录行锁上等待，前序回滚则继续业务；
 * - 相同 key 但方法/路径/请求体不同：返回 IDEMPOTENCY_KEY_REUSED。
 *
 * 返回 run 句柄时，调用方拥有一个已开启事务的 client，必须以
 * completeIdempotent（提交）或 abortIdempotent（回滚）收尾，并释放 client。
 */
export async function acquireIdempotent(request: FastifyRequest, key: string): Promise<IdempotentOutcome> {
  const userId = request.user!.id;
  const method = request.method;
  const path = request.url.split("?")[0]!;
  const fingerprint = fingerprintRequest(method, path, request.body);

  const client = await pool.connect();
  await client.query("BEGIN");
  const upserted = await client.query<{
    request_method: string;
    request_path: string;
    request_fingerprint: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    `INSERT INTO idempotency_keys(user_id, idempotency_key, request_method, request_path, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, idempotency_key) DO UPDATE SET id = idempotency_keys.id
     RETURNING request_method, request_path, request_fingerprint, response_status, response_body`,
    [userId, key, method, path, fingerprint]
  );
  const row = upserted.rows[0]!;
  if (
    row.request_method !== method ||
    row.request_path !== path ||
    row.request_fingerprint !== fingerprint
  ) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key was already used with a different request",
      { method: row.request_method, path: row.request_path }
    );
  }
  if (row.response_status !== null) {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
    return { replay: true, status: row.response_status, body: row.response_body };
  }
  // 占位列即本请求所有：行锁保持到提交/回滚，并发重试会在上面的 UPSERT 处排队。
  return { kind: "run", client };
}

/** 业务事务成功后固化响应，随后提交释放行锁。 */
export async function completeIdempotent(
  client: PoolClient,
  request: FastifyRequest,
  key: string,
  status: number,
  body: unknown
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
     SET response_status = $3, response_body = $4::jsonb, completed_at = now()
     WHERE user_id = $1 AND idempotency_key = $2`,
    [request.user!.id, key, status, JSON.stringify(body ?? null)]
  );
  await client.query("COMMIT");
}

export async function abortIdempotent(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

export function releaseIdempotent(handle: IdempotentHandle): void {
  handle.client.release();
}

export function sendIdempotent(reply: FastifyReply, outcome: StoredResponse): void {
  reply.header("X-Idempotent-Replay", "true").code(outcome.status).send(outcome.body);
}
