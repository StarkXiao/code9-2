import bcrypt from "bcryptjs";
import { env } from "../src/config/env";
import { prisma, toJsonValue } from "../src/db/prisma";
import { randomPassword } from "../src/utils/crypto";
import { fuzzCoordinates } from "../src/services/geo";

interface CategorySeed {
  code: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  sortOrder: number;
  schema: Record<string, unknown>;
}

const CATEGORIES: CategorySeed[] = [
  {
    code: "bench",
    name: "长椅",
    icon: "bench",
    color: "#8B5E3C",
    description: "可以坐下来休息的地方，含靠背、遮荫、轮椅停靠等细节",
    sortOrder: 1,
    schema: {
      type: "object",
      required: ["has_backrest", "condition"],
      properties: {
        has_backrest: {
          type: "boolean",
          label: "是否有靠背",
          help: "有靠背更适合长时间休息",
          ui: "switch",
        },
        count: { type: "integer", label: "可坐人数", minimum: 1, maximum: 50, unit: "人" },
        condition: {
          type: "string",
          label: "完好程度",
          ui: "select",
          enum: ["good", "fair", "poor"],
          enumLabels: { good: "完好", fair: "一般", poor: "破损" },
        },
        shade: {
          type: "string",
          label: "遮荫情况",
          ui: "select",
          enum: ["none", "partial", "full"],
          enumLabels: { none: "无遮荫", partial: "部分遮荫", full: "完全遮荫" },
        },
        wheelchair_space: { type: "boolean", label: "轮椅可停靠", ui: "switch" },
        material: {
          type: "string",
          label: "材质",
          ui: "select",
          enum: ["wood", "metal", "stone", "plastic", "mixed"],
          enumLabels: {
            wood: "木质",
            metal: "金属",
            stone: "石材",
            plastic: "塑料",
            mixed: "混合",
          },
        },
      },
    },
  },
  {
    code: "drinking_water",
    name: "饮水处",
    icon: "water",
    color: "#2E86DE",
    description: "能接到水的地方，含是否免费、龙头高度、冬季是否关闭",
    sortOrder: 2,
    schema: {
      type: "object",
      required: ["type", "free"],
      properties: {
        type: {
          type: "string",
          label: "供水类型",
          ui: "select",
          enum: ["direct", "fountain", "station", "shop"],
          enumLabels: {
            direct: "直饮水龙头",
            fountain: "喷泉式饮水台",
            station: "供水站",
            shop: "附近商店代售",
          },
        },
        free: { type: "boolean", label: "是否免费", ui: "switch" },
        height: {
          type: "string",
          label: "龙头高度",
          ui: "select",
          enum: ["low", "standard", "high", "multi"],
          enumLabels: { low: "低（儿童/轮椅可用）", standard: "常规", high: "偏高", multi: "多种高度" },
        },
        temperature: {
          type: "string",
          label: "水温",
          ui: "select",
          enum: ["cold", "room", "warm"],
          enumLabels: { cold: "凉水", room: "常温", warm: "温水" },
        },
        open_hours: { type: "string", label: "开放时段", maxLength: 40, ui: "text" },
        closed_in_winter: { type: "boolean", label: "冬季会关闭", ui: "switch" },
      },
    },
  },
  {
    code: "rain_shelter",
    name: "遮雨棚",
    icon: "shelter",
    color: "#16A085",
    description: "下雨时能躲一躲的地方，含可站人数、是否有座位",
    sortOrder: 3,
    schema: {
      type: "object",
      required: ["capacity"],
      properties: {
        capacity: { type: "integer", label: "可容纳人数", minimum: 1, maximum: 200, unit: "人" },
        has_seats: { type: "boolean", label: "有座位", ui: "switch" },
        coverage: {
          type: "string",
          label: "覆盖范围",
          ui: "select",
          enum: ["small", "medium", "large"],
          enumLabels: { small: "仅够几人", medium: "可站十几人", large: "可容纳很多人" },
        },
        enclosed: { type: "boolean", label: "是否封闭", ui: "switch" },
        lighting: { type: "boolean", label: "夜间有照明", ui: "switch" },
      },
    },
  },
  {
    code: "quiet_corner",
    name: "安静角落",
    icon: "quiet",
    color: "#8E44AD",
    description: "相对不吵、适合读书或打电话的地方，含安静时段规律",
    sortOrder: 4,
    schema: {
      type: "object",
      required: ["noise_level"],
      properties: {
        noise_level: {
          type: "string",
          label: "安静程度",
          ui: "select",
          enum: ["very_quiet", "quiet", "moderate"],
          enumLabels: { very_quiet: "非常安静", quiet: "比较安静", moderate: "一般" },
        },
        best_time: {
          type: "string",
          label: "最安静的时段",
          ui: "select",
          enum: ["morning", "noon", "afternoon", "evening", "night", "all_day"],
          enumLabels: {
            morning: "清晨",
            noon: "中午",
            afternoon: "下午",
            evening: "傍晚",
            night: "夜间",
            all_day: "全天都安静",
          },
        },
        has_seats: { type: "boolean", label: "有座位", ui: "switch" },
        crowd_level: {
          type: "string",
          label: "人流密度",
          ui: "select",
          enum: ["empty", "sparse", "moderate", "crowded"],
          enumLabels: { empty: "基本没人", sparse: "偶尔有人", moderate: "人不多不少", crowded: "人比较多" },
        },
        good_for: {
          type: "array",
          label: "适合做什么",
          ui: "checkbox",
          items: {
            type: "string",
            enum: ["reading", "rest", "phone_call", "work"],
            enumLabels: {
              reading: "读书",
              rest: "发呆休息",
              phone_call: "打电话",
              work: "办公",
            },
          },
        },
      },
    },
  },
  {
    code: "night_light",
    name: "夜间照明",
    icon: "light",
    color: "#E1A100",
    description: "天黑以后这里亮不亮、走起来安不安全",
    sortOrder: 5,
    schema: {
      type: "object",
      required: ["brightness"],
      properties: {
        brightness: {
          type: "string",
          label: "亮度",
          ui: "select",
          enum: ["dim", "moderate", "bright"],
          enumLabels: { dim: "偏暗", moderate: "够用", bright: "很亮" },
        },
        coverage: {
          type: "string",
          label: "覆盖范围",
          ui: "select",
          enum: ["patchy", "partial", "comprehensive"],
          enumLabels: { patchy: "断断续续", partial: "大部分有", comprehensive: "全程覆盖" },
        },
        light_type: {
          type: "string",
          label: "灯具类型",
          ui: "select",
          enum: ["led", "halogen", "solar", "unknown"],
          enumLabels: { led: "LED", halogen: "传统灯", solar: "太阳能灯", unknown: "说不清" },
        },
        all_night: { type: "boolean", label: "整夜亮着", ui: "switch" },
        safety_rating: { type: "integer", label: "夜间安全感", minimum: 1, maximum: 5, ui: "rating" },
        has_camera: { type: "boolean", label: "附近有监控", ui: "switch" },
      },
    },
  },
];

interface SpotSeed {
  categoryCode: string;
  title: string;
  description: string;
  attributes: Record<string, unknown>;
  lat: number;
  lng: number;
  addressText: string;
  status: "published" | "pending";
  fuzzRadiusM: number;
}

// 开发用演示数据：覆盖五个分类，坐标在上海几个公开的公共空间附近
const SPOTS: SpotSeed[] = [
  {
    categoryCode: "bench",
    title: "梧桐树下带靠背的长椅",
    description: "傍晚有树荫，旁边就是步道，坐着很舒服。周末上午人会多一点。",
    attributes: { has_backrest: true, count: 3, condition: "good", shade: "full", wheelchair_space: true, material: "mixed" },
    lat: 31.2318,
    lng: 121.4732,
    addressText: "上海市黄浦区人民大道附近",
    status: "published",
    fuzzRadiusM: 50,
  },
  {
    categoryCode: "drinking_water",
    title: "公园入口的直饮水龙头",
    description: "两个龙头，一个高一个低，低的那个推轮椅也能够到。冬天会关掉。",
    attributes: { type: "direct", free: true, height: "multi", temperature: "cold", open_hours: "6:00–21:00", closed_in_winter: true },
    lat: 31.2285,
    lng: 121.4698,
    addressText: "上海市黄浦区武胜路附近",
    status: "published",
    fuzzRadiusM: 30,
  },
  {
    categoryCode: "rain_shelter",
    title: "地铁口旁的遮雨棚",
    description: "下雨天等车能躲一下，能站十几个人，靠墙有一排窄座位。",
    attributes: { capacity: 15, has_seats: true, coverage: "medium", enclosed: false, lighting: true },
    lat: 31.2362,
    lng: 121.4805,
    addressText: "上海市黄浦区南京东路附近",
    status: "published",
    fuzzRadiusM: 50,
  },
  {
    categoryCode: "quiet_corner",
    title: "图书馆外侧的台阶角落",
    description: "工作日下午几乎没人，打过好几次电话都没被吵到。晚上七点后会有人来拍照。",
    attributes: {
      noise_level: "very_quiet",
      best_time: "afternoon",
      has_seats: false,
      crowd_level: "empty",
      good_for: ["phone_call", "reading"],
    },
    lat: 31.2241,
    lng: 121.4756,
    addressText: "上海市黄浦区淮海中路附近",
    status: "published",
    fuzzRadiusM: 50,
  },
  {
    categoryCode: "night_light",
    title: "沿河步道的夜间照明",
    description: "灯是 LED 的，整夜都亮。中间有一小段大约三十米比较暗，晚上走靠外侧更好。",
    attributes: { brightness: "moderate", coverage: "partial", light_type: "led", all_night: true, safety_rating: 4, has_camera: true },
    lat: 31.2401,
    lng: 121.4905,
    addressText: "上海市虹口区北苏州路附近",
    status: "published",
    fuzzRadiusM: 100,
  },
  {
    categoryCode: "bench",
    title: "小区门口的石凳（待审核示例）",
    description: "这条用于演示审核流程，登录审核员账号后可以在审核台看到它。",
    attributes: { has_backrest: false, count: 2, condition: "fair", shade: "partial" },
    lat: 31.2198,
    lng: 121.4651,
    addressText: "上海市黄浦区制造局路附近",
    status: "pending",
    fuzzRadiusM: 50,
  },
];

async function main(): Promise<void> {
  console.log("开始写入种子数据…\n");

  const categoryIdByCode = new Map<string, bigint>();

  for (const category of CATEGORIES) {
    const record = await prisma.category.upsert({
      where: { code: category.code },
      create: {
        code: category.code,
        name: category.name,
        icon: category.icon,
        color: category.color,
        description: category.description,
        sortOrder: category.sortOrder,
        isActive: true,
      },
      update: {
        name: category.name,
        icon: category.icon,
        color: category.color,
        description: category.description,
        sortOrder: category.sortOrder,
      },
    });

    categoryIdByCode.set(category.code, record.id);

    const existingSchema = await prisma.categorySchema.findFirst({
      where: { categoryId: record.id, isCurrent: true },
    });

    if (existingSchema) {
      await prisma.categorySchema.update({
        where: { id: existingSchema.id },
        data: { schema: toJsonValue(category.schema) },
      });
    } else {
      await prisma.categorySchema.create({
        data: {
          categoryId: record.id,
          version: 1,
          schema: toJsonValue(category.schema),
          isCurrent: true,
        },
      });
    }
  }

  console.log(`已写入 ${CATEGORIES.length} 个分类及其属性 Schema`);

  // 种子密码每次随机生成并打印，绝不写死在仓库里
  const accounts = [
    { email: "admin@example.com", nickname: "管理员", role: "admin" as const },
    { email: "moderator@example.com", nickname: "审核员小周", role: "moderator" as const },
    { email: "user@example.com", nickname: "阿吉", role: "user" as const },
  ];

  const credentials: Array<{ role: string; email: string; password: string }> = [];
  const userIdByEmail = new Map<string, bigint>();

  for (const account of accounts) {
    const password = randomPassword(16);
    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

    const user = await prisma.user.upsert({
      where: { email: account.email },
      create: {
        email: account.email,
        nickname: account.nickname,
        passwordHash,
        role: account.role,
        status: "active",
        creditScore: 100,
        settings: { create: {} },
      },
      update: {
        nickname: account.nickname,
        role: account.role,
        passwordHash,
        status: "active",
      },
    });

    userIdByEmail.set(account.email, user.id);
    credentials.push({ role: account.role, email: account.email, password });
  }

  const ownerId = userIdByEmail.get("user@example.com")!;
  const moderatorId = userIdByEmail.get("moderator@example.com")!;
  let created = 0;

  for (const spot of SPOTS) {
    const categoryId = categoryIdByCode.get(spot.categoryCode);
    if (!categoryId) continue;

    const uuid = await prisma.spot
      .findFirst({ where: { title: spot.title }, select: { uuid: true } })
      .then((existing) => existing?.uuid);

    if (uuid) continue;

    const publicPoint = fuzzCoordinates(
      { lat: spot.lat, lng: spot.lng },
      spot.fuzzRadiusM,
      `${spot.title}-seed`,
    );

    const record = await prisma.spot.create({
      data: {
        ownerId,
        categoryId,
        status: spot.status,
        title: spot.title,
        description: spot.description,
        attributes: toJsonValue(spot.attributes),
        exactLat: spot.lat,
        exactLng: spot.lng,
        publicLat: spot.status === "published" ? publicPoint.lat : null,
        publicLng: spot.status === "published" ? publicPoint.lng : null,
        fuzzEnabled: true,
        fuzzRadiusM: spot.fuzzRadiusM,
        addressText: spot.addressText,
        freshnessScore: spot.status === "published" ? 60 : 0,
        confirmCount: spot.status === "published" ? 1 : 0,
        publishedAt: spot.status === "published" ? new Date() : null,
      },
    });

    const revision = await prisma.spotRevision.create({
      data: {
        spotId: record.id,
        revisionNo: 1,
        editorId: ownerId,
        schemaVersion: 1,
        snapshot: toJsonValue({
          title: spot.title,
          description: spot.description,
          attributes: spot.attributes,
          categoryCode: spot.categoryCode,
          categorySchemaVersion: 1,
          lat: spot.lat,
          lng: spot.lng,
          fuzzEnabled: true,
          fuzzRadiusM: spot.fuzzRadiusM,
          addressText: spot.addressText,
          media: [],
        }),
      },
    });

    await prisma.spot.update({
      where: { id: record.id },
      data: { currentRevisionId: revision.id },
    });

    // 协同编辑的 v1 快照：种子数据也要能作为三方合并的基准
    await prisma.spotEditSnapshot.create({
      data: {
        spotId: record.id,
        version: 1,
        editorId: ownerId,
        snapshot: toJsonValue({
          title: spot.title,
          description: spot.description,
          categoryCode: spot.categoryCode,
          attributes: spot.attributes,
          lat: spot.lat,
          lng: spot.lng,
          fuzzEnabled: true,
          fuzzRadiusM: spot.fuzzRadiusM,
          mediaUuids: [],
        }),
      },
    });

    // 待审核的示例条目同时建一条审核工单，让审核台开箱就有内容
    if (spot.status === "pending") {
      await prisma.reviewTask.create({
        data: {
          spotId: record.id,
          revisionId: revision.id,
          status: "pending",
          priority: 0,
          slaDueAt: new Date(Date.now() + env.REVIEW_SLA_HOURS * 3600000),
          autoCheck: toJsonValue({ passed: true, issues: [], meta: { seeded: true } }),
        },
      });
    } else {
      await prisma.reviewTask.create({
        data: {
          spotId: record.id,
          revisionId: revision.id,
          status: "approved",
          decidedBy: moderatorId,
          decidedAt: new Date(),
          decisionReason: "种子数据，直接发布",
          slaDueAt: new Date(),
        },
      });
    }

    created += 1;
  }

  console.log(`已写入 ${created} 条演示条目（其余为已存在，跳过）`);

  const total = await prisma.spot.count();

  console.log("\n================ 种子账号（密码仅本次输出，请立即保存） ================");
  for (const item of credentials) {
    console.log(`  ${item.role.padEnd(10)} ${item.email.padEnd(26)} ${item.password}`);
  }
  console.log("======================================================================");
  console.log(`\n当前库中条目总数：${total}`);
  console.log("启动方式：npm run dev（API）与 npm run dev:worker（异步任务）\n");
}

main()
  .catch((error) => {
    console.error("种子数据写入失败：", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
