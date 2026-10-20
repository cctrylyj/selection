/**
 * 把商品图变成可以塞进 Excel 单元格的小缩略图。
 *
 * 为什么要走 canvas 而不是直接用原始字节：
 *   1. CDN 上的图有 webp / avif，Excel 不认，canvas 统一转成 JPEG；
 *   2. 原图动辄上千像素，几十张塞进 xlsx 会让文件几十 MB，统一缩到 72px；
 *   3. 顺带统一成正方形白底，表格里看着整齐。
 *
 * 图片由服务端 /api/proxy/image 代取（CDN 没有 CORS 头，浏览器直连拿不到字节）。
 */

/** 单元格里图片的边长（像素），与 excel.ts 里的行高 60 磅配套 */
export const THUMB_SIZE = 72;

export interface Thumb {
  data: Uint8Array;
  extension: "jpeg";
  width: number;
  height: number;
}

/** 拉一张图并转成 JPEG 缩略图；失败返回 null（调用方留空即可，不打断整份导出） */
export async function fetchThumb(url: string, size = THUMB_SIZE): Promise<Thumb | null> {
  if (!url) return null;
  try {
    const res = await fetch(`/api/proxy/image?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const blob = await res.blob();

    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return null;
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    // contain：等比缩放，不裁掉商品主体
    const scale = Math.min(size / bitmap.width, size / bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    ctx.drawImage(bitmap, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
    bitmap.close?.();

    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85)
    );
    if (!jpeg) return null;

    return {
      data: new Uint8Array(await jpeg.arrayBuffer()),
      extension: "jpeg",
      width: size,
      height: size,
    };
  } catch {
    return null;
  }
}

/**
 * 并发受限地批量取图：默认同时 4 张。
 * 一次性发几十个请求既慢又容易被 CDN 限流。
 */
export async function fetchThumbs(
  urls: string[],
  concurrency = 4,
  onProgress?: (done: number, total: number) => void
): Promise<(Thumb | null)[]> {
  const results: (Thumb | null)[] = new Array(urls.length).fill(null);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fetchThumb(urls[index]);
      done += 1;
      onProgress?.(done, urls.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, () => worker())
  );
  return results;
}
