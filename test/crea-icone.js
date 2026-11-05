/* Crea le icone della PWA (nessun dato, solo disegno): cerchio con filo e la lettera R. */
const { chromium } = require('playwright');
const path = require('node:path');
(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  for (const s of [180, 192, 512]) {
    const p = await b.newPage({ viewport: { width: s, height: s } });
    await p.setContent(`<body style="margin:0"><div style="width:${s}px;height:${s}px;background:#0B5D6B;display:grid;place-items:center;color:#fff;font:700 ${s * 0.5}px Arial,sans-serif;position:relative">R<i style="position:absolute;left:18%;right:18%;bottom:20%;height:${s * 0.05}px;background:#F0B23A;border-radius:9px"></i></div></body>`);
    await p.screenshot({ path: path.join(__dirname, '..', 'tablet', 'icone', `icona-${s}.png`) });
  }
  await b.close();
})();
