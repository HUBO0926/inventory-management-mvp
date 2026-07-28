export const ITEM_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const ITEM_IMAGE_TARGET_BYTES = 500 * 1024;
export const ITEM_IMAGE_MAX_EDGE = 1600;
const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validateItemImage(file: File) {
  if (!supportedTypes.has(file.type)) throw new Error('仅支持 JPG、PNG 和 WebP 图片');
  if (file.size > ITEM_IMAGE_MAX_BYTES) throw new Error('图片不能超过10MB');
}

export function calculateItemImageSize(width: number, height: number, maxEdge = ITEM_IMAGE_MAX_EDGE) {
  const ratio = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('当前浏览器无法压缩该图片')), 'image/webp', quality);
  });
}

async function loadImage(file: File) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (context: CanvasRenderingContext2D, width: number, height: number) => context.drawImage(bitmap, 0, 0, width, height),
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图片无法读取'));
      image.src = url;
    });
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw: (context: CanvasRenderingContext2D, width: number, height: number) => context.drawImage(image, 0, 0, width, height),
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function compressItemImage(file: File) {
  validateItemImage(file);
  const source = await loadImage(file);
  try {
    let { width, height } = calculateItemImageSize(source.width, source.height);
    let quality = 0.8;
    let blob: Blob | undefined;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('当前浏览器无法处理图片');
      context.clearRect(0, 0, width, height);
      source.draw(context, width, height);
      blob = await canvasBlob(canvas, quality);
      if (blob.size <= ITEM_IMAGE_TARGET_BYTES || (quality <= 0.58 && Math.max(width, height) <= 900)) break;
      if (quality > 0.62) quality -= 0.06;
      else {
        width = Math.max(1, Math.round(width * 0.85));
        height = Math.max(1, Math.round(height * 0.85));
      }
    }
    if (!blob) throw new Error('图片压缩失败');
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'item';
    return new File([blob], `${baseName}.webp`, { type: 'image/webp', lastModified: Date.now() });
  } finally {
    source.close();
  }
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
