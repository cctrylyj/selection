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

/* ---------------- 样式索引（对应 styles.xml 里 cellXfs 的顺序） ---------------- */
const S_TEXT = 0;
const S_HEADER = 1;
const S_MONEY = 2;
const S_INT = 3;

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

/* ---------------- sheet / workbook / styles ---------------- */
function cellXml(ref: string, value: CellValue, format?: "money" | "int"): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const style = format === "money" ? S_MONEY : format === "int" ? S_INT : S_TEXT;
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  const text = String(value);
  if (!text) return "";
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function sheetXml<T>(
  columns: ExcelColumn<T>[],
  rows: T[],
  images: ExcelImage[],
  imageRowHeight: number
): string {
  const lastCol = colName(columns.length - 1);
  const cols = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 16}" customWidth="1"/>`)
    .join("");

  const header =
    "<row r=\"1\" ht=\"22\" customHeight=\"1\">" +
    columns
      .map((c, i) => `<c r="${colName(i)}1" s="${S_HEADER}" t="inlineStr"><is><t>${esc(c.header)}</t></is></c>`)
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
        .map((c, i) => cellXml(`${colName(i)}${rowNo}`, c.value(row), c.format))
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

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="\u7b49\u7ebf"/></font>
<font><b/><sz val="11"/><color theme="1"/><name val="\u7b49\u7ebf"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F3F5"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" horizontal="center"/></xf>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="\u5e38\u89c4" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

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
  /** 有图的行高（磅），默认 60（约 80px，刚好放下 72px 的缩略图） */
  imageRowHeight?: number;
}

/** 生成并直接触发浏览器下载 */
export function exportXlsx<T>({
  filename,
  sheetName = "Sheet1",
  columns,
  rows,
  images = [],
  imageRowHeight = 60,
}: ExportOptions<T>): void {
  const encoder = new TextEncoder();
  const safeSheet = sheetName.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Sheet1";

  const files: ZipEntry[] = [
    { name: "[Content_Types].xml", data: encoder.encode(contentTypesXml(images.length > 0)) },
    { name: "_rels/.rels", data: encoder.encode(ROOT_RELS_XML) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml(safeSheet)) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(WORKBOOK_RELS_XML) },
    { name: "xl/styles.xml", data: encoder.encode(STYLES_XML) },
    {
      name: "xl/worksheets/sheet1.xml",
      data: encoder.encode(sheetXml(columns, rows, images, imageRowHeight)),
    },
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
