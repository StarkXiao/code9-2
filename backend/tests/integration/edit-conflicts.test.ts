import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { initStorage } from "../../src/services/storage";

// 协同编辑闭环：两人同时编辑同一条目 → 字段级自动合并 →
// 冲突字段双方各留一份 → 页面上逐项确认取舍。
// 跑在真实数据库与 Redis 上（docker compose up -d postgres redis）。
let app: Express;
let ownerToken = "";
let moderatorToken = "";
let outsiderToken = "";
let ownerUuid = "";
let moderatorUuid = "";
let outsiderUuid = "";

const suffix = Date.now().toString(36);
const password = "Str0ngPass1";
const ownerEmail = `merge-owner-${suffix}@example.com`;
const moderatorEmail = `merge-mod-${suffix}@example.com`;
const outsiderEmail = `merge-outsider-${suffix}@example.com`;

async function login(account: string): Promise<{ token: string; uuid: string }> {
  const response = await request(app).post("/api/v1/auth/login").send({ account, password }).expect(200);
  const me = await request(app)
    .get("/api/v1/auth/me")
    .set("Authorization", `Bearer ${response.body.data.accessToken}`)
    .expect(200);
  return { token: response.body.data.accessToken, uuid: me.body.data.user.uuid };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** 编辑页的全量保存载荷，与前端 saveDraft 发出的结构一致 */
function fullPayload(spot: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const location = spot.location as { lat: number; lng: number; radiusMeters: number };
  return {
    categoryCode: (spot.category as { code: string }).code,
    title: spot.title,
    description: spot.description ?? "",
    attributes: spot.attributes,
    lat: location.lat,
    lng: location.lng,
    fuzzEnabled: location.radiusMeters > 0,
    fuzzRadiusM: location.radiusMeters,
    mediaUuids: (spot.media as Array<{ uuid: string }>).map((asset) => asset.uuid),
    ...overrides,
  };
}

async function getSpot(uuid: string, token: string) {
  const response = await request(app).get(`/api/v1/spots/${uuid}`).set(auth(token)).expect(200);
  return response.body.data as Record<string, unknown> & { contentVersion: number };
}

beforeAll(async () => {
  await initStorage();
  app = createApp();

  for (const [email, nickname] of [
    [ownerEmail, `合并作者${suffix.slice(-4)}`],
    [moderatorEmail, `合并审核${suffix.slice(-4)}`],
    [outsiderEmail, `路人${suffix.slice(-4)}`],
  ] as const) {
    await request(app).post("/api/v1/auth/register").send({ email, password, nickname }).expect(201);
  }
  await prisma.user.update({ where: { email: moderatorEmail }, data: { role: "moderator" } });

  ({ token: ownerToken, uuid: ownerUuid } = await login(ownerEmail));
  ({ token: moderatorToken, uuid: moderatorUuid } = await login(moderatorEmail));
  ({ token: outsiderToken, uuid: outsiderUuid } = await login(outsiderEmail));
}, 60000);

afterAll(async () => {
  const uuids = [ownerUuid, moderatorUuid, outsiderUuid].filter(Boolean);
  const users = await prisma.user.findMany({ where: { uuid: { in: uuids } }, select: { id: true } });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.spotEditConflict.deleteMany({ where: { spot: { ownerId: { in: ids } } } });
    await prisma.spot.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
}, 60000);

describe("协同编辑：字段级自动合并与冲突确认", () => {
  let spotUuid = "";

  it("作者创建草稿后带有内容版本号与 v1 快照", async () => {
    const created = await request(app)
      .post("/api/v1/spots")
      .set(auth(ownerToken))
      .send({
        categoryCode: "bench",
        title: `合并测试长椅${suffix.slice(-4)}`,
        description: "初始描述",
        attributes: { has_backrest: true, condition: "good", count: 2 },
        lat: 30.2468,
        lng: 120.1357,
        fuzzEnabled: true,
        fuzzRadiusM: 50,
        mediaUuids: [],
      })
      .expect(201);

    spotUuid = created.body.data.uuid;
    expect(created.body.data.contentVersion).toBe(1);

    const snapshot = await prisma.spotEditSnapshot.findFirst({ where: { version: 1, spot: { uuid: spotUuid } } });
    expect(snapshot).not.toBeNull();
  });

  it("双方各改不同字段时自动合并，两份修改都保留", async () => {
    // 两人同时基于 v1 打开编辑页
    const ownerView = await getSpot(spotUuid, ownerToken);
    const moderatorView = await getSpot(spotUuid, moderatorToken);
    expect(moderatorView.contentVersion).toBe(1);

    // 审核员先保存：只改标题
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(moderatorToken))
      .send(fullPayload(moderatorView, { title: "审核员改的标题", baseVersion: 1 }))
      .expect(200);

    // 作者基于过期的 v1 保存：只改描述 → 应自动合并而不是互相覆盖
    const merged = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(ownerToken))
      .send(fullPayload(ownerView, { description: "作者改的描述", baseVersion: 1 }))
      .expect(200);

    expect(merged.body.data.merge?.merged).toBe(true);
    expect(merged.body.data.title).toBe("审核员改的标题");
    expect(merged.body.data.description).toBe("作者改的描述");
    expect(merged.body.data.contentVersion).toBe(3);
  });

  it("同一字段双方改成不同值 → 409，冲突双方各留一份，其余字段照常合并", async () => {
    const ownerView = await getSpot(spotUuid, ownerToken);
    const moderatorView = await getSpot(spotUuid, moderatorToken);
    expect(ownerView.contentVersion).toBe(3);

    // 作者先保存：改标题
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(ownerToken))
      .send(fullPayload(ownerView, { title: "作者的标题", baseVersion: 3 }))
      .expect(200);

    // 审核员基于 v3 保存：改标题（冲突）+ 改属性 count（可自动合并）
    const conflicted = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(moderatorToken))
      .send(
        fullPayload(moderatorView, {
          title: "审核员的标题",
          attributes: { has_backrest: true, condition: "good", count: 6 },
          baseVersion: 3,
        }),
      )
      .expect(409);

    expect(conflicted.body.error.code).toBe("EDIT_CONFLICT");
    const conflicts = conflicted.body.error.details.conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe("title");
    expect(conflicts[0].current).toBe("作者的标题");
    expect(conflicts[0].proposed).toBe("审核员的标题");

    // 无冲突的字段已经合并落库，冲突字段保持当前值
    const spot = await getSpot(spotUuid, ownerToken);
    expect(spot.title).toBe("作者的标题");
    expect((spot.attributes as Record<string, unknown>).count).toBe(6);
    expect(spot.contentVersion).toBe(5);
  });

  it("无关用户不能查看冲突列表", async () => {
    await request(app).get(`/api/v1/spots/${spotUuid}/edit-conflicts`).set(auth(outsiderToken)).expect(403);
  });

  it("编辑者可以在页面上拉到待确认的冲突并逐项取舍", async () => {
    const list = await request(app)
      .get(`/api/v1/spots/${spotUuid}/edit-conflicts`)
      .set(auth(moderatorToken))
      .expect(200);

    expect(list.body.data.items).toHaveLength(1);
    const conflict = list.body.data.items[0];
    expect(conflict.field).toBe("title");
    expect(conflict.proposer.nickname).toContain("合并审核");

    // 采用审核员的修改 → 标题落库，冲突关闭
    await request(app)
      .post(`/api/v1/spots/${spotUuid}/edit-conflicts/${conflict.uuid}/resolve`)
      .set(auth(moderatorToken))
      .send({ choice: "proposed" })
      .expect(200);

    const spot = await getSpot(spotUuid, ownerToken);
    expect(spot.title).toBe("审核员的标题");

    const after = await request(app)
      .get(`/api/v1/spots/${spotUuid}/edit-conflicts`)
      .set(auth(ownerToken))
      .expect(200);
    expect(after.body.data.items).toHaveLength(0);
  });

  it("选择保留当前值时不改动内容，只关闭冲突", async () => {
    const view = await getSpot(spotUuid, ownerToken);
    const version = view.contentVersion;

    // 再造一次冲突：作者先改，审核员基于旧版本改同一字段
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(ownerToken))
      .send(fullPayload(view, { description: "作者的新描述", baseVersion: version }))
      .expect(200);

    const conflicted = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(moderatorToken))
      .send(fullPayload(view, { description: "审核员的新描述", baseVersion: version }))
      .expect(409);

    const conflictUuid = conflicted.body.error.details.conflicts[0].uuid;

    await request(app)
      .post(`/api/v1/spots/${spotUuid}/edit-conflicts/${conflictUuid}/resolve`)
      .set(auth(ownerToken))
      .send({ choice: "current" })
      .expect(200);

    const spot = await getSpot(spotUuid, ownerToken);
    expect(spot.description).toBe("作者的新描述");
  });

  it("冲突登记后字段又有新改动时，旧冲突作废并提示刷新", async () => {
    const view = await getSpot(spotUuid, ownerToken);
    const version = view.contentVersion;

    // 作者先改标题，审核员基于旧版本改同一标题 → 冲突
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(ownerToken))
      .send(fullPayload(view, { title: "第一版标题", baseVersion: version }))
      .expect(200);

    const conflicted = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(moderatorToken))
      .send(fullPayload(view, { title: "审核员要改的标题", baseVersion: version }))
      .expect(409);
    const conflictUuid = conflicted.body.error.details.conflicts[0].uuid;

    // 作者又把标题改了一次（基于最新版本，无冲突直接生效）
    const fresh = await getSpot(spotUuid, ownerToken);
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(ownerToken))
      .send(fullPayload(fresh, { title: "第二版标题", baseVersion: fresh.contentVersion }))
      .expect(200);

    // 此时再处理旧冲突：双方版本都已过时，应作废而不是覆盖新修改
    await request(app)
      .post(`/api/v1/spots/${spotUuid}/edit-conflicts/${conflictUuid}/resolve`)
      .set(auth(moderatorToken))
      .send({ choice: "proposed" })
      .expect(409)
      .expect((response) => {
        expect(response.body.error.code).toBe("EDIT_CONFLICT_STALE");
      });

    const spot = await getSpot(spotUuid, ownerToken);
    expect(spot.title).toBe("第二版标题");

    const open = await request(app)
      .get(`/api/v1/spots/${spotUuid}/edit-conflicts`)
      .set(auth(moderatorToken))
      .expect(200);
    expect(open.body.data.items).toHaveLength(0);
  });

  it("同一编辑者重复保存产生冲突时，旧冲突被新冲突取代", async () => {
    const view = await getSpot(spotUuid, ownerToken);
    const version = view.contentVersion;

    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(ownerToken))
      .send(fullPayload(view, { title: "作者的版本A", baseVersion: version }))
      .expect(200);

    // 审核员两次基于同一旧版本保存同一字段 → 只留一条 open 冲突
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(moderatorToken))
      .send(fullPayload(view, { title: "审核员的版本一", baseVersion: version }))
      .expect(409);
    await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(moderatorToken))
      .send(fullPayload(view, { title: "审核员的版本二", baseVersion: version }))
      .expect(409);

    const open = await request(app)
      .get(`/api/v1/spots/${spotUuid}/edit-conflicts`)
      .set(auth(moderatorToken))
      .expect(200);
    expect(open.body.data.items).toHaveLength(1);
    expect(open.body.data.items[0].proposed).toBe("审核员的版本二");

    // 收尾：采用当前值关闭冲突，避免影响后续用例
    await request(app)
      .post(`/api/v1/spots/${spotUuid}/edit-conflicts/${open.body.data.items[0].uuid}/resolve`)
      .set(auth(ownerToken))
      .send({ choice: "current" })
      .expect(200);
  });

  it("不带 baseVersion 的旧式保存仍然可用，并维护版本号", async () => {
    const before = await getSpot(spotUuid, ownerToken);

    const response = await request(app)
      .patch(`/api/v1/spots/${spotUuid}`)
      .set(auth(ownerToken))
      .send({ title: "旧式保存的标题" })
      .expect(200);

    expect(response.body.data.title).toBe("旧式保存的标题");
    expect(response.body.data.contentVersion).toBe(before.contentVersion + 1);
  });
});
