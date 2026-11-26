'use strict';

const IMAGEKIT_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
const IMAGEKIT_API_URL = 'https://api.imagekit.io/v1/files';

function privateKey() {
  const key = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!key) throw new Error('IMAGEKIT_PRIVATE_KEY is not configured');
  return key;
}

function authHeader() {
  return `Basic ${Buffer.from(`${privateKey()}:`).toString('base64')}`;
}

async function responseJson(response, action) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.help || `ImageKit ${action} failed (HTTP ${response.status})`);
  return payload;
}

async function uploadReferenceImage({ image, mimeType, sourceId }) {
  if (!Buffer.isBuffer(image) || image.length === 0) throw new Error('Reference image is empty');
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[mimeType];
  if (!extension) throw new Error('Reference image must be JPEG, PNG, or WebP');
  const form = new FormData();
  form.append('file', new Blob([image], { type: mimeType }), `reference-${sourceId}.${extension}`);
  form.append('fileName', `reference-${sourceId}.${extension}`);
  form.append('folder', '/youtubeascanner/reference-images');
  form.append('useUniqueFileName', 'true');
  const response = await fetch(IMAGEKIT_UPLOAD_URL, { method: 'POST', headers: { Authorization: authHeader() }, body: form });
  const uploaded = await responseJson(response, 'reference image upload');
  if (!uploaded.fileId || !uploaded.url) throw new Error('ImageKit upload response did not include fileId and url');
  return { fileId: uploaded.fileId, url: uploaded.url, mimeType: uploaded.fileType === 'image' && uploaded.mime ? uploaded.mime : mimeType };
}

async function deleteFile(fileId) {
  if (!fileId) return;
  const response = await fetch(`${IMAGEKIT_API_URL}/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers: { Authorization: authHeader() } });
  if (response.status === 404) return;
  await responseJson(response, 'reference image deletion');
}

async function downloadReferenceImage(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'ik.imagekit.io') throw new Error('Saved reference URL is not a trusted ImageKit URL');
  const response = await fetch(parsed, { redirect: 'error' });
  if (!response.ok) throw new Error(`ImageKit reference download failed (HTTP ${response.status})`);
  const mimeType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error(`ImageKit returned unsupported reference format: ${mimeType || 'unknown'}`);
  const image = Buffer.from(await response.arrayBuffer());
  if (!image.length || image.length > 8 * 1024 * 1024) throw new Error('ImageKit returned an empty or oversized reference image');
  return { image, mimeType };
}

module.exports = { uploadReferenceImage, deleteFile, downloadReferenceImage };
