import { Button, Checkbox, Empty, Image, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
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
  /** 每页条数可选项，默认 10 / 20 / 50 */
  pageSizeOptions?: number[];
  /** 默认每页条数，默认 10 */
  defaultPageSize?: number;
}

/** 产品信息页与选品页共用：列完全一致（产品名称 / 产品类目 / 产品价格 / 图片 / 选择框） */
export default function ProductTable({
  records,
  selectedKeys,
  onSelectionChange,
  loading = false,
  showChannelTag = false,
  pageSizeOptions = [10, 20, 50],
  defaultPageSize = 10,
}: Props) {
  const selected = new Set(selectedKeys);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  // 删除 / 清空后当前页可能超出范围，拉回最后一页，避免停在空白页
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(records.length / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [records.length, pageSize, page]);

  // 排序时把「没有值」的行排在最后：升序/降序都当它是最小值处理，
  // 这样按销量降序时不会因为一堆 null 把真数据挤下去。
  const missingLast = (v: number | null | undefined) => (v === null || v === undefined ? -1 : v);

  const columns: ColumnsType<TableRow> = [
    {
      title: "产品名称",
      dataIndex: "productName",
      key: "productName",
      // 宽度固定 33%，超出部分省略号 + 悬浮显示完整名称（showTitle:false 关掉浏览器
      // 原生 title，改用 antd Tooltip，样式统一、也能把采集到的描述一起带上）
      width: "33%",
      align: "center",
      ellipsis: { showTitle: false },
      render: (value: string, row) => {
        const label = value || "—";
        return (
          <Tooltip
            placement="topLeft"
            title={
              <span>
                {label}
                {row.description ? <div className="tooltip-desc">{row.description}</div> : null}
              </span>
            }
          >
            <span className="cell-product">
              {row.productUrl ? (
                <a href={row.productUrl} target="_blank" rel="noreferrer noopener">
                  {label}
                </a>
              ) : (
                <span>{label}</span>
              )}
              {showChannelTag ? (
                <Tag color={CHANNEL_COLOR[row.channel]} className="cell-channel-tag">
                  {CHANNEL_LABEL[row.channel]}
                </Tag>
              ) : null}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "产品类目",
      dataIndex: "category",
      key: "category",
      width: 180,
      align: "center",
      ellipsis: true,
      render: (value: string) => value || "—",
    },
    {
      title: "产品价格",
      dataIndex: "price",
      key: "price",
      width: 120,
      align: "center",
      // 只有价格和销量需要排序：名称/类目是文本，排序对选品没意义
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
      align: "center",
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
      // 120×120 缩略图，列宽留出边距，行高由图片撑开
      width: 144,
      align: "center",
      render: (value: string) =>
        value ? (
          <Image
            src={value}
            alt="商品图片"
            width={120}
            height={120}
            style={{ objectFit: "cover", borderRadius: 8 }}
            fallback="data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect width='120' height='120' fill='%23f0f0f0'/%3E%3C/svg%3E"
          />
        ) : (
          <span className="muted">无图片</span>
        ),
    },
    {
      title: "选择框",
      key: "select",
      width: 90,
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
      scroll={{ x: 1000 }}
      size="middle"
      pagination={{
        current: page,
        pageSize,
        total: records.length,
        // 分页器给全：每页条数、快速跳页、总数范围、首末页
        showSizeChanger: true,
        showQuickJumper: true,
        pageSizeOptions: pageSizeOptions.map(String),
        showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
        onChange: (nextPage, nextSize) => {
          // antd 在切换每页条数时也会走 onChange，此时回到第 1 页
          if (nextSize !== pageSize) {
            setPageSize(nextSize);
            setPage(1);
          } else {
            setPage(nextPage);
          }
        },
      }}
      title={(pageRows) => {
        // 分页后「全选」只作用于当前页，跨页全选单独给一个入口，避免误删
        const pageKeys = pageRows.map((r) => r.key);
        const pageAllChecked = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
        const pageSomeChecked = pageKeys.some((k) => selected.has(k));

        const togglePage = (checked: boolean) => {
          if (checked) {
            onSelectionChange(Array.from(new Set([...selectedKeys, ...pageKeys])));
          } else {
            const drop = new Set(pageKeys);
            onSelectionChange(selectedKeys.filter((k) => !drop.has(k)));
          }
        };

        return (
          <div className="table-toolbar">
            <div className="toolbar-left">
              <Checkbox
                checked={pageAllChecked}
                indeterminate={!pageAllChecked && pageSomeChecked}
                onChange={(e) => togglePage(e.target.checked)}
              >
                全选本页
              </Checkbox>
              {selectedKeys.length ? (
                <Button type="link" size="small" onClick={() => onSelectionChange([])}>
                  清空勾选
                </Button>
              ) : records.length > pageSize ? (
                <Button
                  type="link"
                  size="small"
                  onClick={() => onSelectionChange(records.map((r) => r.key))}
                >
                  全选全部 {records.length} 项
                </Button>
              ) : null}
            </div>
            <span className="muted">
              已选 <b>{selectedKeys.length}</b> 项 / 共 {records.length} 项
            </span>
          </div>
        );
      }}
      locale={{
        emptyText: loading ? "加载中…" : <Empty description="暂无数据" />,
      }}
    />
  );
}
