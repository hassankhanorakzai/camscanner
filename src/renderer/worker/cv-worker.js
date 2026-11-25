/* global cv, importScripts */
/**
 * Image processing worker (OpenCV.js / WebAssembly):
 *  - detect: find the document's four corners
 *  - process: perspective-correct, rotate, filter and encode a page
 * The output keeps the document's real proportions — nothing is padded or
 * stretched to a paper size.
 */
importScripts('../vendor/opencv.js'); // resolved relative to this worker (desktop app and phone app)

const ready = (async () => {
  let c = self.cv;
  if (c && !c.Mat && typeof c.then === 'function') {
    c = await new Promise((resolve) => { c.then((m) => { delete m.then; resolve(m); }); });
  } else if (c && !c.Mat) {
    await new Promise((resolve) => { c.onRuntimeInitialized = resolve; });
  }
  self.cv = c;
  return c;
})();

// ---------- helpers ----------
function bitmapToMat(bitmap, maxDim = Infinity) {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { mat: cv.matFromImageData(data), scale };
}

function matToCanvas(mat) {
  let rgba = mat;
  if (mat.type() !== cv.CV_8UC4) {
    rgba = new cv.Mat();
    cv.cvtColor(mat, rgba, mat.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
  }
  const canvas = new OffscreenCanvas(rgba.cols, rgba.rows);
  const img = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  canvas.getContext('2d').putImageData(img, 0, 0);
  if (rgba !== mat) rgba.delete();
  return canvas;
}

function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]); // tl, tr, br, bl
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const [x1, y1] = q[i]; const [x2, y2] = q[(i + 1) % q.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------- detection ----------
/** Largest-area quadrilateral whose corners are points of a convex hull (hull points in order). */
function maxAreaQuad(pts) {
  const n = pts.length;
  if (n < 4) return null;
  let best = null; let bestA = 0;
  const area4 = (a, b, c, d) => polyArea([a, b, c, d]);
  for (let i = 0; i < n - 3; i++) for (let j = i + 1; j < n - 2; j++) for (let k = j + 1; k < n - 1; k++) for (let l = k + 1; l < n; l++) {
    const a = area4(pts[i], pts[j], pts[k], pts[l]);
    if (a > bestA) { bestA = a; best = [pts[i], pts[j], pts[k], pts[l]]; }
  }
  return best;
}

function matPoints(m) { const out = []; for (let k = 0; k < m.rows; k++) out.push([m.data32S[k * 2], m.data32S[k * 2 + 1]]); return out; }

/** Fraction of each side of the quad that lies on detected edges (returns {mean, min}). */
function edgeSupport(q, edgeMap) {
  const W = edgeMap.cols; const H = edgeMap.rows; const d = edgeMap.data;
  const per = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s]; const b = q[(s + 1) % 4];
    const len = dist(a, b); const n = Math.max(8, Math.round(len / 2));
    let hit = 0; let tot = 0;
    for (let i = 1; i < n; i++) {
      const t = i / n; const x = Math.round(a[0] + (b[0] - a[0]) * t); const y = Math.round(a[1] + (b[1] - a[1]) * t);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue; // sides on the frame border can't show an edge
      tot++; if (d[y * W + x]) hit++;
    }
    per.push(tot < n * 0.3 ? 0.5 : hit / tot);
  }
  return { mean: per.reduce((s, v) => s + v, 0) / 4, min: Math.min(...per) };
}

function quadsFromBinary(bin, W, H, out) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const minArea = W * H * 0.06;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    if (cv.contourArea(c) < minArea) { c.delete(); continue; }
    const hull = new cv.Mat();
    cv.convexHull(c, hull, false, true);
    const peri = cv.arcLength(hull, true);
    const cand = [];
    const approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, 0.004 * peri, true);
    let pts = matPoints(approx);
    if (pts.length > 40) { cv.approxPolyDP(hull, approx, 0.012 * peri, true); pts = matPoints(approx); }
    const mq = maxAreaQuad(pts);
    if (mq) cand.push(mq);
    for (const eps of [0.02, 0.04]) {
      cv.approxPolyDP(hull, approx, eps * peri, true);
      if (approx.rows === 4) cand.push(matPoints(approx));
    }
    approx.delete();
    for (const found of cand) {
      const q = orderQuad(found);
      const nearFrame = q.every(([x, y]) => (x < 3 || x > W - 4) && (y < 3 || y > H - 4));
      const sides = [dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])];
      if (!nearFrame && Math.min(...sides) > Math.min(W, H) * 0.1) out.push({ quad: q });
    }
    hull.delete(); c.delete();
  }
  contours.delete(); hier.delete();
}

function detect(bitmap) {
  const { mat: src, scale } = bitmapToMat(bitmap, 640);
  const W = src.cols; const H = src.rows;
  const rgb = new cv.Mat(); const gray = new cv.Mat(); const blur = new cv.Mat(); const edges = new cv.Mat(); const th = new cv.Mat();
  const support = new cv.Mat(); const chans = new cv.MatVector(); const tmp = new cv.Mat();
  const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const k7 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  const cands = [];
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    // colour-aware edge map: edges of gray + every colour channel (a blue card on a red desk has no grey edge)
    const blurred = new cv.Mat(); cv.GaussianBlur(rgb, blurred, new cv.Size(5, 5), 0);
    cv.split(blurred, chans); blurred.delete();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const edgeAt = (lo, hi) => {
      cv.Canny(blur, edges, lo, hi);
      for (let i = 0; i < 3; i++) { cv.Canny(chans.get(i), tmp, lo * 1.3, hi * 1.3); cv.bitwise_or(edges, tmp, edges); }
    };
    // strict edge map used to score candidates
    edgeAt(40, 120);
    cv.dilate(edges, support, k3, new cv.Point(-1, -1), 2);
    for (const [lo, hi] of [[25, 75], [40, 120], [70, 200]]) {
      edgeAt(lo, hi);
      cv.dilate(edges, edges, k3, new cv.Point(-1, -1), 1);
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k7);
      quadsFromBinary(edges, W, H, cands);
    }
    // brightness and saturation segmentation (paper is usually brighter / less colourful than the table)
    cv.threshold(blur, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(th, th, cv.MORPH_OPEN, k7); cv.morphologyEx(th, th, cv.MORPH_CLOSE, k7);
    quadsFromBinary(th, W, H, cands);
    const hsv = new cv.Mat(); const hs = new cv.MatVector();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV); cv.split(hsv, hs);
    const sat = hs.get(1);
    cv.GaussianBlur(sat, sat, new cv.Size(7, 7), 0);
    cv.threshold(sat, th, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    cv.morphologyEx(th, th, cv.MORPH_OPEN, k7); cv.morphologyEx(th, th, cv.MORPH_CLOSE, k7);
    quadsFromBinary(th, W, H, cands);
    sat.delete(); hs.delete(); hsv.delete();
  } finally {
    src.delete(); rgb.delete(); gray.delete(); blur.delete(); edges.delete(); th.delete(); chans.delete(); tmp.delete(); k3.delete(); k7.delete();
  }
  // score: how well every side sits on a real edge, then size
  let best = null;
  for (const c of cands) {
    const s = edgeSupport(c.quad, support);
    if (s.min < 0.35) continue;
    const areaFrac = polyArea(c.quad) / (W * H);
    c.score = s.mean * s.mean * (0.6 + 0.4 * s.min) * Math.sqrt(areaFrac);
    c.support = s;
    if (!best || c.score > best.score) best = c;
  }
  support.delete();
  if (!best) return null;
  const conf = Math.min(1, best.support.mean * (0.5 + best.support.min / 2) * 1.1);
  return { quad: best.quad.map(([x, y]) => [Math.min(1, Math.max(0, x / scale / bitmap.width)), Math.min(1, Math.max(0, y / scale / bitmap.height))]), confidence: conf };
}

// ---------- true aspect ratio (Zhang & He, "Whiteboard scanning", 2007) ----------
function trueAspect(q, w, h) {
  const [tl, tr, br, bl] = q;
  const u0 = w / 2; const v0 = h / 2;
  const m1 = [tl[0], tl[1], 1]; const m2 = [tr[0], tr[1], 1]; const m3 = [bl[0], bl[1], 1]; const m4 = [br[0], br[1], 1];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const naive = Math.max(dist(tl, tr), dist(bl, br)) / Math.max(dist(tl, bl), dist(tr, br));
  let ratio;
  const denom = n2[2] * n3[2];
  if (Math.abs(denom) < 1e-9) {
    ratio = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / (n3[0] ** 2 + n3[1] ** 2));
  } else {
    const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0)
      + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / denom;
    if (!(f2 > 0)) return naive;
    const quad = (n) => (n[0] * n[0] + n[1] * n[1]) / f2 - 2 * (n[0] * u0 + n[1] * v0) * n[2] / f2 + n[2] * n[2] * ((u0 * u0 + v0 * v0) / f2 + 1);
    ratio = Math.sqrt(quad(n2) / quad(n3));
  }
  if (!Number.isFinite(ratio) || ratio < 0.05 || ratio > 20 || Math.abs(Math.log(ratio / naive)) > 0.45) return naive;
  return ratio;
}

// ---------- filters ----------
function normaliseIllumination(ch) {
  // estimate the paper background at low resolution, then divide it out (removes shadows/vignetting)
  const small = new cv.Mat(); const bg = new cv.Mat(); const big = new cv.Mat(); const out = new cv.Mat();
  const s = Math.min(1, 700 / Math.max(ch.cols, ch.rows));
  cv.resize(ch, small, new cv.Size(Math.max(8, Math.round(ch.cols * s)), Math.max(8, Math.round(ch.rows * s))), 0, 0, cv.INTER_AREA);
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
  cv.dilate(small, bg, k);
  cv.medianBlur(bg, bg, 21);
  cv.resize(bg, big, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
  cv.divide(ch, big, out, 255);
  small.delete(); bg.delete(); big.delete(); k.delete();
  return out;
}

/**
 * "Magic colour": removes shadows / uneven lighting like a scanner would, but
 * keeps coloured areas (card headers, stamps, photos). A shadow darkens paper
 * without adding colour, so the correction is reduced where the local
 * background is saturated.
 */
function enhanceColour(rgb) {
  const W = rgb.cols; const H = rgb.rows; const n = W * H;
  const s = Math.min(1, 220 / Math.max(W, H));
  const sw = Math.max(8, Math.round(W * s)); const sh = Math.max(8, Math.round(H * s));
  const small = new cv.Mat(); cv.resize(rgb, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const g = new cv.Mat(); cv.cvtColor(small, g, cv.COLOR_RGB2GRAY);
  const hsv = new cv.Mat(); cv.cvtColor(small, hsv, cv.COLOR_RGB2HSV);
  const ch = new cv.MatVector(); cv.split(hsv, ch); const sat = ch.get(1);
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
  cv.dilate(g, g, k); cv.medianBlur(g, g, 9); cv.GaussianBlur(g, g, new cv.Size(7, 7), 0);
  cv.medianBlur(sat, sat, 9); cv.GaussianBlur(sat, sat, new cv.Size(7, 7), 0);
  // paper white = bright end of the background estimate
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++;
  let paper = 255; let acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > g.data.length * 0.05) { paper = Math.max(v, 120); break; } }
  const gainSmall = new cv.Mat(sh, sw, cv.CV_32F);
  for (let i = 0; i < g.data.length; i++) {
    const raw = Math.min(2.6, Math.max(1, paper / Math.max(1, g.data[i])));
    const colourful = Math.min(1, Math.max(0, (sat.data[i] - 45) / 70));
    gainSmall.data32F[i] = 1 + (raw - 1) * (1 - colourful);
  }
  const gain = new cv.Mat(); cv.resize(gainSmall, gain, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  const gd = gain.data32F;
  const out = rgb.clone(); const d = out.data;
  // contrast stretch on corrected luminance (sampled percentiles), mild saturation boost
  const h2 = new Uint32Array(256); let cnt = 0;
  for (let i = 0, j = 0; i < n; i += 5, j += 15) { const v = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * gd[i]; h2[v > 255 ? 255 : v | 0]++; cnt++; }
  let lo = 0; let hi = 255; acc = 0;
  for (let v = 0; v < 256; v++) { acc += h2[v]; if (acc > cnt * 0.005) { lo = Math.min(v, 60); break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += h2[v]; if (acc > cnt * 0.03) { hi = Math.max(v, 150); break; } }
  const a = 255 / Math.max(40, hi - lo); const satBoost = 1.15;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const gn = gd[i];
    let r = (d[j] * gn - lo) * a; let gg = (d[j + 1] * gn - lo) * a; let b = (d[j + 2] * gn - lo) * a;
    const l = 0.299 * r + 0.587 * gg + 0.114 * b;
    r = l + (r - l) * satBoost; gg = l + (gg - l) * satBoost; b = l + (b - l) * satBoost;
    d[j] = r < 0 ? 0 : r > 255 ? 255 : r; d[j + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg; d[j + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  small.delete(); g.delete(); hsv.delete(); ch.delete(); sat.delete(); k.delete(); gainSmall.delete(); gain.delete();
  return out;
}

function perChannel(rgb, fn) {
  const chans = new cv.MatVector(); cv.split(rgb, chans);
  const outV = new cv.MatVector();
  const made = [];
  for (let i = 0; i < 3; i++) { const c = chans.get(i); const o = fn(c); outV.push_back(o); made.push(c, o); }
  const out = new cv.Mat(); cv.merge(outV, out);
  made.forEach((m) => m.delete()); chans.delete(); outV.delete();
  return out;
}

function applyFilter(rgb, p) {
  const filter = p.filter || 'original';
  let out;
  if (filter === 'gray' || filter === 'bw') {
    const gray = new cv.Mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    if (filter === 'bw') {
      const norm = normaliseIllumination(gray);
      const bw = new cv.Mat();
      let block = Math.round(Math.min(gray.cols, gray.rows) / 45); block = Math.max(15, block | 1);
      cv.adaptiveThreshold(norm, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 14);
      cv.medianBlur(bw, bw, 3);
      norm.delete(); gray.delete();
      out = bw;
    } else if (p.shadow) {
      out = normaliseIllumination(gray); gray.delete();
    } else out = gray;
  } else if (filter === 'enhance') {
    out = enhanceColour(rgb);
  } else if (filter === 'lighten') {
    out = rgb.clone(); out.convertTo(out, -1, 1.05, 28);
  } else {
    out = p.shadow ? perChannel(rgb, (c) => normaliseIllumination(c)) : rgb.clone();
  }
  // brightness / contrast around mid-grey
  const b = Number(p.brightness) || 0; const c = Number(p.contrast) || 0;
  if ((b || c) && filter !== 'bw') {
    const alpha = c >= 0 ? 1 + c / 60 : 1 + c / 120;
    out.convertTo(out, -1, alpha, b * 1.2 + 128 * (1 - alpha));
  }
  const sharp = Number(p.sharpen) || 0;
  if (sharp > 0 && filter !== 'bw') {
    const blur = new cv.Mat();
    const sigma = 1 + Math.min(out.cols, out.rows) / 1500;
    cv.GaussianBlur(out, blur, new cv.Size(0, 0), sigma);
    const amt = sharp / 50; // 0..2
    cv.addWeighted(out, 1 + amt, blur, -amt, 0, out);
    blur.delete();
  }
  return out;
}

function rotate(mat, deg) {
  const d = ((Number(deg) || 0) % 360 + 360) % 360;
  if (!d) return mat;
  const out = new cv.Mat();
  const code = d === 90 ? cv.ROTATE_90_CLOCKWISE : d === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
  cv.rotate(mat, out, code);
  mat.delete();
  return out;
}

const isFullFrame = (q) => !q || q.every(([x, y], i) => Math.abs(x - [0, 1, 1, 0][i]) < 0.002 && Math.abs(y - [0, 0, 1, 1][i]) < 0.002);

async function processImage(bitmap, p, { maxDim = 5200, format = 'jpeg', quality = 0.92 } = {}) {
  const { mat: src } = bitmapToMat(bitmap, maxDim);
  const W = src.cols; const H = src.rows;
  let rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB); src.delete();
  const quad = p.quad && p.quad.length === 4 ? p.quad.map(([x, y]) => [x * W, y * H]) : null;
  if (quad && !isFullFrame(p.quad)) {
    const [tl, tr, br, bl] = quad;
    const ratio = trueAspect(quad, W, H); // width / height of the real document
    const naiveW = Math.max(dist(tl, tr), dist(bl, br));
    const naiveH = Math.max(dist(tl, bl), dist(tr, br));
    // keep the larger measured side, derive the other from the true ratio
    let ow; let oh;
    if (naiveW >= naiveH) { ow = naiveW; oh = naiveW / ratio; } else { oh = naiveH; ow = naiveH * ratio; }
    ow = Math.max(16, Math.round(ow)); oh = Math.max(16, Math.round(oh));
    const s = Math.min(1, maxDim / Math.max(ow, oh)); ow = Math.round(ow * s); oh = Math.round(oh * s);
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl[0], tl[1], tr[0], tr[1], br[0], br[1], bl[0], bl[1]]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, ow - 1, 0, ow - 1, oh - 1, 0, oh - 1]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const warped = new cv.Mat();
    cv.warpPerspective(rgb, warped, M, new cv.Size(ow, oh), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    srcTri.delete(); dstTri.delete(); M.delete(); rgb.delete();
    // trim a hair-line border so no background sliver from the detected edge remains
    const inset = Math.max(1, Math.round(Math.min(ow, oh) * 0.004));
    rgb = warped.roi(new cv.Rect(inset, inset, ow - inset * 2, oh - inset * 2)).clone();
    warped.delete();
  }
  rgb = rotate(rgb, p.rotation);
  const out = applyFilter(rgb, p);
  rgb.delete();
  const canvas = matToCanvas(out);
  const width = out.cols; const height = out.rows;
  out.delete();
  const blob = await canvas.convertToBlob({ type: format === 'png' ? 'image/png' : 'image/jpeg', quality });
  return { buffer: await blob.arrayBuffer(), width, height };
}

self.onmessage = async (e) => {
  const { id, type, bitmap, params, options } = e.data;
  try {
    await ready;
    let result;
    if (type === 'ping') result = { version: cv.getBuildInformation ? 'ok' : 'ok' };
    else if (type === 'detect') result = detect(bitmap);
    else if (type === 'process') {
      result = await processImage(bitmap, params || {}, options || {});
      bitmap.close?.();
      self.postMessage({ id, ok: true, result }, [result.buffer]);
      return;
    } else throw new Error(`Unknown task ${type}`);
    bitmap?.close?.();
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
