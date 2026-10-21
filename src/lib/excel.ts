/**
 * 零依赖的 .xlsx 导出。
 *
 * 项目没有装 xlsx / exceljs，为了一个导出按钮加几百 KB 依赖不划算，
 * 所以这里手写一个最小可用的 xlsx：ZIP（store 不压缩）+ SpreadsheetML。
 * Excel / WPS / Numbers / Google Sheets 都能正常打开，中文不乱码。
 *
 * 只支持单 sheet、纯值（无公式、无合并单元格），对导出商品列表足够了。
 */

type CellValue = string | number | null | undefined;

export interface ExcelColumn<T> {
  header: string;
  /** 列宽，单位近似字符数，默认 16 */
  width?: number;
  value: (row: T) => CellValue;
  /** money → 0.00；int → 千分位 #,##0 */
  format?: "money" | "int";
  /**
   * 自定义数字格式码，如 `0.00"$"`。优先于 format。
   * 按行返回，因此同一列可以按币种显示不同单位（19.98$ / 199.00¥）。
   * 返回 null / undefined 时该单元格不加格式。
   *
   * 为什么用数字格式而不是把 "19.98$" 当文本写进去：
   * 文本会让这一列失去排序、求和、筛选的数值能力；数字格式只改显示，
   * 单元格里仍是 19.98，与页面上「符号跟在数字后面」的样式完全一致。
   */
  numberFormat?: (row: T) => string | null | undefined;
  /** 字体颜色（6 位十六进制，如 "d4380d"），与页面列表配色保持一致 */
  color?: string;
  /** 加粗 */
  bold?: boolean;
  /** 水平居中。Excel 里数字默认右对齐，居中必须显式指定 */
  center?: boolean;
  /** 背景填充色（6 位十六进制），用于胶囊那种色块效果 */
  fill?: string;
}

/**
 * 嵌进单元格的图片。
 * 坐标都是 0-based，row 含表头（表头是第 0 行，第一条数据是第 1 行）。
 * Excel 用 oneCellAnchor 把图「钉」在某个单元格上，行高不够会被裁切，
 * 所以有图的行会自动加高（见 ExportOptions.imageRowHeight）。
 */
export interface ExcelImage {
  col: number;
  row: number;
  data: Uint8Array;
  extension: "png" | "jpeg";
  /** 显示尺寸（像素） */
  width: number;
  height: number;
  /** 距单元格左上角的偏移（像素），默认 4 */
  offsetX?: number;
  offsetY?: number;
}

/* ---------------- 样式常量 ---------------- */
/** 自定义 numFmtId 从 164 起（164 以内是 Excel 内置格式，不能占用） */
const NUMFMT_ID_BASE = 164;

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* ---------------- CRC32（ZIP 必需） ---------------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- 最小 ZIP 打包（store 模式） ---------------- */
interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function zipStore(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  // 时间戳固定成 1980-01-01，避免不同时区生成不同字节
  const dosTime = 0;
  const dosDate = 0x0021;

  entries.forEach((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // 本地文件头签名
    lv.setUint16(4, 20, true); // 解压所需版本
    lv.setUint16(6, 0x0800, true); // 文件名 UTF-8
    lv.setUint16(8, 0, true); // 0 = store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra 长度
    local.set(nameBytes, 30);

    parts.push(local, entry.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // 中央目录签名
    cv.setUint16(4, 20, true); // 创建版本
    cv.setUint16(6, 20, true); // 解压所需版本
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // 起始磁盘号
    cv.setUint16(36, 0, true); // 内部属性
    cv.setUint32(38, 0, true); // 外部属性
    cv.setUint32(42, offset, true); // 本地头偏移
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + size;
  });

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD 签名
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const all = [...parts, ...central, end];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  all.forEach((chunk) => {
    out.set(chunk, pos);
    pos += chunk.length;
  });
  return out;
}

/* ---------------- XML 工具 ---------------- */
// 去掉 XML 1.0 不允许的控制字符，否则 Excel 会报文件损坏
const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function esc(value: string): string {
  return value
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0 → A, 25 → Z, 26 → AA */
function colName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/* ---------------- 单元格样式 ---------------- */

/**
 * 一个单元格的样式规格。
 * 用「规格 → xf 索引」的登记表统一分配，避免手写 cellXfs 顺序。
 */
interface CellStyle {
  /** 自定义数字格式码，如 0.00"$" */
  numFmtCode?: string;
  /** 内置数字格式：2 → 0.00，3 → #,##0 */
  builtinNumFmt?: number;
  /** 字体颜色，ARGB 或 6 位十六进制（5B8 → FFD4380D） */
  color?: string;
  bold?: boolean;
  /** 水平居中；不设则沿用 Excel 默认（数字右对齐） */
  center?: boolean;
  /** 背景填充色 */
  fill?: string;
}

/** "D4380D" / "#d4380d" / "FFD4380D" → "FFD4380D" */
function toArgb(color: string): string {
  const hex = color.replace(/^#/, "").toUpperCase();
  return hex.length === 6 ? `FF${hex}` : hex;
}

/** 登记表里的一条：原始规格 + 已解析好的三个 id */
interface ResolvedStyle {
  spec: CellStyle;
  numFmtId: number;
  fontId: number;
  fillId: number;
}

/**
 * 样式登记表：把用到的字体 / 填充 / 数字格式 / 对齐方式组合，
 * 统一分配成 styles.xml 里的 fontId / fillId / numFmtId / xf 索引。
 *
 * 各 id 的偏移是 OOXML 的硬性约定，不能从 0 随便排：
 *   - fill 0/1 必须留空（none + gray125），自定义填充从 2 起
 *   - numFmtId < 164 是 Excel 内置格式，自定义格式从 164 起
 */
class StyleRegistry {
  private readonly fonts: { color?: string; bold?: boolean }[] = [];
  private readonly fills: string[] = [];
  private readonly numFmtCodes: string[] = [];
  private readonly specs: ResolvedStyle[] = [];
  private readonly xfIndex = new Map<string, number>();

  constructor() {
    // font 0 = 常规正文；顺序固定，后面按需追加
    this.fonts.push({});
    // cellXfs 的 0 号必须是「朴素默认样式」：OOXML 规定没写 s="..." 的单元格
    // 一律按 0 号样式渲染。如果让表头（加粗 + 灰底 + 居中）占了 0 号，
    // 所有没显式指定样式的单元格都会被染成表头那样。
    this.register({});
  }

  private fontId(spec: CellStyle): number {
    if (!spec.color && !spec.bold) return 0;
    const hit = this.fonts.findIndex(
      (f) => f.color === spec.color && !!f.bold === !!spec.bold
    );
    if (hit >= 0) return hit;
    this.fonts.push({ color: spec.color, bold: spec.bold });
    return this.fonts.length - 1;
  }

  private fillId(spec: CellStyle): number {
    if (!spec.fill) return 0;
    const argb = toArgb(spec.fill);
    const hit = this.fills.indexOf(argb);
    if (hit >= 0) return hit + 2; // 前两个 fill 是 none / gray125
    this.fills.push(argb);
    return this.fills.length + 1;
  }

  private numFmtId(spec: CellStyle): number {
    if (spec.numFmtCode) {
      const hit = this.numFmtCodes.indexOf(spec.numFmtCode);
      if (hit >= 0) return NUMFMT_ID_BASE + hit;
      this.numFmtCodes.push(spec.numFmtCode);
      return NUMFMT_ID_BASE + this.numFmtCodes.length - 1;
    }
    return spec.builtinNumFmt ?? 0;
  }

  /**
   * 登记一个样式，返回 `s="..."` 用的索引。
   *
   * 关键：numFmtId / fontId / fillId 必须在这里就算出来并落到 specs 里。
   * 不能在 cellXfsXml() 里现算——styles.xml 是模板字符串拼的，
   * fonts/fills/numFmts 三个片段会先于 cellXfs 求值，那时表还是空的，
   * 生成的字体表就只有 count="1"，Excel 打开会报样式损坏。
   */
  register(spec: CellStyle): number {
    const key = JSON.stringify(spec);
    const hit = this.xfIndex.get(key);
    if (hit !== undefined) return hit;

    const resolved: ResolvedStyle = {
      spec,
      numFmtId: this.numFmtId(spec),
      fontId: this.fontId(spec),
      fillId: this.fillId(spec),
    };
    const id = this.specs.length;
    this.specs.push(resolved);
    this.xfIndex.set(key, id);
    return id;
  }

  numFmtsXml(): string {
    if (!this.numFmtCodes.length) return "";
    const items = this.numFmtCodes
      .map(
        (code, i) =>
          `<numFmt numFmtId="${NUMFMT_ID_BASE + i}" formatCode="${esc(code)}"/>`
      )
      .join("");
    return `<numFmts count="${this.numFmtCodes.length}">${items}</numFmts>`;
  }

  fontsXml(): string {
    const items = this.fonts
      .map((f) => {
        const color = f.color ? `<color rgb="${toArgb(f.color)}"/>` : '<color theme="1"/>';
        const bold = f.bold ? "<b/>" : "";
        return `<font>${bold}<sz val="11"/>${color}<name val="\u7b49\u7ebf"/></font>`;
      })
      .join("");
    return `<fonts count="${this.fonts.length}">${items}</fonts>`;
  }

  fillsXml(): string {
    // 前两个是 Excel 要求的保留项，不能省
    const base =
      '<fill><patternFill patternType="none"/></fill>'
      + '<fill><patternFill patternType="gray125"/></fill>';
    const custom = this.fills
      .map(
        (argb) =>
          `<fill><patternFill patternType="solid"><fgColor rgb="${argb}"/><bgColor indexed="64"/></patternFill></fill>`
      )
      .join("");
    return `<fills count="${2 + this.fills.length}">${base}${custom}</fills>`;
  }

  cellXfsXml(): string {
    const items = this.specs
      .map(({ spec, numFmtId, fontId, fillId }) => {
        const apply: string[] = [];
        if (numFmtId) apply.push('applyNumberFormat="1"');
        if (fontId) apply.push('applyFont="1"');
        if (fillId) apply.push('applyFill="1"');
        apply.push('applyAlignment="1"');

        // 所有单元格都垂直居中；水平方向只有显式要求时才居中，
        // 否则保持 Excel 默认（数字右对齐、文本左对齐）
        const alignment = spec.center
          ? '<alignment vertical="center" horizontal="center"/>'
          : '<alignment vertical="center"/>';

        return `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" ${apply.join(" ")}>${alignment}</xf>`;
      })
      .join("");
    return `<cellXfs count="${this.specs.length}">${items}</cellXfs>`;
  }
}

/* ---------------- sheet / workbook / styles ---------------- */
function cellXml(
  ref: string,
  value: CellValue,
  style: number
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  const text = String(value);
  if (!text) return "";
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

/** 把列定义翻译成样式规格 */
function specFor<T>(col: ExcelColumn<T>, row: T): CellStyle {
  const spec: CellStyle = {};

  const custom = col.numberFormat?.(row);
  if (custom) spec.numFmtCode = custom;
  else if (col.format === "money") spec.builtinNumFmt = 2;
  else if (col.format === "int") spec.builtinNumFmt = 3;

  if (col.color) spec.color = col.color;
  if (col.bold) spec.bold = true;
  if (col.center) spec.center = true;
  if (col.fill) spec.fill = col.fill;

  return spec;
}

function sheetXml<T>(
  columns: ExcelColumn<T>[],
  rows: T[],
  images: ExcelImage[],
  imageRowHeight: number,
  styles: StyleRegistry
): string {
  const lastCol = colName(columns.length - 1);
  const cols = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 16}" customWidth="1"/>`)
    .join("");

  // 表头：加粗 + 浅灰底 + 居中，固定用登记表里的第一个样式（index 0）
  const headerStyle = styles.register({ bold: true, fill: "F2F3F5", center: true });

  const header =
    "<row r=\"1\" ht=\"22\" customHeight=\"1\">" +
    columns
      .map((c, i) => `<c r="${colName(i)}1" s="${headerStyle}" t="inlineStr"><is><t>${esc(c.header)}</t></is></c>`)
      .join("") +
    "</row>";

  // 有图的行走高一点，否则图片会被行高裁掉
  const rowsWithImage = new Set(images.map((img) => img.row));

  const body = rows
    .map((row, r) => {
      const rowNo = r + 2;
      const tall = rowsWithImage.has(rowNo - 1)
        ? ` ht="${imageRowHeight}" customHeight="1"`
        : "";
      const cells = columns
        .map((c, i) =>
          cellXml(`${colName(i)}${rowNo}`, c.value(row), styles.register(specFor(c, row)))
        )
        .join("");
      return `<row r="${rowNo}"${tall}>${cells}</row>`;
    })
    .join("");

  const lastRow = rows.length + 1;
  const drawing = images.length ? '\n<drawing r:id="rId1"/>' : "";
  const rootNs = images.length
    ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${rootNs}>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="16"/>
<cols>${cols}</cols>
<sheetData>${header}${body}</sheetData>
<autoFilter ref="A1:${lastCol}${lastRow}"/>${drawing}
</worksheet>`;
}

/* ---------------- 图片（drawing） ---------------- */

/** Excel 的长度单位是 EMU：1 像素 = 9525 EMU */
const EMU_PER_PX = 9525;

function drawingXml(images: ExcelImage[]): string {
  const anchors = images
    .map((img, i) => {
      const cx = Math.round(img.width * EMU_PER_PX);
      const cy = Math.round(img.height * EMU_PER_PX);
      const offX = Math.round((img.offsetX ?? 4) * EMU_PER_PX);
      const offY = Math.round((img.offsetY ?? 4) * EMU_PER_PX);
      return `<xdr:oneCellAnchor>`
        + `<xdr:from><xdr:col>${img.col}</xdr:col><xdr:colOff>${offX}</xdr:colOff>`
        + `<xdr:row>${img.row}</xdr:row><xdr:rowOff>${offY}</xdr:rowOff></xdr:from>`
        + `<xdr:ext cx="${cx}" cy="${cy}"/>`
        + `<xdr:pic><xdr:nvPicPr>`
        + `<xdr:cNvPr id="${i + 2}" name="Picture ${i + 1}"/>`
        + `<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>`
        + `</xdr:nvPicPr>`
        + `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
        + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
        + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>`
        + `</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
}

function drawingRelsXml(images: ExcelImage[]): string {
  const rels = images
    .map(
      (img, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.${img.extension}"/>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

const SHEET_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;

function workbookXml(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function stylesXml(styles: StyleRegistry): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${styles.numFmtsXml()}
${styles.fontsXml()}
${styles.fillsXml()}
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
${styles.cellXfsXml()}
<cellStyles count="1"><cellStyle name="\u5e38\u89c4" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function contentTypesXml(hasImages: boolean): string {
  // 没有图片时不要声明 drawing / 图片类型，保持包体最小、也避免部分阅读器报警告
  const imageDefaults = hasImages
    ? '\n<Default Extension="png" ContentType="image/png"/>'
      + '\n<Default Extension="jpeg" ContentType="image/jpeg"/>'
    : "";
  const drawingOverride = hasImages
    ? '\n<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>${imageDefaults}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${drawingOverride}
</Types>`;
}

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/* ---------------- 对外入口 ---------------- */

/** 文件名里的时间戳：20261020_1217 */
export function fileStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

export interface ExportOptions<T> {
  /** 不含扩展名，例如 商品列表_20261020_1217 */
  filename: string;
  /** sheet 名，Excel 限制 31 字符且不能含 : \ / ? * [ ] */
  sheetName?: string;
  columns: ExcelColumn<T>[];
  rows: T[];
  /** 要嵌进单元格的图片（商品图缩略图） */
  images?: ExcelImage[];
  /** 有图的行高（磅），默认 156（约 208px，刚好放下 200px 的图） */
  imageRowHeight?: number;
}

/** 生成并直接触发浏览器下载 */
export function exportXlsx<T>({
  filename,
  sheetName = "Sheet1",
  columns,
  rows,
  images = [],
  imageRowHeight = 156,
}: ExportOptions<T>): void {
  const encoder = new TextEncoder();
  const safeSheet = sheetName.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet1";

  // 注意顺序：sheetXml 生成单元格时会**登记**用到的样式，
  // 所以必须先跑 sheet，再生成 styles.xml，否则样式表会缺项。
  const styles = new StyleRegistry();
  const sheet = sheetXml(columns, rows, images, imageRowHeight, styles);

  const files: ZipEntry[] = [
    { name: "[Content_Types].xml", data: encoder.encode(contentTypesXml(images.length > 0)) },
    { name: "_rels/.rels", data: encoder.encode(ROOT_RELS_XML) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml(safeSheet)) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(WORKBOOK_RELS_XML) },
    { name: "xl/styles.xml", data: encoder.encode(stylesXml(styles)) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheet) },
  ];

  if (images.length) {
    files.push(
      { name: "xl/worksheets/_rels/sheet1.xml.rels", data: encoder.encode(SHEET_RELS_XML) },
      { name: "xl/drawings/drawing1.xml", data: encoder.encode(drawingXml(images)) },
      { name: "xl/drawings/_rels/drawing1.xml.rels", data: encoder.encode(drawingRelsXml(images)) }
    );
    images.forEach((img, i) => {
      files.push({ name: `xl/media/image${i + 1}.${img.extension}`, data: img.data });
    });
  }

  const bytes = zipStore(files);
  // 拷贝到独立的 ArrayBuffer 再交给 Blob：TS 5.7 起 Uint8Array 带 buffer 泛型，
  // 直接传 Uint8Array 会因为 ArrayBufferLike 可能是 SharedArrayBuffer 而报类型错。
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.toLowerCase().endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立刻 revoke 在部分浏览器会打断下载，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
