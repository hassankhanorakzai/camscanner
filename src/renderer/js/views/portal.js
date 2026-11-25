import { h, icon, fmt, toast, modal, confirmDialog, promptDialog, withBusy } from '../ui.js';
import { api, onEvent, state } from '../core.js';

export default async function portalView(view) {
  const wrap = h('div');
  view.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Phone & Web'),
    h('div', { class: 'sub' }, 'Use your phones from anywhere: scan into this PC, browse and download documents — through your own web portal, end-to-end encrypted.'))), wrap);
  let st = await api('portal:status');

  function draw() {
    wrap.innerHTML = '';
    if (!st.linked) { wrap.append(connectCard()); return; }
    const chip = { synced: ['synced', 'Connected'], syncing: ['syncing', 'Syncing…'], offline: ['offline', 'No internet'], error: ['attention', 'Problem'], off: ['', 'Starting…'] }[st.status] || ['', st.status];
    const statusCard = h('div', { class: 'card pad' },
      h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Portal connection'), h('div', { class: 'spacer' }), h('span', { class: `sync-chip ${chip[0]}` }, h('span', { class: 'dot' }), chip[1])),
      st.error ? h('div', { class: 'banner err', style: { marginTop: '12px' } }, icon('alert'), st.error) : null,
      h('div', { class: 'kv', style: { marginTop: '12px' } },
        h('div', { class: 'k' }, 'Portal'), h('div', { class: 'v' }, st.url),
        h('div', { class: 'k' }, 'This PC is named'), h('div', { class: 'v' }, st.label || '—', ' ', h('a', { href: '#', onclick: async (e) => { e.preventDefault(); const n = await promptDialog('Office / PC name', 'Name shown on phones', st.label || ''); if (n) { await api('portal:rename', n); st = await api('portal:syncNow').catch(() => st); draw(); } } }, 'rename')),
        h('div', { class: 'k' }, 'Last sync'), h('div', { class: 'v' }, st.lastSync ? fmt.datetime(st.lastSync) : '—'),
        h('div', { class: 'k' }, 'Encryption'), h('div', { class: 'v' }, '🔒 End-to-end (AES-256). Your hosting stores only encrypted data.')),
      h('div', { class: 'row wrap', style: { marginTop: '14px' } },
        h('button', { class: 'btn primary', id: 'pairPhone', onclick: pairDialog }, icon('phone'), 'Connect a phone'),
        h('button', { class: 'btn', onclick: (e) => withBusy(e.currentTarget, async () => { try { st = await api('portal:syncNow'); toast('Synced with portal', 'success'); } catch (x) { toast(x.message, 'error'); st = await api('portal:status'); } draw(); }) }, icon('refresh'), 'Sync now')),
      h('p', { class: 'muted small' }, 'Keep SmartScan running on this PC: phones send scans and requests to the portal, and this PC picks them up within seconds (every 20 s when no phone is active).'));

    const devs = h('div', { class: 'card pad' }, h('h3', {}, `Paired phones (${st.devices.length})`),
      st.devices.length ? h('div', { class: 'list' }, st.devices.map((d) => h('div', { class: 'list-item', style: { padding: '8px 2px' } }, icon('phone'),
        h('div', { class: 'grow' }, h('b', {}, d.label), h('div', { class: 'muted small' }, `Paired ${fmt.date(d.created_at)} · last active ${fmt.rel(d.last_seen)}`)),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!(await confirmDialog(`Remove “${d.label}”?`, 'The phone will no longer reach this library. If the phone was lost or stolen, also use “Renew encryption key”.', { okLabel: 'Remove', danger: true }))) return;
          await api('portal:revoke', d.id); toast('Phone removed', 'success'); st = await api('portal:syncNow').catch(() => api('portal:status')); draw();
        } }, 'Remove')))) : h('div', { class: 'muted' }, 'No phones yet. Click “Connect a phone”.'),
      h('div', { class: 'row wrap', style: { marginTop: '14px' } },
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmDialog('Renew encryption key?', 'All phones are removed and must be paired again. Use this if a phone was lost.', { okLabel: 'Renew key', danger: true }))) return;
          st = await api('portal:resetKey'); toast('Key renewed — pair your phones again', 'success'); draw();
        } }, icon('shield'), 'Renew encryption key'),
        h('button', { class: 'btn', onclick: async () => {
          if (!(await confirmDialog('Disconnect from portal?', 'Phones stop working with this PC. Your documents on this PC are not affected.', { okLabel: 'Disconnect', danger: true }))) return;
          st = await api('portal:disconnect'); draw();
        } }, 'Disconnect')));

    const log = h('div', { class: 'card pad' }, h('h3', {}, 'Activity from phones'),
      st.activity.length ? h('div', { class: 'list' }, st.activity.slice(0, 15).map((a) => h('div', { class: 'list-item', style: { padding: '6px 2px' } }, h('div', { class: 'grow small' }, a.msg), h('span', { class: 'muted small nowrap' }, fmt.rel(a.at))))) : h('div', { class: 'muted small' }, 'Nothing yet.'));
    wrap.append(h('div', { class: 'settings-grid' }, h('div', { class: 'col', style: { gap: '16px' } }, statusCard, devs), h('div', { class: 'col', style: { gap: '16px' } }, howCard(), log)));
  }

  function connectCard() {
    const url = h('input', { class: 'input', placeholder: 'https://scan.your-domain.com', id: 'portalUrl' });
    const key = h('input', { class: 'input', placeholder: 'XXXX-XXXX-XXXX-XXXX', id: 'portalKey', style: { textTransform: 'uppercase' } });
    const label = h('input', { class: 'input', value: `${state.user.displayName} – Office`, maxlength: 120 });
    const go = h('button', { class: 'btn primary lg', id: 'portalConnect' }, icon('wifi'), 'Connect');
    go.addEventListener('click', () => withBusy(go, async () => {
      try { st = await api('portal:connect', { url: url.value, setupKey: key.value, label: label.value }); toast('Connected to your portal', 'success'); draw(); } catch (e) { toast(e.message, 'error', 7000); }
    }));
    return h('div', { class: 'settings-grid' },
      h('div', { class: 'card pad col' }, h('h3', {}, 'Connect this PC to your web portal'),
        h('label', { class: 'field' }, 'Portal address', url, h('span', { class: 'hint' }, 'The address where you uploaded the SmartScan portal on your hosting.')),
        h('label', { class: 'field' }, 'Office setup key', key, h('span', { class: 'hint' }, 'Shown once by the portal installer. The same key connects every office PC.')),
        h('label', { class: 'field' }, 'Name for this PC / office', label),
        go),
      howCard());
  }

  function howCard() {
    return h('div', { class: 'card pad' }, h('h3', {}, 'How it works'),
      h('ol', { class: 'small', style: { paddingLeft: '18px', margin: 0, lineHeight: 1.7 } },
        h('li', {}, 'Upload the ', h('b', {}, 'portal'), ' folder to your cPanel/hPanel hosting and open ', h('code', {}, 'install.php'), ' once.'),
        h('li', {}, 'Connect each office PC here with the portal address and setup key.'),
        h('li', {}, 'Click ', h('b', {}, 'Connect a phone'), ' and scan the QR code with the phone camera. No app install — add it to the home screen.'),
        h('li', {}, 'From anywhere, the phone can scan (auto-crop) straight into this PC, browse people & documents, download/share PDFs and keep documents offline.')),
      h('p', { class: 'muted small' }, 'This PC stays the master copy: files are saved on your drive. The portal only relays encrypted data and deletes delivered files.'));
  }

  async function pairDialog() {
    let r;
    try { r = await api('portal:pairing'); } catch (e) { toast(e.message, 'error'); return; }
    modal({ title: 'Connect a phone', body: h('div', { class: 'col', style: { alignItems: 'center', textAlign: 'center' } },
      h('img', { src: r.qr, style: { width: '260px', height: '260px' }, alt: 'QR code', id: 'pairQr' }),
      h('div', {}, 'Scan with the phone’s camera, then tap the link.'),
      h('div', { class: 'muted small' }, `Code ${r.code} · valid for 15 minutes · one phone only`),
      h('div', { class: 'banner warn small', style: { textAlign: 'left' } }, icon('shield'), 'This QR contains your library’s encryption key. Only show it to phones you trust.')),
    actions: [{ label: 'Copy link', onClick: () => { navigator.clipboard.writeText(r.link); toast('Link copied — send it only to your own phone', 'info'); return false; } }, { label: 'Done', primary: true }] });
  }

  draw();
  return onEvent('portal:state', (s) => { const prev = st.status; st = s; if (!document.querySelector('.overlay') && (prev !== s.status || true)) draw(); });
}
