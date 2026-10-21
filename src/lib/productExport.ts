import { CHANNEL_LABEL, type TableRow } from "../components/ProductTable";
import { exportXlsx, fileStamp, type ExcelColumn, type ExcelImage } from "./excel";
import { fetchThumbs, THUMB_SIZE } from "./imageThumb";
import { currencySymbol } from "./format";

/**
 * 价格的 Excel 数字格式码：0.00 后面跟币种单位，与页面列表的
 * 「19.98$ / 199.00¥」完全一致。
 *
 * 用数字格式而不是拼成文本：单元格里仍存 19.98 这个数值，
 * 排序、求和、筛选都还能用；只是显示成带单位的样子。
 * 币种不在符号表里（如 AUD）时退回 `0.00" AUD"`，与 formatPrice 的行为对齐。
 */
function priceFormat(row: TableRow): string | null {
  if (typeof row.price !== "number") return null; // 没价格的单元格不加格式
  const code = (row.currency || "USD").toUpperCase();
  const sym = currencySymbol(code);
  // 格式码里的 $ 在部分环境会被当成格式占位符，必须用引号包成字面量
  return sym ? `0.00"${sym}"` : `0.00" ${code}"`;
}

/**
 * 商品列表 → Excel 的列定义。
 * 与页面表格保持一致的字段顺序；「图片」列是真正的嵌入图（不是链接），
 * 缩略图由 imageThumb.ts 下载 + 转 JPEG + 缩到 200px 后写进 drawing。
 *
 * 2026-10-20 按用户要求调整：
 *   - 去掉「币种」列，单位跟到价格后面（与列表展示一致，不用横向对照两列）
 *   - 去掉「商品链接」列（链接又长又没阅读价值，还会让图片列被文字挤花）
 *   - 图片尺寸 72 → 200
 *   - 价格 / 销量居中并上色，与页面列表的配色对齐
 *     （Excel 里数字默认右对齐、字体是黑的，不显式指定就会跟页面对不上）
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
    // 单位跟在数字后面会多占几个字符，列宽比原来略宽
    width: 14,
    // 价格缺失时留空单元格，不要写 0，否则会被当成「免费」
    value: (r) => (typeof r.price === "number" ? r.price : null),
    numberFormat: priceFormat,
    // 与页面 .cell-price 同色（橙红），居中
    color: "d4380d",
    bold: true,
    center: true,
  },
  {
    header: "销量/评价数",
    width: 14,
    format: "int",
    value: (r) => (typeof r.sales === "number" ? r.sales : null),
    // 与页面 .cell-sales 同色（蓝），居中
    color: "1677ff",
    bold: true,
    center: true,
  },
  {
    header: "图片",
    // 200px 图约合 21 个字符宽（1 字符 ≈ 9.6px）
    width: 23,
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
    // 行高跟图片尺寸配套：200px 的图需要约 156 磅行高，否则会被裁切
    imageRowHeight: Math.ceil((THUMB_SIZE + 8) * 0.75),
  });

  return { rows: rows.length, images: images.length, failed };
}
