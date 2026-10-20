import { CHANNEL_LABEL, type TableRow } from "../components/ProductTable";
import { exportXlsx, fileStamp, type ExcelColumn, type ExcelImage } from "./excel";
import { fetchThumbs } from "./imageThumb";

/**
 * 商品列表 → Excel 的列定义。
 * 与页面表格保持一致的字段顺序；「图片」列是真正的嵌入图（不是链接），
 * 缩略图由 imageThumb.ts 下载 + 转 JPEG + 缩到 72px 后写进 drawing。
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
    width: 52,
    value: (r) => r.productUrl || "",
  },
  {
    header: "图片",
    width: 12,
    // 图片走 drawing 锚定，单元格本身留空
    value: () => null,
  },
];

/** 图片列的 0-based 下标 */
const IMAGE_COL = PRODUCT_COLUMNS.findIndex((c) => c.header === "图片");

export interface ExportResult {
  /** 导出的数据行数 */
  rows: number;
  /** 成功嵌入的图片数 */
  images: number;
  /** 有图但没取到的行数（留空，不阻断导出） */
  failed: number;
}

export interface ExportProductsOptions {
  /** 是否下载并嵌入图片，默认 true；关掉就是纯文字表（更快） */
  withImages?: boolean;
  /** 图片下载进度，用于按钮上的 loading 文案 */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 导出商品行到 .xlsx（含嵌入的商品图）。
 * @param rows 要导出的行（调用方决定是勾选项还是全部）
 * @param title 文件名前缀，如「商品列表」
 */
export async function exportProductsToExcel(
  rows: TableRow[],
  title = "商品列表",
  { withImages = true, onProgress }: ExportProductsOptions = {}
): Promise<ExportResult> {
  const images: ExcelImage[] = [];
  let failed = 0;

  if (withImages) {
    const urls = rows.map((r) => r.imageUrl || "");
    const thumbs = await fetchThumbs(urls, 4, onProgress);
    thumbs.forEach((thumb, index) => {
      if (thumb) {
        images.push({
          col: IMAGE_COL,
          // 表头占第 0 行，所以第 index 条数据落在第 index + 1 行
          row: index + 1,
          data: thumb.data,
          extension: thumb.extension,
          width: thumb.width,
          height: thumb.height,
        });
      } else if (urls[index]) {
        failed += 1;
      }
    });
  }

  exportXlsx({
    filename: `${title}_${fileStamp()}`,
    sheetName: title.slice(0, 31),
    columns: PRODUCT_COLUMNS,
    rows,
    images,
  });

  return { rows: rows.length, images: images.length, failed };
}
