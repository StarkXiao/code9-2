-- 协同编辑：字段级自动合并 + 冲突双方各留一份
--
-- 重要：这条迁移是手工编写的。
-- 不要用 prisma migrate dev 直接生成并套用——它会把
-- idx_spots_title_trgm / idx_spots_attributes / idx_spots_geo_public
-- 这三个手工维护的索引判定为多余并 DROP 掉。

-- 内容版本号：协同编辑三方合并的乐观并发令牌
ALTER TABLE "spots" ADD COLUMN "content_version" INT NOT NULL DEFAULT 1;

CREATE TYPE "EditConflictStatus" AS ENUM ('open', 'resolved', 'superseded');

-- 每次内容变更后的字段快照，作为后续合并的 base
CREATE TABLE "spot_edit_snapshots" (
  "id"         BIGSERIAL PRIMARY KEY,
  "spot_id"    BIGINT NOT NULL REFERENCES "spots"("id") ON DELETE CASCADE,
  "version"    INT NOT NULL,
  "editor_id"  BIGINT REFERENCES "users"("id"),
  "snapshot"   JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "spot_edit_snapshots_spot_id_version_key" UNIQUE ("spot_id", "version")
);

-- 合并冲突：冲突字段的当前值与对方提交的值各留一份，等待逐项确认
CREATE TABLE "spot_edit_conflicts" (
  "id"             BIGSERIAL PRIMARY KEY,
  "uuid"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "spot_id"        BIGINT NOT NULL REFERENCES "spots"("id") ON DELETE CASCADE,
  "field"          VARCHAR(64) NOT NULL,
  "base_value"     JSONB,
  "current_value"  JSONB,
  "proposed_value" JSONB,
  "proposed_by"    BIGINT NOT NULL REFERENCES "users"("id"),
  "status"         "EditConflictStatus" NOT NULL DEFAULT 'open',
  "resolution"     VARCHAR(16),
  "resolved_by"    BIGINT REFERENCES "users"("id"),
  "resolved_at"    TIMESTAMPTZ(6),
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "spot_edit_conflicts_uuid_key" ON "spot_edit_conflicts"("uuid");
CREATE INDEX "idx_spot_edit_conflicts_spot" ON "spot_edit_conflicts"("spot_id", "status");

-- 为存量条目回填 v1 快照，让老数据的第一轮并发编辑也能正常三方合并
INSERT INTO "spot_edit_snapshots" ("spot_id", "version", "editor_id", "snapshot", "created_at")
SELECT
  s."id",
  1,
  s."owner_id",
  jsonb_build_object(
    'title', s."title",
    'description', s."description",
    'categoryCode', c."code",
    'attributes', s."attributes",
    'lat', s."exact_lat",
    'lng', s."exact_lng",
    'fuzzEnabled', s."fuzz_enabled",
    'fuzzRadiusM', s."fuzz_radius_m",
    'mediaUuids', COALESCE(
      (SELECT jsonb_agg(m."uuid" ORDER BY m."id") FROM "media_assets" m WHERE m."spot_id" = s."id"),
      '[]'::jsonb
    )
  ),
  now()
FROM "spots" s
JOIN "categories" c ON c."id" = s."category_id";
