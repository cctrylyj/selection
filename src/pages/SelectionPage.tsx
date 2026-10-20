import { Alert, Button, Card, Empty, Popconfirm, Statistic, Tooltip, message } from "antd";
import { DeleteOutlined, DownloadOutlined, PlusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import ProductTable, { type TableRow } from "../components/ProductTable";
import { api } from "../api";
import { selectionBus } from "../lib/bus";
import { exportProductsToExcel } from "../lib/productExport";
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
  const [exporting, setExporting] = useState(false);
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

  /** 导出 Excel：勾选了只导勾选项，没勾选导全部选品；商品图嵌进单元格 */
  const exportExcel = async () => {
    const chosen = selectedKeys.length
      ? records.filter((r) => selectedKeys.includes(r.key))
      : records;
    if (!chosen.length) {
      message.warning("选品列表为空，没有可导出的数据");
      return;
    }
    const key = "export-excel";
    setExporting(true);
    message.loading({ content: `正在下载 ${chosen.length} 张商品图…`, key, duration: 0 });
    try {
      const res = await exportProductsToExcel(chosen, "选品列表", {
        onProgress: (done, total) =>
          message.loading({ content: `正在下载商品图 ${done}/${total}…`, key, duration: 0 }),
      });
      message.success({
        key,
        content:
          `已导出 ${res.rows} 项，嵌入 ${res.images} 张图片`
          + (res.failed ? `，${res.failed} 张图片下载失败已留空` : ""),
      });
    } catch (e) {
      message.error({ key, content: (e as Error).message || "导出失败" });
    } finally {
      setExporting(false);
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
            <div style={{ display: "flex", gap: 8 }}>
              <Tooltip
                title={
                  selectedKeys.length
                    ? `只导出勾选的 ${selectedKeys.length} 项`
                    : `未勾选，默认导出全部 ${records.length} 项（含所有分页，不只是当前页）`
                }
              >
                <Button
                  icon={<DownloadOutlined />}
                  disabled={!records.length}
                  loading={exporting}
                  onClick={exportExcel}
                >
                  导出 Excel{selectedKeys.length ? `（已选 ${selectedKeys.length}）` : ""}
                </Button>
              </Tooltip>
              <Button
                danger
                icon={<DeleteOutlined />}
                disabled={!selectedKeys.length}
                onClick={removeSelected}
              >
                移除（已选 {selectedKeys.length}）
              </Button>
            </div>
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
