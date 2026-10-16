import { Alert, Button, Card, Empty, Popconfirm, Statistic, message } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import ProductTable, { type TableRow } from "../components/ProductTable";
import { api } from "../api";
import { selectionBus } from "../lib/bus";
import type { SelectionItem } from "../types";

function toRow(item: SelectionItem): TableRow {
  return {
    key: item.id,
    channel: item.channel,
    channelKey: item.channelKey,
    productName: item.productName,
    category: item.category,
    price: item.price,
    currency: item.currency,
    sales: item.sales ?? null,
    imageUrl: item.imageUrl,
    productUrl: item.productUrl,
  };
}

export default function SelectionPage() {
  const navigate = useNavigate();
  const [records, setRecords] = useState<TableRow[]>([]);
  const [items, setItems] = useState<SelectionItem[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listSelections();
      setItems(res.items);
      setRecords(res.items.map(toRow));
      // 清掉已不在列表里的勾选
      setSelectedKeys((prev) => prev.filter((k) => res.items.some((i) => i.id === k)));
    } catch (e) {
      const err = e as { message?: string; hint?: string };
      setError(err.hint ? `${err.message}（${err.hint}）` : err.message || "加载失败");
      setItems([]);
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return selectionBus.subscribe(load);
  }, [load]);

  const removeSelected = async () => {
    if (!selectedKeys.length) {
      message.warning("请先勾选要移除的商品");
      return;
    }
    setLoading(true);
    try {
      const res = await api.removeSelections(selectedKeys);
      message.success(`已移除 ${res.removed} 项`);
      setSelectedKeys([]);
      selectionBus.emit();
      await load();
    } catch (e) {
      const err = e as { message?: string };
      message.error(err.message || "移除失败");
    } finally {
      setLoading(false);
    }
  };

  const clearAll = async () => {
    setLoading(true);
    try {
      const res = await api.clearSelections();
      message.success(`已清空 ${res.removed} 项`);
      setSelectedKeys([]);
      selectionBus.emit();
      await load();
    } catch (e) {
      const err = e as { message?: string };
      message.error(err.message || "清空失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <Card
        title="选品"
        extra={
          <Popconfirm
            title="确认清空全部选品？"
            description="该操作会删除数据库中的所有选品记录，不可恢复。"
            okText="确认清空"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={clearAll}
          >
            <Button danger disabled={!records.length}>
              清空全部
            </Button>
          </Popconfirm>
        }
      >
        <div className="stats-row">
          <Statistic title="选品总数" value={items.length} />
          <Statistic
            title="已勾选"
            value={selectedKeys.length}
            suffix="项"
          />
        </div>

        {error ? (
          <Alert
            type="error"
            showIcon
            closable
            message="读取选品数据失败"
            description={error}
            onClose={() => setError(null)}
          />
        ) : null}

        {/* 出错时不显示空状态，避免两条提示互相干扰 */}
        {!records.length && !loading && !error ? (
          <Empty
            description="选品还是空的"
            className="empty-block"
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate("/products")}>
              去产品信息页挑选
            </Button>
          </Empty>
        ) : null}
      </Card>

      {records.length ? (
        <Card
          className="list-card"
          title={
            <span>
              选品列表 <span className="muted">勾选后可批量移除</span>
            </span>
          }
          extra={
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={!selectedKeys.length}
              onClick={removeSelected}
            >
              移除（已选 {selectedKeys.length}）
            </Button>
          }
        >
          <ProductTable
            records={records}
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            loading={loading}
            showChannelTag
          />
        </Card>
      ) : null}
    </div>
  );
}
