import { Alert, Button, Card, Form, Input, Popconfirm, Space, Tabs, message, Select } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeleteOutlined, ReloadOutlined, SearchOutlined, StarOutlined } from "@ant-design/icons";

import ProductTable, { type TableRow } from "../components/ProductTable";
import BookmarkletPanel from "../components/BookmarkletPanel";
import ImportPanel from "../components/ImportPanel";
import { api } from "../api";
import { selectionBus } from "../lib/bus";
import type { ChannelId, ChannelInfo, CollectedItem, Product } from "../types";

const PLACEHOLDER: Record<ChannelId, string> = {
  samsclub: "输入产品类型，如 bath tissue、coffee、婴儿纸尿裤",
  amazon: "输入产品类型，如 bath tissue、婴儿纸尿裤",
  tiktokshop: "输入产品类型关键词（需卖家授权）",
};

const ENV_HINT: Record<ChannelId, string> = {
  samsclub: "BRIGHTDATA_API_TOKEN（山姆无官方商品 API，需数据服务商通道）",
  amazon: "AMAZON_ACCESS_KEY / AMAZON_SECRET_KEY / AMAZON_PARTNER_TAG",
  tiktokshop: "TIKTOK_APP_KEY / TIKTOK_APP_SECRET / TIKTOK_ACCESS_TOKEN",
};

const REASON: Record<ChannelId, string> = {
  samsclub:
    "山姆会员店没有公开商品 API，本渠道按「产品类型 → 类目页 → 商品详情」三级下钻拿参考数据："
    + "从 sitemap.xml 解析全站类目页，命中后抓 /c/ 类目页与 /ip/ 详情页（samsclub.com/robots.txt 只禁 /search，其余路径允许）。"
    + "也支持直接粘贴商品链接或 Item ID 做精确查询。",
  amazon: "数据来自官方 Product Advertising API，合规且稳定；首次使用需 Associates 账号在 30 天内有成交。",
  tiktokshop: "数据来自官方开放平台，需已完成开发者应用审批并拿到卖家授权 token。",
};

type TabKey = "online" | "bookmarklet" | "import";

function toRow(p: Product, collectId?: string): TableRow {
  return {
    // 不做去重：商品本身就是唯一的，同一次采集里出现两条就是两条记录。
    // 行标识用采集记录 id（每条唯一），没有 collectId 的（在线检索）才退回渠道键。
    key: collectId ? `c:${collectId}` : `${p.channel}:${p.channelKey}`,
    channel: p.channel,
    channelKey: p.channelKey,
    productName: p.productName,
    category: p.category,
    price: p.price,
    currency: p.currency,
    sales: p.sales ?? null,
    imageUrl: p.imageUrl,
    productUrl: p.productUrl,
    description: p.description,
    source: p.source,
    collectId,
  };
}

/** 直接追加，不做任何去重 */
function appendRows(prev: TableRow[], next: TableRow[]): TableRow[] {
  return next.length ? [...prev, ...next] : prev;
}

export default function ProductsPage() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [channel, setChannel] = useState<ChannelId>("samsclub");
  const [keyword, setKeyword] = useState("");
  const [records, setRecords] = useState<TableRow[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [tab, setTab] = useState<TabKey>("bookmarklet");

  useEffect(() => {
    api
      .channels()
      .then((list) => setChannels(list))
      .catch(() => {
        /* 后端未启动时列表留空，错误在操作时再提示 */
      });
  }, []);

  const current = useMemo(
    () => channels.find((c) => c.id === channel),
    [channels, channel]
  );

  /* ---- 浏览器书签采集：轮询后端收件箱 ---- */
  const lastCollectId = useRef("");
  const appendCollected = useCallback((items: CollectedItem[]) => {
    if (!items.length) return;
    setRecords((prev) => appendRows(prev, items.map((i) => toRow(i.product, i.id))));
    const names = items.map((i) => i.product.productName).slice(0, 3).join("、");
    message.success(
      `采集到 ${items.length} 个商品：${names}${items.length > 3 ? " 等" : ""}`
    );
  }, []);

  /** 批量删除：同时删服务端收件箱，否则刷新后轮询会把它们拉回来 */
  const removeSelected = async () => {
    if (!selectedKeys.length) {
      message.warning("请先勾选要删除的商品");
      return;
    }
    const chosen = records.filter((r) => selectedKeys.includes(r.key));
    const ids = chosen.map((r) => r.collectId).filter((x): x is string => Boolean(x));
    setLoading(true);
    try {
      if (ids.length) await api.deleteCollected({ ids });
      // 在线检索来的行没有 collectId，只从当前列表移除
      setRecords((prev) => prev.filter((r) => !selectedKeys.includes(r.key)));
      setSelectedKeys([]);
      message.success(`已删除 ${chosen.length} 项`);
    } catch (e) {
      message.error((e as Error).message || "删除失败");
    } finally {
      setLoading(false);
    }
  };

  const clearAll = async () => {
    setLoading(true);
    try {
      await api.deleteCollected({ all: true });
      setRecords([]);
      setSelectedKeys([]);
      message.success("已清空商品列表");
    } catch (e) {
      message.error((e as Error).message || "清空失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // 注意：不依赖 tab。用户采集中会在系统页面与商品页之间来回切换，
    // 轮询必须常开，否则回到页面时看不到刚采集的商品。
    let stop = false;
    const poll = async () => {
      try {
        const { items } = await api.pendingCollect(lastCollectId.current);
        if (stop || !items.length) return;
        lastCollectId.current = items[items.length - 1].id;
        appendCollected(items);
      } catch {
        /* 后端未启动时静默 */
      }
    };

    // 静默同步游标：打开页面前就已存在的历史采集被标记为已读，
    // 于是打开页面是一张空列表，只接收打开之后新产生的采集。
    // 首次轮询等这个基线落定再跑，避免 4 秒时把历史带进来。
    const baseline = api
      .pendingCollect("")
      .then(({ items }) => {
        if (!stop && items.length) lastCollectId.current = items[items.length - 1].id;
      })
      .catch(() => {
        /* 后端未启动时忽略，轮询会重试 */
      });

    const timer = setInterval(async () => {
      await baseline;
      if (!stop) await poll();
    }, 4000);

    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [appendCollected]);

  const doSearch = async () => {
    const kw = keyword.trim();
    if (!kw) {
      message.warning("请输入产品类型，如 bath tissue、coffee");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.search(channel, kw);
      setRecords(data.items.map((p) => toRow(p)));
      setSelectedKeys([]);
      if (data.failed.length) {
        message.warning(`${data.failed.length} 条商品字段解析失败，已跳过`);
      }
      if (!data.items.length) {
        message.info("未检索到商品");
      }
    } catch (e) {
      const err = e as { message?: string; hint?: string };
      setError({ message: err.message || "检索失败", hint: err.hint || "" });
      setRecords([]);
      setSelectedKeys([]);
    } finally {
      setLoading(false);
    }
  };

  const addSelected = async () => {
    const chosen = records.filter((r) => selectedKeys.includes(r.key));
    const incomplete = chosen.filter((r) => r.price === null);
    if (!chosen.length) {
      message.warning("请先勾选要加入选品的商品");
      return;
    }
    if (incomplete.length) {
      message.warning(`有 ${incomplete.length} 个商品没有采集到价格，仍会按无价格加入`);
    }
    setLoading(true);
    try {
      const res = await api.addSelections(
        chosen.map((r): Product => ({
          channel: r.channel,
          channelKey: r.channelKey,
          productName: r.productName,
          category: r.category,
          price: r.price,
          currency: r.currency,
          imageUrl: r.imageUrl,
          productUrl: r.productUrl,
        }))
      );
      message.success(`已加入选品 ${res.added} 项`);
      setSelectedKeys([]);
      selectionBus.emit();
    } catch (e) {
      const err = e as { message?: string; hint?: string };
      message.error(err.message || "加入选品失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <Card
        className="filter-card"
        title={
          <Space>
            <span>产品信息</span>
            <span className="muted">数据来源三选一</span>
          </Space>
        }
      >
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as TabKey)}
          items={[
            {
              key: "bookmarklet",
              label: "浏览器采集（无需任何账号）",
              children: <BookmarkletPanel />,
            },
            {
              key: "import",
              label: "粘贴导入",
              children: (
                <ImportPanel
                  onImported={(item) => {
                    setRecords((prev) => appendRows(prev, [toRow(item.product)]));
                  }}
                />
              ),
            },
            {
              key: "online",
              label: "在线检索（需配置凭证）",
              children: (
                <div className="panel-block">
                  <Form layout="inline" className="filter-bar">
                    <Form.Item label="产品渠道">
                      <Select
                        value={channel}
                        style={{ width: 200 }}
                        onChange={(v: ChannelId) => {
                          setChannel(v);
                          setKeyword("");
                          setRecords([]);
                          setSelectedKeys([]);
                          setError(null);
                        }}
                        options={[
                          { value: "samsclub", label: "1 山姆会员店" },
                          { value: "amazon", label: "2 亚马逊" },
                          { value: "tiktokshop", label: "3 TikTok Shop" },
                        ]}
                      />
                    </Form.Item>

                    <Form.Item label="产品类型">
                      <Input
                        value={keyword}
                        allowClear
                        style={{ width: 320 }}
                        placeholder={PLACEHOLDER[channel]}
                        onChange={(e) => setKeyword(e.target.value)}
                        onPressEnter={doSearch}
                      />
                    </Form.Item>

                    <Form.Item>
                      <Space>
                        <Button
                          type="primary"
                          icon={<SearchOutlined />}
                          loading={loading}
                          onClick={doSearch}
                        >
                          搜索
                        </Button>
                        <Button
                          icon={<ReloadOutlined />}
                          onClick={() => {
                            setKeyword("");
                            setRecords([]);
                            setSelectedKeys([]);
                            setError(null);
                          }}
                        >
                          重置
                        </Button>
                      </Space>
                    </Form.Item>
                  </Form>

                  <div className="notice-stack">
                    {current && !current.configured ? (
                      <Alert
                        type="warning"
                        showIcon
                        message={`${current.label} 渠道尚未配置凭证`}
                        description={
                          <span>
                            请在项目根目录 .env 中配置：<code>{ENV_HINT[channel]}</code>，然后重启后端。
                            <br />
                            <b>没有服务商账号或联盟资质？</b>切到「浏览器采集」页签即可，同样能拿到商品数据。
                          </span>
                        }
                      />
                    ) : null}

                    <Alert
                      type="info"
                      showIcon
                      closable
                      message={`${current?.label ?? channel} 数据来源说明`}
                      description={REASON[channel]}
                    />

                    {error ? (
                      <Alert
                        type="error"
                        showIcon
                        closable
                        message={error.message}
                        description={
                          <span>
                            {error.hint || undefined}
                            {error.hint ? <br /> : null}
                            如果暂时拿不到合作渠道凭证，可以直接切到「浏览器采集」页签手动导入。
                          </span>
                        }
                        onClose={() => setError(null)}
                      />
                    ) : null}
                  </div>
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Card
        className="list-card"
        title={
          <Space>
            <span>商品列表</span>
            <span className="muted">勾选后可批量加入选品</span>
          </Space>
        }
        extra={
          <Space>
            <Popconfirm
              title="确认删除选中商品？"
              description={`将删除 ${selectedKeys.length} 项，此操作不可恢复`}
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={removeSelected}
            >
              <Button danger icon={<DeleteOutlined />} disabled={!selectedKeys.length}>
                批量删除（已选 {selectedKeys.length}）
              </Button>
            </Popconfirm>
            <Popconfirm
              title="确认清空整个商品列表？"
              description="仅清空当前列表，已加入选品的不受影响"
              okText="清空"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={clearAll}
            >
              <Button danger type="text" disabled={!records.length}>
                清空
              </Button>
            </Popconfirm>
            <Button
              type="primary"
              icon={<StarOutlined />}
              disabled={!selectedKeys.length}
              onClick={addSelected}
            >
              加入选品（已选 {selectedKeys.length}）
            </Button>
          </Space>
        }
      >
        <ProductTable
          records={records}
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
          loading={loading}
        />
      </Card>
    </div>
  );
}
