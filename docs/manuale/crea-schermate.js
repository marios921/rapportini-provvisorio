/*
 * Rifà le schermate del manuale usando le app vere con i dati di esempio inventati.
 * Uso: node docs/manuale/crea-schermate.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const RADICE = path.join(__dirname, '..', '..');
const { avviaServer, avviaSitoStatico } = require(path.join(RADICE, 'test', 'finto-apps-script.js'));
const IMG = path.join(__dirname, 'immagini');
const oggi = new Date();
const alle = (h, m, d = 0) => new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() + d, h, m);

(async () => {
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-man-'));
  for (const d of ['anagrafiche', 'invii', 'ufficio']) fs.mkdirSync(path.join(drive, d));
  fs.copyFileSync(path.join(RADICE, 'esempi', 'anagrafiche.esempio.json'), path.join(drive, 'anagrafiche', 'anagrafiche.json'));
  const browser = await chromium.launch({ channel: 'chrome' });
  const sito = await avviaSitoStatico();
  const script = await avviaServer({ cartella: drive, token: 'esempio' });
  // la pausa lascia al browser il tempo di ridisegnare dopo un cambio di misura della finestra
  const foto = async (el, nome) => { await new Promise((r) => setTimeout(r, 600)); await el.screenshot({ path: path.join(IMG, nome + '.png') }); };

  /* ---------- tablet ---------- */
  const tc = await browser.newContext({ viewport: { width: 1024, height: 700 }, deviceScaleFactor: 2, locale: 'it-IT', timezoneId: 'Europe/Rome', colorScheme: 'light' });
  const p = await tc.newPage();
  await p.clock.install({ time: alle(7, 30) });
  await p.goto(`${sito.url}/tablet/`);
  await p.fill('#s-cod', 'TAB01'); await p.fill('#s-url', 'https://script.google.com/macros/s/…/exec');
  await foto(p, 'tablet-configurazione');
  await p.fill('#s-url', script.url); await p.fill('#s-tok', 'esempio');
  await p.click('#s-ok'); await p.waitForSelector('.people');
  await p.click('[data-dip="Operatore 1"]');
  await p.click('[data-k="1"]'); await p.click('[data-k="2"]');
  await p.setViewportSize({ width: 1024, height: 800 });
  await foto(p, 'tablet-pin');
  await p.click('[data-k="3"]'); await p.click('[data-k="4"]'); await p.waitForSelector('#nuova');

  const manuale = async ({ com, lav, ini, fin, min, pz, note, foglio }) => {
    await p.click('#manuale'); await p.fill('#q', com); await p.click(`[data-com="${com}"]`); await p.click(`[data-lav="${lav}"]`);
    if (ini) { await p.fill('#m-ini', ini); await p.fill('#m-fin', fin); }
    if (min) await p.fill('#m-min', String(min));
    await p.fill('#m-pz', String(pz));
    if (note) await p.fill('#m-note', note);
    if (foglio) { await p.waitForTimeout(3400); await p.setViewportSize({ width: 1024, height: 1060 }); await foto(p, foglio); await p.setViewportSize({ width: 1024, height: 700 }); }
    await p.click('#sh-salva'); await p.waitForSelector('#nuova');
    await p.waitForFunction(() => document.querySelector('#testo-stato')?.textContent === 'Tutto inviato');
  };
  await p.clock.setFixedTime(alle(10, 15));
  await manuale({ com: '1001', lav: 'Crimpatura', ini: '07:30', fin: '10:15', pz: 120 });
  await p.clock.setFixedTime(alle(13, 0));
  await manuale({ com: '5390001', lav: 'Spellatura', ini: '10:15', fin: '13:00', pz: 85, foglio: 'tablet-manuale' });

  // nuova lavorazione col cronometro
  await p.clock.setFixedTime(alle(14, 0));
  await p.click('#nuova'); await p.fill('#q', 'BETA'); await p.click('[data-com="1002"]'); await p.click('[data-lav="Collaudo"]');
  await p.waitForTimeout(3500);
  await p.setViewportSize({ width: 1024, height: 880 });
  await foto(p, 'tablet-nuova');
  await p.setViewportSize({ width: 1024, height: 700 });
  await p.click('#sh-avvia'); await p.waitForSelector('.run-card');
  await p.clock.setFixedTime(alle(15, 42));
  await p.waitForTimeout(1200);
  await p.waitForTimeout(3300); // l'avviso breve in basso sparisce prima della foto
  await foto(p, 'tablet-home');
  await p.click('[data-chiudi]'); await p.fill('#c-pz', '40');
  await p.setViewportSize({ width: 1024, height: 640 });
  await foto(p, 'tablet-chiusura');
  await p.setViewportSize({ width: 1024, height: 700 });
  await p.click('#c-salva'); await p.waitForSelector('#nuova');
  await p.waitForFunction(() => document.querySelector('#testo-stato')?.textContent === 'Tutto inviato');
  await p.click('#esci'); await p.waitForSelector('.people');

  // altri operatori: righe con i casi da controllare
  const entra = async (nome) => { await p.click(`[data-dip="${nome}"]`); for (const k of '1234') await p.click(`[data-k="${k}"]`); await p.waitForSelector('#nuova'); };
  await entra('Operatore 2');
  await p.clock.setFixedTime(alle(16, 10));
  await manuale({ com: 'OA99-0001', lav: 'Cablaggio', ini: '08:00', fin: '12:30', pz: 60 });
  await manuale({ com: '0042', lav: 'Imballo', ini: '06:00', fin: '16:45', pz: 0, note: 'manca il materiale' });
  await p.click('#esci'); await p.waitForSelector('.people');
  await entra('Operatore 3');
  await manuale({ com: '901/CL', lav: 'Assemblaggio', min: 95, pz: 30 });
  await p.click('#esci'); await p.waitForSelector('.people');

  // stato invii con righe in attesa, senza rete
  await entra('Operatore 4');
  await tc.setOffline(true);
  await p.click('#manuale'); await p.fill('#q', '902/CL'); await p.click('[data-com="902/CL"]'); await p.click('[data-lav="Taglio a misura"]');
  await p.fill('#m-min', '50'); await p.fill('#m-pz', '200'); await p.click('#sh-salva'); await p.waitForSelector('#nuova');
  await p.waitForFunction(() => document.querySelector('#testo-stato')?.textContent.includes('non riuscito'));
  await p.waitForTimeout(100);
  await p.click('#vai-stato');
  await p.waitForTimeout(3300);
  await foto(p, 'tablet-stato');
  await p.click('#stato-x');
  await tc.setOffline(false);
  await p.click('#invia');
  await p.waitForFunction(() => document.querySelector('#testo-stato')?.textContent === 'Tutto inviato');

  // lavorazione rimasta aperta da ieri
  await p.clock.setFixedTime(alle(16, 50, -1));
  await p.reload(); await entra('Operatore 4');
  await p.click('#nuova'); await p.fill('#q', '1001'); await p.click('[data-com="1001"]'); await p.click('[data-lav="Chiusura"]'); await p.click('#sh-avvia');
  await p.waitForSelector('.run-card');
  await p.clock.setFixedTime(alle(7, 35));
  await p.click('#esci'); await p.waitForSelector('.people');
  await p.setViewportSize({ width: 1024, height: 420 });
  await p.waitForTimeout(3300);
  await foto(p, 'tablet-da-chiudere');
  await p.setViewportSize({ width: 1024, height: 700 });
  await entra('Operatore 4');
  await p.locator('.run-card').screenshot({ path: path.join(IMG, 'tablet-aperta-ieri.png') });

  /* ---------- ufficio ---------- */
  const uc = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: 'it-IT', timezoneId: 'Europe/Rome', colorScheme: 'light', acceptDownloads: true });
  await uc.addInitScript(() => {
    window.showSaveFilePicker = undefined;
    window.showDirectoryPicker = async () => { const r = await navigator.storage.getDirectory(); return r.getDirectoryHandle('Rapportini', { create: true }); };
  });
  const u = await uc.newPage();
  await u.goto(`${sito.url}/ufficio/`);
  await u.setViewportSize({ width: 1280, height: 380 });
  await foto(u, 'ufficio-cartella');
  await u.setViewportSize({ width: 1280, height: 800 });
  await u.click('#scegli'); await u.click('#crea'); await u.waitForSelector('#aggiorna');
  const carica = () => u.evaluate(async (dati) => {
    const r = await (await navigator.storage.getDirectory()).getDirectoryHandle('Rapportini');
    for (const [k, fl] of Object.entries(dati)) {
      const d = await r.getDirectoryHandle(k);
      for (const [n, t] of Object.entries(fl)) { const h = await d.getFileHandle(n, { create: true }); const w = await h.createWritable(); await w.write(t); await w.close(); }
    }
  }, Object.fromEntries(['invii', 'anagrafiche'].map((d) => [d, Object.fromEntries(fs.readdirSync(path.join(drive, d)).map((n) => [n, fs.readFileSync(path.join(drive, d, n), 'utf8')]))])));
  await carica();
  await u.click('#aggiorna'); await u.waitForSelector('#aggiorna:not([disabled])');
  await u.setViewportSize({ width: 1280, height: 1010 });
  await foto(u, 'ufficio-cruscotto');
  await u.setViewportSize({ width: 1280, height: 800 });
  await u.locator('.filters').screenshot({ path: path.join(IMG, 'ufficio-filtri.png') });

  // correzione
  await u.locator('tr', { hasText: 'manca il materiale' }).locator('[data-correggi]').click();
  await u.fill('#e-fin', '12:45');
  await u.fill('#e-pz', '15');
  await u.locator('#e-fin').blur();
  await u.locator('#pannello-modifica').screenshot({ path: path.join(IMG, 'ufficio-correzione.png') });
  await u.click('#e-x');

  // esportazione, poi correzione di una riga già esportata
  const [dl] = await Promise.all([u.waitForEvent('download'), u.click('#esporta')]);
  await dl.saveAs(path.join(os.tmpdir(), 'man-esp.xlsx'));
  await u.waitForSelector('#esito');
  await u.locator('#esito').screenshot({ path: path.join(IMG, 'ufficio-esito.png') });
  await u.locator('tr', { hasText: 'manca il materiale' }).locator('[data-correggi]').click();
  await u.fill('#e-fin', '12:45'); await u.locator('#e-fin').blur(); await u.fill('#e-pz', '15');
  await u.click('#e-salva'); await u.waitForSelector('#pannello-modifica', { state: 'detached' });
  await u.waitForTimeout(4200);
  await u.setViewportSize({ width: 1280, height: 1110 });
  await foto(u, 'ufficio-da-riportare');
  await u.setViewportSize({ width: 1280, height: 800 });

  // anagrafiche
  await u.click('#t-ana');
  await u.setViewportSize({ width: 1280, height: 860 });
  await foto(u, 'ufficio-commesse');
  await u.click('[data-sez="dipendenti"]'); await u.click('[data-voce="0"]');
  await u.locator('#pannello-voce').screenshot({ path: path.join(IMG, 'ufficio-pin.png') });
  await u.click('#v-x');

  await browser.close(); await sito.chiudi(); await script.chiudi();
  console.log(fs.readdirSync(IMG).join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });
