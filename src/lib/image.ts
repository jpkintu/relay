// Shrinks a photo in the browser before upload: at most `size` px on the long
// side, JPEG. Returns base64 without the data: prefix (about 40-120 KB).
export async function shrinkImage(file: File, size = 800, quality = 0.8): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot resize photos');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}
