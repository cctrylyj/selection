import { CHANNEL_LABEL, type TableRow } from "../components/ProductTable";
import { exportXlsx, fileStamp, type ExcelColumn } from "./excel";

/**
 * 商品列表 → Excel 的列定义。
 * 与页面表格保持一致的字段顺序，另补了「币种」「商品链接」「图片链接」三列，
 * 因为表格里币种是跟在价格后面的符号、链接是可点文字，导出成表格后需要能单独筛选/复用。
 */
const PRODUCT_COLUMNS: ExcelColumn<TableRow>[] = [
  {
    header: "渠道",
    width: 14,
    value: (r) => CHANNEL_LABEL[r.channel],
  },
  {
    header: "产品名称",
    width: 52,
    value: (r) => r.productName || "",
  },
  {
    header: "产品类目",
    width: 26,
    value: (r) => r.category || "",
  },
  {
    header: "产品价格",
    width: 12,
    format: "money",
    // 价格缺失时留空单元格，不要写 0，否则会被当成「免费」
    value: (r) => (typeof r.price === "number" ? r.price : null),
  },
  {
    header: "币种",
    width: 9,
    value: (r) => (r.currency || "USD").toUpperCase(),
  },
  {
    header: "销量/评价数",
    width: 14,
    format: "int",
    value: (r) => (typeof r.sales === "number" ? r.sales : null),
  },
  {
    header: "商品链接",
    width: 60,
    value: (r) => r.productUrl || "",
  },
  {
    header: "图片链接",
    width: 60,
    value: (r) => r.imageUrl || "",
  },
];

/**
 * 导出商品行到 .xlsx。
 * @param rows 要导出的行（调用方决定是勾选项还是全部）
 * @param title 文件名前缀，如「商品列表」
 */
export function exportProductsToExcel(rows: TableRow[], title = "商品列表"): void {
  exportXlsx({
    filename: `${title}_${fileStamp()}`,
    sheetName: title.slice(0, 31),
    columns: PRODUCT_COLUMNS,
    rows,
  });
}
