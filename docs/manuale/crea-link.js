/* Crea Link_Rapportini.pdf da link-cliente.html. Uso: node docs/manuale/crea-link.js */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const stile = fs.readFileSync(path.join(__dirname, 'manuale.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
const html = fs.readFileSync(path.join(__dirname, 'link-cliente.html'), 'utf8').replace('{{STILE}}', stile);
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({ path: path.join(__dirname, '..', 'Link_Rapportini.pdf'), format: 'A4', preferCSSPageSize: true, printBackground: true });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
