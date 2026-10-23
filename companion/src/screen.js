// Screenshots via desktopCapturer (main process).
// First call triggers the macOS Screen-Recording permission prompt for the app.
//
// Local Edition sends every screenshot to a vision model on this PC. The model
// resizes to its own grid anyway, so a full 4K PNG only costs encode time and
// memory: frames are shrunk to opts.maxSide and sent as JPEG.
const { desktopCapturer, screen } = require('electron');

const JPEG_QUALITY = 85;

function encode(img, format) {
  if (format === 'png') return img.toDataURL();
  return 'data:image/jpeg;base64,' + img.toJPEG(JPEG_QUALITY).toString('base64');
}

function shrink(img, maxSide) {
  const size = img.getSize();
  const longest = Math.max(size.width, size.height);
  if (!maxSide || longest <= maxSide) return img;
  const f = maxSide / longest;
  return img.resize({ width: Math.round(size.width * f), height: Math.round(size.height * f), quality: 'good' });
}

async function captureScreenshot(opts = {}) {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  return encode(shrink(img, Number(opts.maxSide) || 0), opts.format);
}

// One display, downscaled for a pointing model: 1280px on the long side is
// plenty for "which control" and a fraction of the tokens of a 4K frame.
// Returns the capture plus what is needed to map normalized boxes back.
async function captureDisplay(displayId, opts = {}) {
  const maxSide = Number(opts.maxSide) || 1280;
  const displays = screen.getAllDisplays();
  const display = (displayId != null && displays.find((d) => d.id === displayId)) || screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const pxWidth = Math.floor(display.size.width * scale), pxHeight = Math.floor(display.size.height * scale);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: pxWidth, height: pxHeight } });
  if (!sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  const full = src.thumbnail;
  if (!full || full.isEmpty()) return null;
  const size = full.getSize();
  const img = shrink(full, maxSide);
  const out = img.getSize();
  return {
    dataUrl: encode(img, opts.format),
    width: out.width, height: out.height,
    pxWidth: size.width, pxHeight: size.height,
    display: { id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: scale },
  };
}

module.exports = { captureScreenshot, captureDisplay };
