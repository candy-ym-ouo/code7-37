import { pool } from "./db";

/** 已完成的幂等记录只在重试窗口内需要保留，到期清理。 */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `DELETE FROM idempotency_keys
     WHERE completed_at IS NOT NULL
       AND completed_at < now() - interval '24 hours'
     RETURNING id`
  );
  return result.rowCount ?? 0;
}
