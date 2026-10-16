import { Checkbox, Empty, Image, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { ChannelId } from "../types";
import { formatCount, formatPrice } from "../lib/format";

/** 两个页面共用的行结构 */
export interface TableRow {
  key: string;
  channel: ChannelId;
  channelKey: string;
  productName: string;
  category: string;
  price: number | null;
  currency: string;
  /** 销量 / 评价数（整数）；取不到为 null，展示「—」 */
  sales?: number | null;
  imageUrl: string;
  productUrl: string;
  description?: string;
  source?: string;
  /** 采集记录在服务端收件箱里的 id，用于删除时同步清理 */
  collectId?: string;
}

export const CHANNEL_LABEL: Record<ChannelId, string> = {
  samsclub: "山姆",
  amazon: "亚马逊",
  tiktokshop: "TikTok Shop",
};

const CHANNEL_COLOR: Record<ChannelId, string> = {
  samsclub: "blue",
  amazon: "orange",
  tiktokshop: "magenta",
};

interface Props {
  records: TableRow[];
  selectedKeys: string[];
  onSelectionChange: (keys: string[]) => void;
  loading?: boolean;
  /** 选品页在名称下加渠道角标，便于区分来源；产品信息页不需要 */
  showChannelTag?: boolean;
}

/** 产品信息页与选品页共用：列完全一致（产品名称 / 产品类目 / 产品价格 / 图片 / 选择框） */
export default function ProductTable({
  records,
  selectedKeys,
  onSelectionChange,
  loading = false,
  showChannelTag = false,
}: Props) {
  const selected = new Set(selectedKeys);
  const allChecked = records.length > 0 && records.every((r) => selected.has(r.key));

  // 排序时把「没有值」的行排在最后：升序/降序都当它是最小值处理，
  // 这样按销量降序时不会因为一堆 null 把真数据挤下去。
  const missingLast = (v: number | null | undefined) => (v === null || v === undefined ? -1 : v);

  const columns: ColumnsType<TableRow> = [
    {
      title: "产品名称",
      dataIndex: "productName",
      key: "productName",
      ellipsis: true,
      sorter: (a, b) => a.productName.localeCompare(b.productName, "zh-Hans-CN"),
      render: (value: string, row) => (
        <span className="cell-product">
          {row.productUrl ? (
            <a href={row.productUrl} target="_blank" rel="noreferrer noopener">
              {value || "—"}
            </a>
          ) : (
            value || "—"
          )}
          {showChannelTag ? (
            <Tag color={CHANNEL_COLOR[row.channel]} className="cell-channel-tag">
              {CHANNEL_LABEL[row.channel]}
            </Tag>
          ) : null}
          {row.description ? (
            <Tooltip title={row.description} placement="topLeft">
              <div className="cell-desc">{row.description.slice(0, 60)}</div>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      title: "产品类目",
      dataIndex: "category",
      key: "category",
      width: 200,
      ellipsis: true,
      sorter: (a, b) => a.category.localeCompare(b.category, "zh-Hans-CN"),
      render: (value: string) => value || "—",
    },
    {
      title: "产品价格",
      dataIndex: "price",
      key: "price",
      width: 130,
      sorter: (a, b) => missingLast(a.price) - missingLast(b.price),
      // 只读展示：金额符号按采集到的币种跟在数字后面（19.98$ / 199.00¥ / 12.34€），
      // 采集值原样呈现，不提供编辑入口。
      render: (_: unknown, row) => {
        if (row.price === null || row.price === undefined) {
          return (
            <Tooltip title="页面未暴露价格（常见于需登录或异步加载的站点）">
              <span className="muted">—</span>
            </Tooltip>
          );
        }
        const code = (row.currency || "USD").toUpperCase();
        return (
          <Tooltip title={`采集币种：${code}`}>
            <span className="cell-price">{formatPrice(row.price, row.currency)}</span>
          </Tooltip>
        );
      },
    },
    {
      title: (
        <Tooltip title="页面上的销量 / 评价数。山姆取的是星级右边那个数字（本质是评价数）；亚马逊是 ratings，TikTok 是 sold。">
          <span>销量</span>
        </Tooltip>
      ),
      dataIndex: "sales",
      key: "sales",
      width: 110,
      align: "right",
      sorter: (a, b) => missingLast(a.sales) - missingLast(b.sales),
      render: (value: number | null | undefined) =>
        value === null || value === undefined ? (
          <Tooltip title="页面未展示销量 / 评价数">
            <span className="muted">—</span>
          </Tooltip>
        ) : (
          <span className="cell-sales">{formatCount(value)}</span>
        ),
    },
    {
      title: "图片",
      dataIndex: "imageUrl",
      key: "imageUrl",
      width: 96,
      render: (value: string) =>
        value ? (
          <Image
            src={value}
            alt="商品图片"
            width={56}
            height={56}
            style={{ objectFit: "cover", borderRadius: 6 }}
            fallback="data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'%3E%3Crect width='56' height='56' fill='%23f0f0f0'/%3E%3C/svg%3E"
          />
        ) : (
          <span className="muted">无图片</span>
        ),
    },
    {
      title: "选择框",
      key: "select",
      width: 80,
      align: "center",
      render: (_: unknown, row) => (
        <Checkbox
          checked={selected.has(row.key)}
          onChange={(e) =>
            onSelectionChange(
              e.target.checked
                ? [...selectedKeys, row.key]
                : selectedKeys.filter((k) => k !== row.key)
            )
          }
        />
      ),
    },
  ];

  return (
    <Table<TableRow>
      rowKey="key"
      columns={columns}
      dataSource={records}
      loading={loading}
      pagination={false}
      scroll={{ x: 880 }}
      size="middle"
      rowSelection={undefined}
      title={() => (
        <div className="table-toolbar">
          <Checkbox
            checked={allChecked}
            indeterminate={!allChecked && selectedKeys.length > 0}
            onChange={(e) =>
              onSelectionChange(e.target.checked ? records.map((r) => r.key) : [])
            }
          >
            全选
          </Checkbox>
          <span className="muted">
            已选 <b>{selectedKeys.length}</b> 项 / 共 {records.length} 项
          </span>
        </div>
      )}
      locale={{
        emptyText: loading ? "加载中…" : <Empty description="暂无数据" />,
      }}
    />
  );
}
