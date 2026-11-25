// Page editor: adjustable crop corners with magnifier, rotation, filters and adjustments.
import { h, icon, modal, toast } from '../ui.js';
import { detect, processPreview, FULL_QUAD } from './cv.js';

export const FILTERS = [['original', 'Original'], ['enhance', 'Magic colour'], ['lighten', 'Lighten'], ['gray', 'Grayscale'], ['bw', 'B & W']];
export const defaultParams = (filter = 'enhance') => ({ quad: FULL_QUAD.map((p) => [...p]), rotation: 0, filter, brightness: 0, contrast: 0, sharpen: filter === 'original' ? 0 : 20, shadow: false });

/**
 * pages: [{ blob, params }]. Edits params in place.
 * Returns a promise resolved with true when the user clicks Done.
 */
export function openEditor(pages, startIndex = 0, { title = 'Edit page', onChange } = {}) {
  return new Promise((resolve) => {
    let index = startIndex;
    let bitmap = null;
    let dragging = -1;
    let previewTimer = null;
    let previewSeq = 0;
    let lastUrl = null;
    const cropCanvas = h('canvas', { class: 'crop' });
    const resultImg = h('img', { class: 'result', alt: '' });
    const busy = h('span', { class: 'busy hidden' }, h('span', { class: 'spinner' }));
    const counter = h('span', { class: 'muted small' });
    const tools = h('div', { class: 'ed-tools' });
    const cropPane = h('div', { class: 'ed-pane' }, h('span', { class: 'lbl' }, 'Drag the corners to crop'), cropCanvas);
    const resultPane = h('div', { class: 'ed-pane' }, h('span', { class: 'lbl' }, 'Result'), busy, resultImg);
    const body = h('div', { class: 'editor' }, cropPane, resultPane, tools);
    const m = modal({ title, size: 'full', body, onClose: () => { cleanup(); resolve(true); } });
    m.body.style.padding = '0'; m.body.style.flex = '1'; m.body.style.overflow = 'hidden';
    const pg = () => pages[index];
    const P = () => pg().params;

    function cleanup() { bitmap?.close?.(); if (lastUrl) URL.revokeObjectURL(lastUrl); window.removeEventListener('resize', layout); document.removeEventListener('keydown', onKey); }

    // ---------------- crop canvas
    let geo = { x: 0, y: 0, w: 1, h: 1, dpr: 1 };
    function layout() {
      if (!bitmap) return;
      const r = cropPane.getBoundingClientRect();
      const pad = 34;
      const scale = Math.min((r.width - pad * 2) / bitmap.width, (r.height - pad * 2) / bitmap.height);
      const w = Math.max(10, bitmap.width * scale); const hh = Math.max(10, bitmap.height * scale);
      const dpr = window.devicePixelRatio || 1;
      cropCanvas.width = Math.round((w + pad * 2) * dpr); cropCanvas.height = Math.round((hh + pad * 2) * dpr);
      cropCanvas.style.width = `${w + pad * 2}px`; cropCanvas.style.height = `${hh + pad * 2}px`;
      geo = { x: pad, y: pad, w, h: hh, dpr };
      draw();
    }
    const toCanvas = ([x, y]) => [geo.x + x * geo.w, geo.y + y * geo.h];
    function draw(loupe = null) {
      const ctx = cropCanvas.getContext('2d');
      ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
      ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
      ctx.drawImage(bitmap, geo.x, geo.y, geo.w, geo.h);
      const pts = P().quad.map(toCanvas);
      // dim outside
      ctx.save(); ctx.fillStyle = 'rgba(2,6,23,.55)'; ctx.beginPath();
      ctx.rect(geo.x, geo.y, geo.w, geo.h);
      ctx.moveTo(...pts[0]); for (const p of [pts[3], pts[2], pts[1]]) ctx.lineTo(...p); ctx.closePath();
      ctx.fill('evenodd'); ctx.restore();
      ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(...pts[0]); pts.slice(1).forEach((p) => ctx.lineTo(...p)); ctx.closePath(); ctx.stroke();
      // edge midpoints
      for (let i = 0; i < 4; i++) {
        const a = pts[i]; const b = pts[(i + 1) % 4];
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      pts.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p[0], p[1], dragging === i ? 13 : 11, 0, Math.PI * 2);
        ctx.fillStyle = dragging === i ? '#3b82f6' : 'rgba(255,255,255,.95)'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#3b82f6'; ctx.stroke();
      });
      if (loupe) {
        const [cx, cy] = loupe; const R = 62; const zoom = 2.6;
        const lx = cx < cropCanvas.width / geo.dpr / 2 ? cx + 90 : cx - 90; const ly = Math.max(R + 4, cy - 90);
        const sx = ((cx - geo.x) / geo.w) * bitmap.width; const sy = ((cy - geo.y) / geo.h) * bitmap.height;
        const srcR = (R / zoom) * (bitmap.width / geo.w);
        ctx.save(); ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = '#000'; ctx.fillRect(lx - R, ly - R, R * 2, R * 2);
        ctx.drawImage(bitmap, sx - srcR, sy - srcR, srcR * 2, srcR * 2, lx - R, ly - R, R * 2, R * 2);
        ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(lx - 10, ly); ctx.lineTo(lx + 10, ly); ctx.moveTo(lx, ly - 10); ctx.lineTo(lx, ly + 10); ctx.stroke();
        ctx.restore(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.stroke();
      }
    }
    const eventPos = (e) => { const r = cropCanvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    let dragStart = null;
    cropCanvas.addEventListener('pointerdown', (e) => {
      const [x, y] = eventPos(e);
      const pts = P().quad.map(toCanvas);
      let best = -1; let bd = 22;
      pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
      if (best < 0) {
        for (let i = 0; i < 4; i++) {
          const a = pts[i]; const b = pts[(i + 1) % 4];
          if (Math.hypot((a[0] + b[0]) / 2 - x, (a[1] + b[1]) / 2 - y) < 16) { best = 10 + i; break; }
        }
      }
      if (best < 0) return;
      dragging = best; dragStart = { x, y, quad: P().quad.map((p) => [...p]) };
      cropCanvas.setPointerCapture(e.pointerId);
      draw(best < 10 ? pts[best] : null);
    });
    cropCanvas.addEventListener('pointermove', (e) => {
      if (dragging < 0) return;
      const [x, y] = eventPos(e);
      const clamp = (v) => Math.min(1, Math.max(0, v));
      if (dragging < 10) {
        P().quad[dragging] = [clamp((x - geo.x) / geo.w), clamp((y - geo.y) / geo.h)];
        draw(toCanvas(P().quad[dragging]));
      } else {
        const i = dragging - 10; const j = (i + 1) % 4;
        const dx = (x - dragStart.x) / geo.w; const dy = (y - dragStart.y) / geo.h;
        for (const k of [i, j]) P().quad[k] = [clamp(dragStart.quad[k][0] + dx), clamp(dragStart.quad[k][1] + dy)];
        draw();
      }
    });
    const endDrag = () => { if (dragging < 0) return; dragging = -1; draw(); schedulePreview(); };
    cropCanvas.addEventListener('pointerup', endDrag);
    cropCanvas.addEventListener('pointercancel', endDrag);

    // ---------------- preview
    function schedulePreview(delay = 120) {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        const my = ++previewSeq;
        busy.classList.remove('hidden');
        try {
          const r = await processPreview(pg().blob, P(), 1000);
          if (my !== previewSeq) { URL.revokeObjectURL(r.url); return; }
          if (lastUrl) URL.revokeObjectURL(lastUrl);
          lastUrl = r.url; resultImg.src = r.url;
          onChange?.(index);
        } catch (e) { toast(`Preview failed: ${e.message}`, 'error'); } finally { if (my === previewSeq) busy.classList.add('hidden'); }
      }, delay);
    }

    // ---------------- tools
    function renderTools() {
      tools.innerHTML = '';
      const p = P();
      const slider = (key, label, min, max) => {
        const val = h('span', {}, String(p[key]));
        const r = h('input', { type: 'range', min, max, value: p[key] });
        r.addEventListener('input', () => { p[key] = Number(r.value); val.textContent = r.value; schedulePreview(180); });
        return h('div', { class: 'slider-row' }, h('span', {}, label), r, val);
      };
      const shadow = h('input', { type: 'checkbox', checked: p.shadow });
      shadow.addEventListener('change', () => { p.shadow = shadow.checked; schedulePreview(); });
      tools.append(
        h('div', { class: 'row' }, h('button', { class: 'btn icon sm', disabled: index === 0, onclick: () => go(index - 1), title: 'Previous page' }, icon('chevL')), counter, h('button', { class: 'btn icon sm', disabled: index === pages.length - 1, onclick: () => go(index + 1), title: 'Next page' }, icon('chevR')), h('div', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => m.close() }, icon('check'), 'Done')),
        h('h4', {}, 'Crop'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn sm', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { const d = await detect(pg().blob); if (d) { p.quad = d.quad; draw(); schedulePreview(); toast('Document edges detected', 'success', 1500); } else toast('No document edges found — adjust the corners manually.', 'info'); } finally { e.currentTarget.disabled = false; }
          } }, icon('wand'), 'Auto detect'),
          h('button', { class: 'btn sm', onclick: () => { p.quad = FULL_QUAD.map((q) => [...q]); draw(); schedulePreview(); } }, icon('maximize'), 'No crop')),
        h('h4', {}, 'Rotate'),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => { p.rotation = (p.rotation + 270) % 360; schedulePreview(0); } }, icon('rotL'), 'Left'),
          h('button', { class: 'btn sm', onclick: () => { p.rotation = (p.rotation + 90) % 360; schedulePreview(0); } }, icon('rotR'), 'Right')),
        h('h4', {}, 'Filter'),
        h('div', { class: 'filters' }, FILTERS.map(([v, l]) => h('button', { class: p.filter === v ? 'on' : '', onclick: () => { p.filter = v; renderTools(); schedulePreview(0); } }, l))),
        h('label', { class: 'check' }, shadow, 'Remove shadows'),
        h('h4', {}, 'Adjust'),
        slider('brightness', 'Brightness', -100, 100),
        slider('contrast', 'Contrast', -100, 100),
        slider('sharpen', 'Sharpen text', 0, 100),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn sm', onclick: () => { Object.assign(p, { brightness: 0, contrast: 0, sharpen: 0, shadow: false }); renderTools(); schedulePreview(0); } }, 'Reset'),
          pages.length > 1 ? h('button', { class: 'btn sm', onclick: () => { for (const o of pages) Object.assign(o.params, { filter: p.filter, brightness: p.brightness, contrast: p.contrast, sharpen: p.sharpen, shadow: p.shadow }); toast('Applied to all pages', 'success'); onChange?.('all'); } }, 'Apply to all pages') : null));
      counter.textContent = `Page ${index + 1} of ${pages.length}`;
    }

    async function go(i) {
      index = Math.max(0, Math.min(pages.length - 1, i));
      bitmap?.close?.();
      bitmap = await createImageBitmap(pg().blob);
      renderTools(); layout(); schedulePreview(0);
    }
    const onKey = (e) => {
      if (e.target.matches('input,select,textarea')) return;
      if (e.key === 'ArrowRight' && index < pages.length - 1) go(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) go(index - 1);
    };
    window.addEventListener('resize', layout);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => go(index));
  });
}
