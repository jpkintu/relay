// Shrinks a photo in the browser before upload: at most `size` px on the long
// side, JPEG (or PNG, which keeps a logo's transparent background). Returns
// base64 without the data: prefix (about 40-120 KB). With `trim`, blank
// margins (transparent or near-white) are cut off first, so a logo sits
// tight against whatever follows it.
export async function shrinkImage(
  file: File,
  size = 800,
  quality = 0.8,
  type: 'image/jpeg' | 'image/png' = 'image/jpeg',
  trim = false,
): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo');
  const bitmap = await createImageBitmap(file);
  let box = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
  if (trim) box = contentBox(bitmap) || box;
  const scale = Math.min(1, size / Math.max(box.width, box.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(box.width * scale));
  canvas.height = Math.max(1, Math.round(box.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot resize photos');
  context.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL(type, quality).split(',')[1];
}

// The part of an image that is not blank margin, or null if it is all blank.
function contentBox(bitmap: ImageBitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  return findContent(data, width, height);
}

// Pure helper (tested): bounds of pixels that are neither transparent nor
// near-white, with a 2% margin so nothing touches the edge.
export function findContent(data: Uint8ClampedArray, width: number, height: number) {
  let top = height,
    left = width,
    bottom = -1,
    right = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const blank = data[i + 3] < 16 || (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240);
      if (blank) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  if (bottom < 0) return null;
  const pad = Math.round(Math.max(width, height) * 0.02);
  const x = Math.max(0, left - pad);
  const y = Math.max(0, top - pad);
  return {
    x,
    y,
    width: Math.min(width, right + pad + 1) - x,
    height: Math.min(height, bottom + pad + 1) - y,
  };
}
