/*
 * Crea Manuale_Rapportini.pdf da manuale.html (due passaggi: il secondo scrive i numeri di pagina nell'indice).
 * Uso: node docs/manuale/crea-manuale.js
 * Serve Python con pypdfium2 per leggere le pagine.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const FONTE = fs.readFileSync(path.join(__dirname, 'manuale.html'), 'utf8');
const USCITA = path.join(__dirname, '..', 'Manuale_Rapportini.pdf');
const piede = `<div style="width:100%;font:8px Helvetica,Arial,sans-serif;color:#5A6770;padding:0 18mm;display:flex;justify-content:space-between"><span>Rapportini di produzione — Manuale di istruzioni</span><span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span></div>`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const crea = async (html, dest) => {
    const tmp = path.join(__dirname, '.tmp-manuale.html');
    fs.writeFileSync(tmp, html);
    const page = await browser.newPage();
    await page.goto('file://' + tmp);
    await page.waitForLoadState('networkidle');
    await page.pdf({ path: dest, format: 'A4', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: piede });
    await page.close();
    fs.rmSync(tmp);
  };
  // Primo passaggio: ogni segno diventa un testo invisibile che si ritrova nel PDF
  const marcato = FONTE.replace(/<!--segna:(\w+)-->/g, '<span style="position:absolute;font-size:1pt;color:#fff">§§$1§§</span>')
    .replace(/\{\{pag:\w+\}\}/g, '<b>00</b>');
  const prova = path.join(os.tmpdir(), 'manuale-prova.pdf');
  await crea(marcato, prova);
  const py = `import pypdfium2,sys,json,re
d=pypdfium2.PdfDocument(sys.argv[1]);o={}
for i in range(len(d)):
    t=d[i].get_textpage().get_text_range()
    for m in re.findall(r'§§(\\w+)§§',t): o.setdefault(m,i+1)
print(json.dumps(o))`;
  const pagine = JSON.parse(execFileSync('python3', ['-c', py, prova], { encoding: 'utf8' }));
  const mancanti = [...FONTE.matchAll(/\{\{pag:(\w+)\}\}/g)].map((m) => m[1]).filter((k) => !pagine[k]);
  if (mancanti.length) throw new Error('Segni non trovati: ' + mancanti);
  // Secondo passaggio: stessi segni (per non spostare niente), indice con i numeri veri
  const finale = FONTE.replace(/<!--segna:\w+-->/g, '').replace(/\{\{pag:(\w+)\}\}/g, (_, k) => `<b>${pagine[k]}</b>`);
  await crea(finale, USCITA);
  await browser.close();
  const n = execFileSync('python3', ['-c', 'import pypdfium2,sys;print(len(pypdfium2.PdfDocument(sys.argv[1])))', USCITA], { encoding: 'utf8' }).trim();
  console.log('Pagine:', n, JSON.stringify(pagine));
})().catch((e) => { console.error(e); process.exit(1); });
