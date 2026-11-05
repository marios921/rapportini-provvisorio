/*
 * Crea Guida_Impostazione_Drive.pdf da guida-drive.html, con lo stesso stile del manuale.
 * Uso: node docs/manuale/crea-guida.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const stile = fs.readFileSync(path.join(__dirname, 'manuale.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
const html = fs.readFileSync(path.join(__dirname, 'guida-drive.html'), 'utf8').replace('{{STILE}}', stile);
const piede = `<div style="width:100%;font:8px Helvetica,Arial,sans-serif;color:#5A6770;padding:0 18mm;display:flex;justify-content:space-between"><span>Rapportini di produzione — Impostazione sul Drive aziendale</span><span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span></div>`;
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({ path: path.join(__dirname, '..', 'Guida_Impostazione_Drive.pdf'), format: 'A4', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: piede });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
