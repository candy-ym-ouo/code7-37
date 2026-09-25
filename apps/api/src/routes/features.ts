import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { createFeatureSchema } from "@map/shared/contracts";
import { query, transaction } from "../db";
import { AppError, conflict, forbidden, notFound } from "../errors";
import { optionalAuth, requireAuth, requireVerifiedContributor } from "../auth";
import { deleteObject, publicMediaUrl } from "../storage";
import { config } from "../config";
import { recordAudit } from "../audit";
import {
  abortIdempotent,
  acquireIdempotent,
  completeIdempotent,
  releaseIdempotent,
  requireIdempotencyKey,
  sendIdempotent,
  type IdempotentHandle
} from "../idempotency";

type MediaRow = {
  id: string;
  privacy_status: string;
  public_object_key: string | null;
  public_thumbnail_object_key: string | null;
};

function serializeMedia(media: MediaRow[] | null | undefined) {
  return (media ?? []).map((item) => ({
    id: item.id,
    status: item.privacy_status,
    url: publicMediaUrl(item.public_object_key),
    thumbnailUrl: publicMediaUrl(item.public_thumbnail_object_key)
  }));
}

function payloadWithDate(input: z.infer<typeof createFeatureSchema>) {
  return {
    ...input,
    observedAt: input.observedAt.toISOString()
  };
}

/** 媒体归属与隐私状态校验。提交和真正落库前都必须通过。 */
async function assertMediaUsable(client: PoolClient, ownerId: string, mediaIds: string[]) {
  if (mediaIds.length === 0) return;
  const result = await client.query<{ id: string; privacy_status: string }>(
    `SELECT id, privacy_status FROM media_assets
     WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND deleted_at IS NULL`,
    [mediaIds, ownerId]
  );
  if (result.rowCount !== mediaIds.length) {
    const found = new Set(result.rows.map((row) => row.id));
    throw new AppError(
      400,
      "MEDIA_NOT_FOUND",
      "One or more media items do not belong to this account or no longer exist",
      { mediaIds: mediaIds.filter((id) => !found.has(id)) }
    );
  }
  const invalid = result.rows.find((row) => !["ready", "manual_review"].includes(row.privacy_status));
  if (invalid) {
    throw new AppError(409, "MEDIA_NOT_READY", "All media must finish privacy processing before submission", {
      mediaId: invalid.id,
      mediaStatus: invalid.privacy_status
    });
  }
}

/**
 * 将媒体占用写入 feature_media_bindings。
 * 唯一约束 + DO UPDATE 的 WHERE 条件保证：
 * 已被其他投稿占用的媒体不会被静默抢占，而是返回 MEDIA_OCCUPIED 及占用方。
 */
async function claimMediaForFeature(client: PoolClient, featureId: string, mediaIds: string[]) {
  const uniqueIds = [...new Set(mediaIds)];
  if (uniqueIds.length === 0) return;
  const claimed = await client.query<{ media_id: string }>(
    `INSERT INTO feature_media_bindings(media_id, feature_id)
     SELECT unnest_id, $2 FROM unnest($1::uuid[]) AS unnest_id
     ON CONFLICT (media_id) DO UPDATE
       SET feature_id = EXCLUDED.feature_id, bound_at = now()
       WHERE feature_media_bindings.feature_id = EXCLUDED.feature_id
     RETURNING media_id`,
    [uniqueIds, featureId]
  );
  const claimedIds = new Set(claimed.rows.map((row) => row.media_id));
  const blocked = uniqueIds.filter((id) => !claimedIds.has(id));
  if (blocked.length > 0) {
    const blockers = await client.query<{ media_id: string; feature_id: string }>(
      "SELECT media_id, feature_id FROM feature_media_bindings WHERE media_id = ANY($1::uuid[]) AND feature_id <> $2",
      [blocked, featureId]
    );
    const row = blockers.rows.find((item) => blocked.includes(item.media_id));
    throw conflict(
      "MEDIA_OCCUPIED",
      "One or more media items are already attached to another contribution",
      row ? { mediaId: row.media_id, occupiedByFeatureId: row.feature_id } : { mediaIds: blocked }
    );
  }
}

/** 草稿放弃部分媒体时释放占用；已发布内容的修订不得释放当前公开版本仍在使用的媒体。 */
async function releaseUnclaimedDraftMedia(client: PoolClient, featureId: string, mediaIds: string[]) {
  await client.query(
    `DELETE FROM feature_media_bindings
     WHERE feature_id = $1 AND NOT (media_id = ANY($2::uuid[]))`,
    [featureId, [...new Set(mediaIds)]]
  );
}

function bboxFromString(value: string): [number, number, number, number] {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
    throw new AppError(400, "VALIDATION_FAILED", "bbox must contain four numbers");
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
  if (minLon === maxLon || minLat >= maxLat) throw new AppError(400, "VALIDATION_FAILED", "Invalid bbox order");
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new AppError(400, "VALIDATION_FAILED", "bbox is outside valid longitude/latitude ranges");
  }
  const longitudeSpan = minLon > maxLon ? 360 - minLon + maxLon : maxLon - minLon;
  if (longitudeSpan > 5 || maxLat - minLat > 5) throw new AppError(400, "VALIDATION_FAILED", "bbox is too large");
  return [minLon, minLat, maxLon, maxLat];
}

/** 在幂等事务内执行业务；失败回滚占位列以便同键重试，成功则固化响应。 */
async function withIdempotency<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  run: (client: PoolClient) => Promise<{ status: number; body: T }>
): Promise<void> {
  const key = requireIdempotencyKey(request);
  const outcome = await acquireIdempotent(request, key);
  if ("replay" in outcome) {
    sendIdempotent(reply, outcome);
    return;
  }
  const handle: IdempotentHandle = outcome;
  try {
    const result = await run(handle.client);
    await completeIdempotent(handle.client, request, key, result.status, result.body);
    reply.code(result.status).send(result.body);
  } catch (error) {
    await abortIdempotent(handle.client);
    throw error;
  } finally {
    releaseIdempotent(handle);
  }
}

async function writeRevisionMedia(client: PoolClient, revisionId: string, mediaIds: string[]) {
  await client.query("DELETE FROM revision_media WHERE revision_id = $1", [revisionId]);
  for (const [index, mediaId] of mediaIds.entries()) {
    await client.query(
      "INSERT INTO revision_media(revision_id, media_id, sort_order) VALUES ($1, $2, $3)",
      [revisionId, mediaId, index]
    );
  }
}

export async function featureRoutes(app: FastifyInstance) {
  app.get("/categories", async () => {
    const result = await query(
      `SELECT key, name, icon, detail_schema, detail_schema_version, sort_order
       FROM categories WHERE is_active = true ORDER BY sort_order, key`
    );
    return result.rows;
  });

  app.get("/features", async (request) => {
    const input = z.object({
      bbox: z.string(),
      category: z.string().optional(),
      condition: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(250)
    }).parse(request.query);

    const [minLon, minLat, maxLon, maxLat] = bboxFromString(input.bbox);
    const categories = input.category?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
    const values: unknown[] = [minLon, minLat, maxLon, maxLat, input.limit];
    const conditions = [
      "mf.status = 'published'",
      "mf.deleted_at IS NULL"
    ];
    if (minLon > maxLon) {
      conditions.push(`(
        ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope($1, $2, 180, $4), 4326)::geography)
        OR ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope(-180, $2, $3, $4), 4326)::geography)
      )`);
    } else {
      conditions.push("ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope($1, $2, $3, $4), 4326)::geography)");
    }

    if (categories.length) {
      values.push(categories);
      conditions.push(`mf.category_key = ANY($${values.length}::text[])`);
    }
    if (input.condition) {
      values.push(input.condition);
      conditions.push(`fr.payload->>'condition' = $${values.length}`);
    }

    const result = await query(
      `SELECT
         mf.id,
         mf.category_key,
         mf.status,
         mf.first_published_at,
         mf.freshness_expires_at,
         mf.needs_review_at,
         mf.updated_at,
         ST_X(mf.geom::geometry) AS longitude,
         ST_Y(mf.geom::geometry) AS latitude,
         c.name AS category_name,
         c.icon AS category_icon,
         fr.id AS revision_id,
         fr.payload,
         COALESCE(
           jsonb_agg(DISTINCT jsonb_build_object(
             'id', ma.id,
             'privacy_status', ma.privacy_status,
             'public_object_key', ma.public_object_key,
             'public_thumbnail_object_key', ma.public_thumbnail_object_key
           )) FILTER (WHERE ma.id IS NOT NULL),
           '[]'::jsonb
         ) AS media
       FROM map_features mf
       JOIN categories c ON c.key = mf.category_key
       JOIN feature_revisions fr ON fr.id = mf.current_revision_id
       LEFT JOIN revision_media rm ON rm.revision_id = fr.id
       LEFT JOIN media_assets ma ON ma.id = rm.media_id AND ma.deleted_at IS NULL
       WHERE ${conditions.join(" AND ")}
       GROUP BY mf.id, c.name, c.icon, fr.id
       ORDER BY mf.updated_at DESC
       LIMIT $5`,
      values
    );

    return result.rows.map((row) => ({
      id: row.id,
      categoryKey: row.category_key,
      categoryName: row.category_name,
      categoryIcon: row.category_icon,
      status: row.status,
      firstPublishedAt: row.first_published_at,
      freshnessExpiresAt: row.freshness_expires_at,
      needsReviewAt: row.needs_review_at,
      updatedAt: row.updated_at,
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      title: row.payload.title,
      description: row.payload.description,
      condition: row.payload.condition,
      details: row.payload.details,
      tags: row.payload.tags,
      media: serializeMedia(row.media)
    }));
  });

  app.get("/features/:id", { preHandler: optionalAuth }, async (request) => {
    const input = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `SELECT
         mf.id, mf.owner_id, mf.category_key, mf.status, mf.location_accuracy_m,
         mf.first_published_at, mf.freshness_expires_at, mf.needs_review_at,
         mf.created_at, mf.updated_at, mf.deleted_at,
         ST_X(mf.geom::geometry) AS longitude,
         ST_Y(mf.geom::geometry) AS latitude,
         c.name AS category_name, c.icon AS category_icon,
         COALESCE(mf.current_revision_id, latest.id) AS revision_id,
         COALESCE(current_revision.payload, latest.payload) AS payload,
         COALESCE(current_media.media, latest_media.media, '[]'::jsonb) AS media
       FROM map_features mf
       JOIN categories c ON c.key = mf.category_key
       LEFT JOIN feature_revisions current_revision ON current_revision.id = mf.current_revision_id
       LEFT JOIN LATERAL (
         SELECT id, payload FROM feature_revisions WHERE feature_id = mf.id ORDER BY revision_no DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id', ma.id,
           'privacy_status', ma.privacy_status,
           'public_object_key', ma.public_object_key,
           'public_thumbnail_object_key', ma.public_thumbnail_object_key
         ) ORDER BY rm.sort_order) AS media
         FROM revision_media rm
         JOIN media_assets ma ON ma.id = rm.media_id AND ma.deleted_at IS NULL
         WHERE rm.revision_id = COALESCE(mf.current_revision_id, latest.id)
       ) current_media ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id', ma.id,
           'privacy_status', ma.privacy_status,
           'public_object_key', ma.public_object_key,
           'public_thumbnail_object_key', ma.public_thumbnail_object_key
         ) ORDER BY rm.sort_order) AS media
         FROM revision_media rm
         JOIN media_assets ma ON ma.id = rm.media_id AND ma.deleted_at IS NULL
         WHERE rm.revision_id = latest.id
       ) latest_media ON true
       WHERE mf.id = $1`,
      [input.id]
    );
    const row = result.rows[0];
    if (!row || row.deleted_at) throw notFound("Feature not found");
    const canInspectPrivate = request.user && (request.user.id === row.owner_id || ["moderator", "admin"].includes(request.user.role));
    if (row.status !== "published" && !canInspectPrivate) throw notFound("Feature not found");

    const confirmations = await query(
      `SELECT result, count(*)::int AS count
       FROM feature_confirmations
       WHERE feature_id = $1 AND created_at > now() - interval '180 days'
       GROUP BY result`,
      [input.id]
    );

    return {
      id: row.id,
      ownerId: row.owner_id,
      categoryKey: row.category_key,
      categoryName: row.category_name,
      categoryIcon: row.category_icon,
      status: row.status,
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      locationAccuracyM: row.location_accuracy_m,
      firstPublishedAt: row.first_published_at,
      freshnessExpiresAt: row.freshness_expires_at,
      needsReviewAt: row.needs_review_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...row.payload,
      media: serializeMedia(row.media),
      confirmations: confirmations.rows
    };
  });

  // 创建草稿：必须携带 Idempotency-Key，网络重试返回同一草稿，绝不重复落库。
  app.post("/features", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const input = createFeatureSchema.parse(request.body);
    const userId = request.user!.id;
    await withIdempotency(request, reply, async (client) => {
      const category = await client.query("SELECT 1 FROM categories WHERE key = $1 AND is_active = true", [input.categoryKey]);
      if (!category.rowCount) throw new AppError(400, "VALIDATION_FAILED", "Unknown category");
      await assertMediaUsable(client, userId, input.mediaIds);

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO map_features(category_key, owner_id, geom, location_accuracy_m, status)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, 'draft')
         RETURNING id`,
        [input.categoryKey, userId, input.longitude, input.latitude, input.locationAccuracyM]
      );
      const featureId = inserted.rows[0]!.id;
      const revision = await client.query<{ id: string }>(
        `INSERT INTO feature_revisions(feature_id, author_id, revision_no, payload, status)
         VALUES ($1, $2, 1, $3::jsonb, 'draft')
         RETURNING id`,
        [featureId, userId, JSON.stringify(payloadWithDate(input))]
      );
      const revisionId = revision.rows[0]!.id;
      await claimMediaForFeature(client, featureId, input.mediaIds);
      await writeRevisionMedia(client, revisionId, input.mediaIds);
      await recordAudit(client, {
        actorId: userId,
        action: "feature.draft_created",
        resourceType: "feature",
        resourceId: featureId,
        metadata: { categoryKey: input.categoryKey }
      });
      return { status: 201, body: { id: featureId, status: "draft" } };
    });
  });

  app.patch("/features/:id/draft", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = createFeatureSchema.parse(request.body);
    const userId = request.user!.id;

    await transaction(async (client) => {
      const feature = await client.query<{ status: string; owner_id: string }>(
        "SELECT status, owner_id FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const row = feature.rows[0];
      if (!row) throw notFound("Feature not found");
      if (row.owner_id !== userId) throw forbidden();
      if (!["draft", "rejected", "changes_requested"].includes(row.status)) {
        throw conflict("FEATURE_NOT_EDITABLE", "Only draft or rejected content can be edited at this endpoint");
      }
      const category = await client.query("SELECT 1 FROM categories WHERE key = $1 AND is_active = true", [input.categoryKey]);
      if (!category.rowCount) throw new AppError(400, "VALIDATION_FAILED", "Unknown or inactive category");
      await assertMediaUsable(client, userId, input.mediaIds);
      const revision = await client.query<{ id: string }>(
        "SELECT id FROM feature_revisions WHERE feature_id = $1 ORDER BY revision_no DESC LIMIT 1 FOR UPDATE",
        [params.id]
      );
      const revisionId = revision.rows[0]?.id;
      if (!revisionId) throw notFound("Revision not found");
      await claimMediaForFeature(client, params.id, input.mediaIds);
      await writeRevisionMedia(client, revisionId, input.mediaIds);
      await releaseUnclaimedDraftMedia(client, params.id, input.mediaIds);
      await client.query(
        `UPDATE feature_revisions
         SET payload = $2::jsonb, status = 'draft', rejection_reason_code = NULL, moderation_notes = NULL, updated_at = now()
         WHERE id = $1`,
        [revisionId, JSON.stringify(payloadWithDate(input))]
      );
      await client.query(
        `UPDATE map_features
         SET category_key = $2, geom = ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
             location_accuracy_m = $5, status = 'draft', updated_at = now()
         WHERE id = $1`,
        [params.id, input.categoryKey, input.longitude, input.latitude, input.locationAccuracyM]
      );
    });

    return { status: "draft" };
  });

  app.post("/features/:id/submit", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const userId = request.user!.id;
    await withIdempotency(request, reply, async (client) => {
      await submitRevision(client, undefined, params.id, userId);
      return { status: 200, body: { status: "pending" } };
    });
  });

  app.post("/features/:id/revisions", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = createFeatureSchema.parse(request.body);
    const userId = request.user!.id;
    await withIdempotency(request, reply, async (client) => {
      const feature = await client.query<{ owner_id: string; status: string }>(
        "SELECT owner_id, status FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const row = feature.rows[0];
      if (!row) throw notFound("Feature not found");
      if (row.owner_id !== userId) throw forbidden();
      if (row.status === "deleted") throw conflict("FEATURE_DELETED", "Deleted content cannot be revised");
      const category = await client.query("SELECT 1 FROM categories WHERE key = $1 AND is_active = true", [input.categoryKey]);
      if (!category.rowCount) throw new AppError(400, "VALIDATION_FAILED", "Unknown or inactive category");
      const pending = await client.query(
        "SELECT 1 FROM feature_revisions WHERE feature_id = $1 AND status = 'pending' LIMIT 1",
        [params.id]
      );
      if (pending.rowCount) throw conflict("REVISION_ALREADY_PENDING", "A revision is already waiting for moderation");
      await assertMediaUsable(client, userId, input.mediaIds);
      const next = await client.query<{ next: number }>(
        "SELECT COALESCE(MAX(revision_no), 0) + 1 AS next FROM feature_revisions WHERE feature_id = $1",
        [params.id]
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO feature_revisions(feature_id, author_id, revision_no, payload, status)
         VALUES ($1, $2, $3, $4::jsonb, 'draft') RETURNING id`,
        [params.id, userId, next.rows[0]!.next, JSON.stringify(payloadWithDate(input))]
      );
      const revisionId = inserted.rows[0]!.id;
      await claimMediaForFeature(client, params.id, input.mediaIds);
      await writeRevisionMedia(client, revisionId, input.mediaIds);
      return { status: 201, body: { id: revisionId, status: "draft" } };
    });
  });

  app.post("/features/:id/revisions/:revisionId/submit", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    const userId = request.user!.id;
    await withIdempotency(request, reply, async (client) => {
      await submitRevision(client, params.revisionId, params.id, userId);
      return { status: 200, body: { status: "pending" } };
    });
  });

  app.get("/features/:id/revisions", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const feature = await query<{ owner_id: string }>("SELECT owner_id FROM map_features WHERE id = $1 AND deleted_at IS NULL", [params.id]);
    const row = feature.rows[0];
    if (!row) throw notFound("Feature not found");
    if (row.owner_id !== request.user!.id && !["moderator", "admin"].includes(request.user!.role)) throw forbidden();
    const result = await query(
      `SELECT id, revision_no, status, payload, submitted_at, reviewed_at, rejection_reason_code, moderation_notes, created_at, updated_at
       FROM feature_revisions WHERE feature_id = $1 ORDER BY revision_no DESC`,
      [params.id]
    );
    return result.rows;
  });

  app.delete("/features/:id", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const media = await transaction(async (client) => {
      const result = await client.query<{ owner_id: string }>(
        "SELECT owner_id FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const row = result.rows[0];
      if (!row) throw notFound("Feature not found");
      const canDelete = row.owner_id === request.user!.id || ["moderator", "admin"].includes(request.user!.role);
      if (!canDelete) throw forbidden();

      const mediaResult = await client.query<{
        id: string;
        quarantine_object_key: string;
        processed_object_key: string | null;
        thumbnail_object_key: string | null;
        public_object_key: string | null;
        public_thumbnail_object_key: string | null;
      }>(
        `SELECT DISTINCT ma.id, ma.quarantine_object_key, ma.processed_object_key,
                ma.thumbnail_object_key, ma.public_object_key, ma.public_thumbnail_object_key
         FROM revision_media rm
         JOIN feature_revisions fr ON fr.id = rm.revision_id
         JOIN media_assets ma ON ma.id = rm.media_id
         WHERE fr.feature_id = $1 AND ma.deleted_at IS NULL`,
        [params.id]
      );

      await client.query(
        "UPDATE map_features SET status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1",
        [params.id]
      );
      await client.query("DELETE FROM feature_media_bindings WHERE feature_id = $1", [params.id]);
      if (mediaResult.rowCount) {
        await client.query(
          `UPDATE media_assets SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
           WHERE id = ANY($1::uuid[])`,
          [mediaResult.rows.map((item) => item.id)]
        );
      }
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.deleted",
        resourceType: "feature",
        resourceId: params.id,
        metadata: { mediaCount: mediaResult.rowCount }
      });
      return mediaResult.rows;
    });

    const removals = media.flatMap((item) => [
      deleteObject(config.S3_QUARANTINE_BUCKET, item.quarantine_object_key),
      item.processed_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.processed_object_key) : Promise.resolve(),
      item.thumbnail_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.thumbnail_object_key) : Promise.resolve(),
      item.public_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_object_key) : Promise.resolve(),
      item.public_thumbnail_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_thumbnail_object_key) : Promise.resolve()
    ]);
    await Promise.allSettled(removals);
    return { status: "deleted" };
  });

  app.get("/me/features", { preHandler: requireAuth }, async (request) => {
    const result = await query(
      `SELECT mf.id, mf.category_key, mf.status, mf.created_at, mf.updated_at,
              fr.id AS revision_id, fr.revision_no, fr.status AS revision_status,
              fr.payload, fr.rejection_reason_code, fr.moderation_notes
       FROM map_features mf
       LEFT JOIN LATERAL (
         SELECT * FROM feature_revisions WHERE feature_id = mf.id ORDER BY revision_no DESC LIMIT 1
       ) fr ON true
       WHERE mf.owner_id = $1 AND mf.deleted_at IS NULL
       ORDER BY mf.updated_at DESC`,
      [request.user!.id]
    );
    return result.rows;
  });

  app.get("/features/:id/confirmations", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `SELECT result, count(*)::int AS count, max(created_at) AS latest_at
       FROM feature_confirmations
       WHERE feature_id = $1 AND created_at > now() - interval '180 days'
       GROUP BY result`,
      [params.id]
    );
    return result.rows;
  });

  app.post("/features/:id/confirmations", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      result: z.enum(["still_accurate", "changed", "closed"]),
      note: z.string().trim().max(500).optional()
    }).parse(request.body);

    await transaction(async (client) => {
      const feature = await client.query<{ status: string }>(
        "SELECT status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
        [params.id]
      );
      if (feature.rows[0]?.status !== "published") throw notFound("Published feature not found");
      const inserted = await client.query(
        `INSERT INTO feature_confirmations(feature_id, user_id, result, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (feature_id, user_id) DO UPDATE
           SET result = EXCLUDED.result, note = EXCLUDED.note, created_at = now()
           WHERE feature_confirmations.created_at < now() - interval '90 days'
         RETURNING id`,
        [params.id, request.user!.id, input.result, input.note ?? null]
      );
      if (!inserted.rowCount) throw conflict("ALREADY_CONFIRMED", "This feature was already confirmed within the last 90 days");

      if (input.result !== "still_accurate") {
        const risky = await client.query<{ count: number }>(
          `SELECT count(DISTINCT user_id)::int AS count
           FROM feature_confirmations
           WHERE feature_id = $1 AND result IN ('changed', 'closed')
             AND created_at > now() - interval '7 days'`,
          [params.id]
        );
        if (risky.rows[0]!.count >= 3) {
          await client.query(
            "UPDATE map_features SET needs_review_at = now(), updated_at = now() WHERE id = $1",
            [params.id]
          );
        }
      }
    });
    return { status: "recorded" };
  });
}

async function submitRevision(client: PoolClient, revisionId: string | undefined, featureId: string, userId: string) {
  const feature = await client.query<{ owner_id: string; status: string; current_revision_id: string | null }>(
    "SELECT owner_id, status, current_revision_id FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
    [featureId]
  );
  const featureRow = feature.rows[0];
  if (!featureRow) throw notFound("Feature not found");
  if (featureRow.owner_id !== userId) throw forbidden();

  const revision = revisionId
    ? await client.query<{ id: string; status: string; payload: unknown }>(
        "SELECT id, status, payload FROM feature_revisions WHERE id = $1 AND feature_id = $2 FOR UPDATE",
        [revisionId, featureId]
      )
    : await client.query<{ id: string; status: string; payload: unknown }>(
        "SELECT id, status, payload FROM feature_revisions WHERE feature_id = $1 ORDER BY revision_no DESC LIMIT 1 FOR UPDATE",
        [featureId]
      );
  const revisionRow = revision.rows[0];
  if (!revisionRow) throw notFound("Revision not found");
  if (revisionRow.status === "pending") {
    throw conflict("ALREADY_SUBMITTED", "Revision is already waiting for moderation", { revisionId: revisionRow.id });
  }
  if (!["draft", "rejected", "changes_requested"].includes(revisionRow.status)) {
    throw conflict("REVISION_NOT_SUBMITTABLE", "Revision is not eligible for submission", {
      revisionId: revisionRow.id,
      revisionStatus: revisionRow.status
    });
  }

  const payload = revisionRow.payload as { mediaIds?: string[] };
  await assertMediaUsable(client, userId, payload.mediaIds ?? []);
  await client.query(
    `UPDATE feature_revisions
     SET status = 'pending', submitted_at = now(), reviewed_at = NULL,
         reviewer_id = NULL, rejection_reason_code = NULL, updated_at = now()
     WHERE id = $1`,
    [revisionRow.id]
  );
  if (!featureRow.current_revision_id) {
    await client.query("UPDATE map_features SET status = 'pending', updated_at = now() WHERE id = $1", [featureId]);
  }
}
