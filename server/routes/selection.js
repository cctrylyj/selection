/** /api/selection —— 选品列表、批量加入、批量移除（数据全部落 Supabase） */

import { Router } from "express";
import { getDb, TABLE } from "../db.js";
import { AppError, ChannelError, DbError } from "../lib/errors.js";

const router = Router();

const channels = ["samsclub", "amazon", "tiktokshop"];

function assertChannel(c) {
  if (!channels.includes(c)) {
    throw new AppError("BAD_CHANNEL", `未知渠道：${c}`, `可选：${channels.join(" / ")}`, 400);
  }
}

/**
 * 从 Supabase 的错误对象里挑出最能说明问题的一句话。
 * 注意 head:true 的计数查询里 message 常常是空串（细节在 details/code 里），
 * 只取 message 会得到「统计失败：」这种没有信息的提示。
 */
function dbErrorDetail(error) {
  return error.message || error.details || error.hint || error.code || "未知错误";
}

function rowToDto(row) {
  return {
    id: row.id,
    channel: row.channel,
    channelKey: row.channel_key,
    productName: row.product_name,
    category: row.category ?? "",
    price: row.price,
    currency: row.currency ?? "USD",
    sales: row.sales ?? null,
    imageUrl: row.image_url ?? "",
    productUrl: row.product_url ?? "",
    createdAt: row.created_at,
  };
}

function productToRow(p) {
  if (!p || typeof p !== "object") throw new AppError("BAD_BODY", "商品数据格式不正确", "", 400);
  const channel = String(p.channel ?? "").trim();
  const channelKey = String(p.channelKey ?? "").trim();
  const productName = String(p.productName ?? "").trim();

  assertChannel(channel);
  if (!channelKey) throw new AppError("BAD_BODY", "商品缺少 channelKey", "缺少渠道内商品标识，无法确认是哪个商品", 400);
  if (!productName) throw new AppError("BAD_BODY", "商品缺少 productName", "", 400);

  const price = Number(p.price);
  const sales = Number(p.sales);
  return {
    channel,
    channel_key: channelKey,
    product_name: productName.slice(0, 500),
    category: String(p.category ?? "").slice(0, 500),
    price: Number.isFinite(price) ? price : null,
    currency: String(p.currency ?? "USD").slice(0, 10),
    sales: Number.isFinite(sales) && sales > 0 ? Math.round(sales) : null,
    image_url: String(p.imageUrl ?? "").slice(0, 2000),
    product_url: String(p.productUrl ?? "").slice(0, 2000),
    raw: { source: "products-page", price: p.price ?? null, sales: p.sales ?? null },
  };
}

async function countAll(db) {
  const { count, error } = await db.from(TABLE).select("id", { count: "exact", head: true });
  if (error) throw new AppError("DB_ERROR", `统计失败：${error.message}`, error.hint ?? "", 503);
  return count ?? 0;
}

/** GET /api/selection?page=1&pageSize=100&channel=samsclub */
router.get("/", async (req, res, next) => {
  try {
    const db = getDb();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 100));
    const channel = String(req.query.channel || "").trim();
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let q = db
      .from(TABLE)
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (channel) {
      assertChannel(channel);
      q = q.eq("channel", channel);
    }

    const { data, error, count } = await q;
    if (error) throw new AppError("DB_ERROR", `查询失败：${dbErrorDetail(error)}`, error.hint ?? "", 503);

    res.json({
      ok: true,
      data: {
        items: (data ?? []).map(rowToDto),
        total: count ?? 0,
        page,
        pageSize,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/selection/stats
 *
 * 注意：这里**不能**把查询错误吞掉当成 0。
 * 曾经写成 `if (error) return { count: 0 }`，结果线上表权限丢了
 * （permission denied for table selections）时，接口照样回 ok + total=0，
 * 排查时被误判成「库里确实没数据」。失败就如实报错。
 */
router.get("/stats", async (_req, res, next) => {
  try {
    const db = getDb();
    const rows = await Promise.all(
      channels.map(async (c) => {
        // 不用 head:true —— HEAD 请求出错时 PostgREST 不返回正文，
        // supabase-js 拿到的 error 各字段全空，提示会变成「统计失败：未知错误」。
        // 改成普通查询 + limit(1)：count 走响应头，错误也能拿到真实描述。
        const { count, error } = await db
          .from(TABLE)
          .select("id", { count: "exact" })
          .eq("channel", c)
          .limit(1);
        if (error) {
          throw new DbError(
            `统计失败：${dbErrorDetail(error)}`,
            "请检查服务端是否已对 public.selections 授权给 service_role（见 sql/004_grant_service_role.sql）。"
          );
        }
        return { channel: c, count: count ?? 0 };
      })
    );
    const total = rows.reduce((s, r) => s + r.count, 0);
    res.json({ ok: true, data: { total, byChannel: rows } });
  } catch (e) {
    next(e);
  }
});

/** POST /api/selection  body: { items: Product[] }  批量加入 */
router.post("/", async (req, res, next) => {
  try {
    const raw = req.body?.items;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new AppError("BAD_BODY", "items 不能为空", "请先在列表中勾选商品", 400);
    }
    if (raw.length > 100) {
      throw new AppError("BAD_BODY", "单次最多加入 100 条", "请分批操作", 400);
    }

    // 先做输入校验（不依赖数据库），再拿连接
    const rows = raw.map(productToRow);

    const db = getDb();

    // 不做去重：商品本身就是唯一的，勾选几次就插几条，直接 insert。
    // 若报唯一约束冲突，说明库上还留着旧索引，执行 sql/002_drop_selections_unique.sql 去掉。
    const { error } = await db.from(TABLE).insert(rows);

    if (error) {
      throw new AppError(
        "DB_ERROR",
        `写入失败：${error.message}`,
        "请确认已在 Supabase 执行 sql/001_selections.sql；若提示唯一约束冲突，"
          + "再执行 sql/002_drop_selections_unique.sql 去掉旧的 (channel, channel_key) 唯一索引；"
          + "若提示 column \"sales\" does not exist，执行 sql/003_add_sales.sql 补上销量列。",
        503
      );
    }

    const after = await countAll(db);

    res.json({ ok: true, data: { added: rows.length, total: after, submitted: rows.length } });
  } catch (e) {
    next(e);
  }
});

/** POST /api/selection/remove  body: { ids: string[] }  批量移除 */
router.post("/remove", async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (!ids.length) throw new AppError("BAD_BODY", "ids 不能为空", "请先勾选要移除的商品", 400);
    if (ids.length > 200) throw new AppError("BAD_BODY", "单次最多移除 200 条", "请分批操作", 400);

    const db = getDb();
    const { data, error } = await db.from(TABLE).delete().in("id", ids).select("id");
    if (error) throw new AppError("DB_ERROR", `删除失败：${error.message}`, error.hint ?? "", 503);

    res.json({ ok: true, data: { removed: (data ?? []).length, requested: ids.length } });
  } catch (e) {
    next(e);
  }
});

/** POST /api/selection/clear?confirm=yes  清空全部（危险操作） */
router.post("/clear", async (req, res, next) => {
  try {
    if (String(req.query.confirm || "") !== "yes") {
      throw new AppError(
        "NEED_CONFIRM",
        "清空操作需要确认",
        "该操作会删除所有选品记录且不可恢复，请带上 confirm=yes 再次调用。",
        400
      );
    }
    const db = getDb();
    const before = await countAll(db);
    const { error } = await db.from(TABLE).delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) throw new AppError("DB_ERROR", `清空失败：${error.message}`, error.hint ?? "", 503);
    res.json({ ok: true, data: { removed: before } });
  } catch (e) {
    next(e);
  }
});

export default router;
