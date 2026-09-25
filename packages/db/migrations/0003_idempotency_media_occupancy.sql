-- 幂等键：客户端重试同一逻辑请求时返回同一结果，避免重复创建草稿。
CREATE TABLE idempotency_keys (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_method text NOT NULL,
  request_path text NOT NULL,
  request_fingerprint text NOT NULL,
  response_status integer,
  response_body jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX idempotency_keys_purge_idx
  ON idempotency_keys(completed_at)
  WHERE completed_at IS NOT NULL;

-- 媒体占用：一个媒体对象同一时刻只能被一条非删除投稿占用。
-- revision_media 保留完整历史；该表只记录当前占用，跨投稿复用返回冲突。
CREATE TABLE feature_media_bindings (
  media_id uuid PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  bound_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feature_media_bindings_feature_idx ON feature_media_bindings(feature_id);

-- 回填现有占用（历史数据中一个媒体被多条投稿引用时，取最近更新的那条）。
INSERT INTO feature_media_bindings (media_id, feature_id, bound_at)
SELECT media_id, feature_id, updated_at
FROM (
  SELECT rm.media_id,
         fr.feature_id,
         fr.updated_at,
         ROW_NUMBER() OVER (PARTITION BY rm.media_id ORDER BY fr.updated_at DESC, fr.feature_id) AS rn
  FROM revision_media rm
  JOIN feature_revisions fr ON fr.id = rm.revision_id
  JOIN map_features mf ON mf.id = fr.feature_id AND mf.deleted_at IS NULL
) ranked
WHERE rn = 1
ON CONFLICT (media_id) DO NOTHING;
