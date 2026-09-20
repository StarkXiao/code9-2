import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 多人同时编辑同一条目：按字段自动合并 + 冲突逐项确认。
// 跑在真实数据库与 Redis 上（docker compose up -d postgres redis）。
let app: Express;
let ownerToken = "";
let moderatorToken = "";
let ownerUuid = "";
let moderatorUuid = "";

const suffix = Date.now().toString(36);
const ownerEmail = `merge-owner-${suffix}@example.com`;
const moderatorEmail = `merge-mod-${suffix}@example.com`;
const password = "Str0ngPass1";

/** updatedAt 是毫秒精度，连续两次写入之间留一点间隔，保证版本标记必然变化 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function login(account: string): Promise<{ token: string; uuid: string }> {
  const response = await request(app).post("/api/v1/auth/login").send({ account, password }).expect(200);
  const me = await request(app)
    .get("/api/v1/auth/me")
    .set("Authorization", `Bearer ${response.body.data.accessToken}`)
    .expect(200);
  return { token: response.body.data.accessToken, uuid: me.body.data.user.uuid };
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: ownerEmail, password, nickname: `合并作者${suffix.slice(-4)}` })
    .expect(201);
  await request(app)
    .post("/api/v1/auth/register")
    .send({ email: moderatorEmail, password, nickname: `合并审核${suffix.slice(-4)}` })
    .expect(201);
  await prisma.user.update({ where: { email: moderatorEmail }, data: { role: "moderator" } });

  const owner = await login(ownerEmail);
  const moderator = await login(moderatorEmail);
  ownerToken = owner.token;
  ownerUuid = owner.uuid;
  moderatorToken = moderator.token;
  moderatorUuid = moderator.uuid;
}, 60000);

afterAll(async () => {
  const records = await prisma.user.findMany({
    where: { uuid: { in: [ownerUuid, moderatorUuid].filter(Boolean) } },
    select: { id: true },
  });
  const ids = records.map((record) => record.id);
  if (ids.length > 0) {
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
}, 60000);

describe("并发编辑的字段级合并与冲突确认", () => {
  let spotUuid = "";
  // 贡献者打开编辑页时的基线（版本标记 + 表单快照）
  let baseUpdatedAt = "";
  let base: Record<string, unknown> = {};

  it("贡献者创建草稿并记录编辑基线", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        categoryCode: "bench",
        title: "合并测试长椅",
        description: "原始描述",
        attributes: { has_backrest: true, condition: "good", count: 2 },
        lat: 30.25,
        lng: 120.16,
        fuzzEnabled: true,
        fuzzRadiusM: 50,
        mediaUuids: [],
      })
      .expect(201);

    spotUuid = created.body.data.uuid;

    const detail = await request(app)
      .get(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);

    baseUpdatedAt = detail.body.data.updatedAt;
    base = {
      categoryCode: "bench",
      title: "合并测试长椅",
      description: "原始描述",
      attributes: { has_backrest: true, condition: "good", count: 2 },
      lat: 30.25,
      lng: 120.16,
      fuzzEnabled: true,
      fuzzRadiusM: 50,
      mediaUuids: [],
    };
  });

  it("双方改不同字段 → 自动合并，不打扰编辑者", async () => {
    await tick();
    // 审核员同时编辑：改了标题与可坐人数（不带基线，直接保存）
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({ title: "审核员改过的标题", attributes: { has_backrest: true, condition: "good", count: 4 } })
      .expect(200);

    // 贡献者保存：只改了描述，其他字段还是打开页面时的旧值
    const response = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...base, description: "贡献者补充的描述", base, baseUpdatedAt })
      .expect(200);

    expect(response.body.data.merge.autoMergedFields).toContain("title");
    expect(response.body.data.merge.autoMergedFields).toContain("attributes.count");

    const detail = await request(app)
      .get(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    // 对方的改动保留，我方的改动也生效
    expect(detail.body.data.title).toBe("审核员改过的标题");
    expect(detail.body.data.description).toBe("贡献者补充的描述");
    expect(detail.body.data.attributes.count).toBe(4);

    // 贡献者的前端此时会刷新基线
    baseUpdatedAt = detail.body.data.updatedAt;
    base = {
      ...base,
      title: "审核员改过的标题",
      description: "贡献者补充的描述",
      attributes: { has_backrest: true, condition: "good", count: 4 },
    };
  });

  it("双方改同一字段 → 409，冲突字段保留两份", async () => {
    await tick();
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({ title: "审核员再改的标题" })
      .expect(200);

    const response = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...base, title: "贡献者改的标题", base, baseUpdatedAt })
      .expect(409);

    expect(response.body.error.code).toBe("EDIT_CONFLICT");
    const details = response.body.error.details;
    expect(details.conflicts).toHaveLength(1);
    expect(details.conflicts[0].field).toBe("title");
    expect(details.conflicts[0].base).toBe("审核员改过的标题");
    expect(details.conflicts[0].theirs).toBe("审核员再改的标题");
    expect(details.conflicts[0].yours).toBe("贡献者改的标题");
    // 非冲突字段已自动合并好，随 details 一并返回
    expect(details.merged.description).toBe("贡献者补充的描述");
    expect(details.currentUpdatedAt).toBeTruthy();

    // 冲突期间内容没有被任何一方的提交覆盖
    const detail = await request(app)
      .get(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(detail.body.data.title).toBe("审核员再改的标题");
  });

  it("编辑者逐项确认取舍后重提 → 按选择生效", async () => {
    // 编辑者在页面上选择了"我的改动"，带 resolveConflicts 重新提交
    const response = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...base, title: "贡献者改的标题", base, baseUpdatedAt, resolveConflicts: true })
      .expect(200);

    expect(response.body.data.title).toBe("贡献者改的标题");

    const detail = await request(app)
      .get(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(detail.body.data.title).toBe("贡献者改的标题");
    // 自动合并的字段仍然是合并后的值
    expect(detail.body.data.attributes.count).toBe(4);
  });

  it("解决冲突时选择对方的版本 → 对方的值生效", async () => {
    baseUpdatedAt = (
      await request(app).get(`/api/v1/spots/${spotUuid}`).set("Authorization", `Bearer ${ownerToken}`).expect(200)
    ).body.data.updatedAt;
    base = { ...base, title: "贡献者改的标题" };

    await tick();
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${moderatorToken}`)
      .send({ description: "审核员重写的描述" })
      .expect(200);

    // 第一次保存撞冲突
    const conflict = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...base, description: "贡献者改的描述", base, baseUpdatedAt })
      .expect(409);
    expect(conflict.body.error.details.conflicts[0].field).toBe("description");

    // 编辑者选择"对方的改动"：提交值改为对方的描述
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ ...base, description: "审核员重写的描述", base, baseUpdatedAt, resolveConflicts: true })
      .expect(200);

    const detail = await request(app)
      .get(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(detail.body.data.description).toBe("审核员重写的描述");
  });

  it("不带基线的调用保持原有直接保存行为（兼容旧客户端）", async () => {
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: "直接保存的标题" })
      .expect(200);

    const detail = await request(app)
      .get(`/api/v1/spots/${spotUuid}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200);
    expect(detail.body.data.title).toBe("直接保存的标题");
  });
});
