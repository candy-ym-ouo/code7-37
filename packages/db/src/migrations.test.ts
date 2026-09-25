import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../migrations/0001_init.sql"),
  "utf8"
);

describe("initial migration", () => {
  it("contains the core audited entities", () => {
    for (const table of [
      "users", "sessions", "auth_tokens", "categories", "map_features",
      "feature_revisions", "media_assets", "comments", "reports",
      "moderation_actions", "outbox_events", "audit_logs", "notifications"
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("adds public thumbnail and outbox recovery fields in migration 0002", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0002_media_public_thumb.sql"),
      "utf8"
    );
    expect(followup).toContain("public_thumbnail_object_key");
    expect(followup).toContain("updated_at timestamptz");
  });

  it("adds idempotency keys and media occupancy tables in migration 0003", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_idempotency_media_occupancy.sql"),
      "utf8"
    );
    expect(followup).toContain("CREATE TABLE idempotency_keys");
    expect(followup).toContain("UNIQUE (user_id, idempotency_key)");
    expect(followup).toContain("request_fingerprint");
    expect(followup).toContain("response_status");
    expect(followup).toContain("CREATE TABLE feature_media_bindings");
    // 一个媒体只能被一条投稿占用：主键即 media_id。
    expect(followup).toMatch(/media_id uuid PRIMARY KEY/);
    // 历史 revision_media 引用需要回填占用。
    expect(followup).toContain("INSERT INTO feature_media_bindings");
  });

  it("uses PostGIS geography points and spatial indexes", () => {
    expect(migration).toContain("geography(Point, 4326)");
    expect(migration).toContain("USING gist (geom)");
  });
});
