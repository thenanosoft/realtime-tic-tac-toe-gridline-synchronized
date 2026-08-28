import {
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_DIMENSION,
  MAX_CHAT_IMAGE_SOURCE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  type SupportedImageMime,
} from '../../shared/protocol';

export interface PreparedChatImage {
  mime: SupportedImageMime;
  width: number;
  height: number;
  byteLength: number;
  data: string;
}

export class ImagePreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImagePreparationError';
  }
}

export async function prepareChatImage(file: File): Promise<PreparedChatImage> {
  if (!SUPPORTED_IMAGE_MIME_TYPES.includes(file.type as SupportedImageMime)) {
    throw new ImagePreparationError('Unsupported image format. Choose a JPEG, PNG, or WebP image.');
  }
  if (!file.size || file.size > MAX_CHAT_IMAGE_SOURCE_BYTES) {
    throw new ImagePreparationError('Image is too large. Choose an image under 8 MB.');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImagePreparationError('This image could not be read safely.');
  }

  try {
    const attempts = [
      { max: MAX_CHAT_IMAGE_DIMENSION, quality: 0.84 },
      { max: 1_400, quality: 0.76 },
      { max: 1_200, quality: 0.70 },
      { max: 960, quality: 0.66 },
    ];

    for (const attempt of attempts) {
      const scale = Math.min(1, attempt.max / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) throw new ImagePreparationError('Image preparation is unavailable in this browser.');
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvasToBlob(canvas, 'image/webp', attempt.quality);
      canvas.width = 1;
      canvas.height = 1;
      if (blob.size <= MAX_CHAT_IMAGE_BYTES) {
        return {
          mime: 'image/webp',
          width,
          height,
          byteLength: blob.size,
          data: await blobToBase64(blob),
        };
      }
    }
  } finally {
    bitmap.close();
  }

  throw new ImagePreparationError('The image remains too large after compression. Choose a smaller image.');
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: SupportedImageMime, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new ImagePreparationError('The image could not be compressed.')),
      mime,
      quality,
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ImagePreparationError('The prepared image could not be encoded.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const separator = result.indexOf(',');
      if (separator < 0) reject(new ImagePreparationError('The prepared image could not be encoded.'));
      else resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}
