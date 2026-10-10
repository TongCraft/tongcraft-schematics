export const MAX_PREVIEW_BYTES = 512 * 1024;
export const MAX_PREVIEW_DIMENSION = 1024;

/** Only bounded, static PNGs are accepted as public catalogue images. */
export function validatePreview(bytes: Uint8Array): void {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 45 ||
    bytes.length > MAX_PREVIEW_BYTES ||
    signature.some((value, index) => bytes[index] !== value)
  )
    throw new Error("预览图须为不超过 512 KiB 的 PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
    throw new Error("预览图 PNG 头无效");
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (
    !width ||
    !height ||
    width > MAX_PREVIEW_DIMENSION ||
    height > MAX_PREVIEW_DIMENSION
  )
    throw new Error("预览图尺寸须在 1–1024 像素之间");
  let offset = 8,
    hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset),
      type = view.getUint32(offset + 4);
    if (length > bytes.length - offset - 12 || type === 0x6163544c)
      throw new Error("预览图须为完整的静态 PNG");
    if (type === 0x49444154 && length) hasData = true;
    offset += length + 12;
    if (
      type === 0x49454e44 &&
      length === 0 &&
      hasData &&
      offset === bytes.length
    )
      return;
  }
  throw new Error("预览图 PNG 数据不完整");
}
