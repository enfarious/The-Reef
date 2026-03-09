'use strict';

const { desktopCapturer, nativeImage } = require('electron');
const fs   = require('fs');
const path = require('path');

// ─── Vision capabilities ─────────────────────────────────────────────────────
// Screenshot capture and image file reading for multi-modal LLM consumption.
// Results carry a `__vision` flag so the renderer can inject them as proper
// image content blocks (Anthropic) or image_url messages (OpenAI-compatible).

const MIME_MAP = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
};

// ── Screenshot ────────────────────────────────────────────────────────────────
// Captures the primary (or specified) display using Electron's desktopCapturer.
// Returns JPEG by default — typically 5–10× smaller than PNG for screenshots.

async function screenshot({ display = 0, maxWidth = 1920, quality = 80 } = {}) {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxWidth, height: Math.round(maxWidth * 9 / 16) },
  });

  const source = sources[display] || sources[0];
  if (!source) throw new Error('No display available for screenshot.');

  const img  = source.thumbnail;
  const size = img.getSize();
  const q    = Math.min(100, Math.max(10, Number(quality) || 80));
  const buf  = img.toJPEG(q);

  return {
    __vision:    true,
    base64:      buf.toString('base64'),
    mimeType:    'image/jpeg',
    width:       size.width,
    height:      size.height,
    description: `Screenshot captured (${size.width}\u00d7${size.height})`,
  };
}

// ── Read image file ───────────────────────────────────────────────────────────

async function readImage({ path: filePath } = {}) {
  if (!filePath) throw new Error('path is required.');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME_MAP[ext];
  if (!mimeType) throw new Error(`Unsupported image format: ${ext}. Use PNG, JPG, GIF, WebP, or BMP.`);

  const data   = fs.readFileSync(filePath);
  const base64 = data.toString('base64');

  let width = 0, height = 0;
  try {
    const img  = nativeImage.createFromBuffer(data);
    const size = img.getSize();
    width  = size.width;
    height = size.height;
  } catch { /* non-native formats fall through with 0×0 */ }

  return {
    __vision:    true,
    base64,
    mimeType,
    width,
    height,
    description: `Image: ${path.basename(filePath)} (${width}\u00d7${height}, ${(data.length / 1024).toFixed(0)} KB)`,
  };
}

module.exports = { screenshot, readImage };
