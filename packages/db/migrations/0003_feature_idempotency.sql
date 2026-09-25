ALTER TABLE map_features
  ADD COLUMN idempotency_key text;

-- 每个作者的活跃投稿中幂等键唯一；软删除后键释放，允许重新创建。
CREATE UNIQUE INDEX map_features_idempotency_idx
  ON map_features(owner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;
