/*
 * Prove complete nel browser (Google Chrome installato sul PC): tablet e ufficio veri,
 * Codice.gs vero, finto Drive su disco. Copre le prove richieste:
 * invio doppio, tablet offline che torna online, due tablet insieme, correzione e nuova esportazione.
 */
'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const XLSX = require('../ufficio/vendor/xlsx.full.min.js');
XLSX.set_fs(require('node:fs')); // la copia per browser non ha accesso al disco se non glielo si dà
const { avviaServer, avviaSitoStatico } = require('./finto-apps-script.js');

const RADICE = path.join(__dirname, '..');
const USCITE = path.join(__dirname, 'risultati');
const FILE_DEMO = path.join(RADICE, '..', 'piattaforma-controllo', 'test', 'dati', 'rapportini_demo_2026.xlsx');
const CARTELLA_RIF = path.join(RADICE, '..', 'piattaforma-controllo', 'riferimenti');
const HTML_RIFERIMENTO = fs.existsSync(CARTELLA_RIF) ? path.join(CARTELLA_RIF, fs.readdirSync(CARTELLA_RIF).find((n) => /^Controllo_Commesse.*\.html$/.test(n)) || 'manca') : 'manca';
const TOKEN = 'token-di-prova';
const oggi = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

let browser, sito, script, drive;

/* ---------- aiuti: tablet ---------- */
async function nuovoTablet(codice, opzioni = {}) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'it-IT', timezoneId: 'Europe/Rome', ...opzioni });
  const page = await context.newPage();
  page.erroriPagina = [];
  page.on('pageerror', (e) => page.erroriPagina.push(e.message));
  await page.goto(`${sito.url}/tablet/`);
  await page.fill('#s-cod', codice);
  await page.fill('#s-url', script.url);
  await page.fill('#s-tok', TOKEN);
  await page.click('#s-ok');
  await page.waitForSelector('.people');
  // aspetta che il service worker controlli la pagina: da qui in poi funziona anche offline
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 }).catch(() => page.reload());
  await page.waitForSelector('.people');
  return { context, page };
}
async function entra(page, nome, pin = '1234') {
  await page.click(`[data-dip="${nome}"]`);
  for (const k of pin) await page.click(`[data-k="${k}"]`);
  await page.waitForSelector('#nuova');
}
async function esci(page) { await page.click('#esci'); await page.waitForSelector('.people'); }
async function lavorazioneCronometro(page, commessa, lavorazione, pezzi) {
  await page.click('#nuova');
  await page.fill('#q', commessa);
  await page.click(`[data-com="${commessa}"]`);
  await page.click(`[data-lav="${lavorazione}"]`);
  await page.click('#sh-avvia');
  await page.waitForSelector('[data-chiudi]');
  await page.locator('[data-chiudi]').last().click();
  await page.fill('#c-pz', String(pezzi));
  await page.click('#c-salva');
  await page.waitForSelector('#nuova');
}
async function rigaManuale(page, { commessa, lavorazione = 'Crimpatura', minuti = 60, pezzi = 10, data, note = '' }) {
  await page.click('#manuale');
  await page.fill('#q', commessa);
  await page.click(`[data-com="${commessa}"]`);
  await page.click(`[data-lav="${lavorazione}"]`);
  if (data) await page.fill('#m-data', data);
  await page.fill('#m-min', String(minuti));
  await page.fill('#m-pz', String(pezzi));
  if (note) await page.fill('#m-note', note);
  await page.click('#sh-salva');
  await page.waitForSelector('#nuova');
}
const inviiSuDisco = () => fs.readdirSync(path.join(drive, 'invii')).sort();
const idSuDisco = () => inviiSuDisco().flatMap((f) => JSON.parse(fs.readFileSync(path.join(drive, 'invii', f), 'utf8')).righe.map((r) => r.id));
const statoTablet = (page) => page.evaluate(() => new Promise((ok) => {
  const rq = indexedDB.open('rapportino', 1);
  rq.onsuccess = () => { const g = rq.result.transaction('righe').objectStore('righe').getAll(); g.onsuccess = () => ok(g.result); };
}));
const aspettaTuttoInviato = (page, ms = 20000) => page.waitForFunction(() => document.querySelector('#testo-stato')?.textContent === 'Tutto inviato', null, { timeout: ms });

/* ---------- aiuti: ufficio ---------- */
/**
 * La finestra di scelta cartella è del sistema operativo e un test non può usarla: qui la cartella è quella
 * privata del browser (stesso tipo di oggetto), riallineata col finto Drive da sincronizza(), che imita Drive per desktop.
 */
async function nuovoUfficio() {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'it-IT', timezoneId: 'Europe/Rome', acceptDownloads: true });
  await context.addInitScript(() => {
    delete window.showSaveFilePicker;
    window.showSaveFilePicker = undefined;
    window.showDirectoryPicker = async () => { const r = await navigator.storage.getDirectory(); return r.getDirectoryHandle('archivio', { create: true }); };
  });
  const page = await context.newPage();
  page.erroriPagina = [];
  page.on('pageerror', (e) => page.erroriPagina.push(e.message));
  await page.goto(`${sito.url}/ufficio/`);
  return { context, page };
}
async function sincronizza(page) {
  const leggi = (dir) => Object.fromEntries(fs.readdirSync(path.join(drive, dir)).map((n) => [n, fs.readFileSync(path.join(drive, dir, n), 'utf8')]));
  const daDrive = { invii: leggi('invii') };
  const scritti = await page.evaluate(async (dati) => {
    const r = await (await navigator.storage.getDirectory()).getDirectoryHandle('archivio', { create: true });
    for (const [cartella, files] of Object.entries(dati)) {
      const d = await r.getDirectoryHandle(cartella, { create: true });
      for (const [nome, testo] of Object.entries(files)) {
        const h = await d.getFileHandle(nome, { create: true });
        const w = await h.createWritable(); await w.write(testo); await w.close();
      }
    }
    const fuori = {};
    for (const cartella of ['anagrafiche', 'ufficio']) {
      const d = await r.getDirectoryHandle(cartella, { create: true });
      fuori[cartella] = {};
      for await (const [nome, h] of d.entries()) fuori[cartella][nome] = await (await h.getFile()).text();
    }
    return fuori;
  }, daDrive);
  for (const [cartella, files] of Object.entries(scritti)) for (const [nome, testo] of Object.entries(files)) fs.writeFileSync(path.join(drive, cartella, nome), testo);
}
async function aggiorna(page) { await sincronizza(page); await page.click('#aggiorna'); await page.waitForSelector('#aggiorna:not([disabled])'); }
const valore = (page, sel) => page.locator(sel).innerText();
async function esportaFile(page, nomeProva) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#esporta')]);
  fs.mkdirSync(USCITE, { recursive: true });
  const dest = path.join(USCITE, nomeProva);
  await download.saveAs(dest);
  await page.waitForSelector('#esito');
  return XLSX.readFile(dest, { cellNF: true });
}
const righeFoglio = (wb, nome = 'RAPPORTINI') => XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true }).slice(1);
const impronte = () => Object.fromEntries(inviiSuDisco().map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(drive, 'invii', f))).digest('hex')]));

/* ---------- scenario ---------- */
describe('percorso completo', () => {
  let ufficio;
  before(async () => {
    drive = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-drive-'));
    for (const d of ['anagrafiche', 'invii', 'ufficio']) fs.mkdirSync(path.join(drive, d));
    fs.copyFileSync(path.join(RADICE, 'esempi', 'anagrafiche.esempio.json'), path.join(drive, 'anagrafiche', 'anagrafiche.json'));
    browser = await chromium.launch({ channel: 'chrome' });
    sito = await avviaSitoStatico();
    script = await avviaServer({ cartella: drive, token: TOKEN });
    ufficio = await nuovoUfficio();
    await ufficio.page.click('#scegli');
    await ufficio.page.waitForSelector('#crea');
    await ufficio.page.click('#crea');
    await ufficio.page.waitForSelector('#aggiorna');
  });
  after(async () => {
    await browser?.close();
    await sito?.chiudi();
    await script?.chiudi();
  });

  test('prima configurazione: un token sbagliato non passa', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${sito.url}/tablet/`);
    await page.fill('#s-cod', 'TAB09');
    await page.fill('#s-url', script.url);
    await page.fill('#s-tok', 'sbagliato');
    await page.click('#s-ok');
    await page.waitForFunction(() => document.querySelector('#s-err')?.textContent.includes('Token non valido'));
    await context.close();
  });

  test('PIN sbagliato rifiutato, codici commessa sempre testo sul tablet', async () => {
    const { context, page } = await nuovoTablet('TAB03');
    await page.click('[data-dip="Operatore 1"]');
    for (const k of '9999') await page.click(`[data-k="${k}"]`);
    await page.waitForFunction(() => document.querySelector('.err')?.textContent.includes('PIN errato'));
    for (const k of '1234') await page.click(`[data-k="${k}"]`);
    await page.waitForSelector('#nuova');
    await page.click('#nuova');
    await page.fill('#q', '06/07');
    assert.equal(await page.locator('[data-com="06/07/2026"] b').innerText(), '06/07/2026');
    await page.fill('#q', '0042');
    assert.equal(await page.locator('[data-com="0042"] b').innerText(), '0042');
    await page.click('#sh-x');
    assert.deepEqual(page.erroriPagina, []);
    await context.close();
  });

  test('il cronometro sopravvive alla chiusura dell\'app e la riga parte da sola', async () => {
    const { context, page } = await nuovoTablet('TAB01');
    await entra(page, 'Operatore 1');
    await page.click('#nuova');
    await page.fill('#q', '1001');
    await page.click('[data-com="1001"]');
    await page.click('[data-lav="Crimpatura"]');
    await page.click('#sh-avvia');
    await page.waitForSelector('.run-card');
    await page.reload();
    await entra(page, 'Operatore 1');
    await page.waitForSelector('.run-card');
    assert.equal((await statoTablet(page))[0].stato, 'aperta');
    assert.equal(inviiSuDisco().length, 0, 'una lavorazione aperta non viene inviata');
    await page.click('[data-chiudi]');
    await page.fill('#c-pz', '25');
    await page.click('#c-salva');
    await page.waitForSelector('#nuova');
    await aspettaTuttoInviato(page);
    assert.equal(inviiSuDisco().length, 1);
    assert.match(inviiSuDisco()[0], /^RAP_TAB01_Operatore-1_\d{8}-\d{6}\.json$/);
    assert.equal((await statoTablet(page))[0].stato, 'inviata');
    await context.close();
  });

  test('PROVA 1 — tablet offline: niente si perde e parte da solo al ritorno della rete', async () => {
    const { context, page } = await nuovoTablet('TAB02');
    await context.setOffline(true);
    await page.reload(); // l'app si apre anche senza rete
    await entra(page, 'Operatore 2');
    await rigaManuale(page, { commessa: '1002', minuti: 30, pezzi: 5 });
    await rigaManuale(page, { commessa: '901/CL', minuti: 45, pezzi: 6, lavorazione: 'Collaudo' });
    const prima = inviiSuDisco().length;
    await page.click('#invia'); // tentativo a mano mentre non c'è rete
    await page.waitForFunction(() => document.querySelector('#testo-stato')?.textContent.includes('2 da inviare'));
    let righe = await statoTablet(page);
    assert.ok(righe.every((r) => r.stato === 'da_inviare'), 'senza conferma restano da inviare');
    assert.equal(inviiSuDisco().length, prima);
    await page.reload(); // anche chiudendo l'app mentre è offline
    await page.waitForSelector('.people');
    assert.equal((await statoTablet(page)).length, 2);
    await context.setOffline(false); // nessun clic: deve ripartire da solo
    await aspettaTuttoInviato(page);
    righe = await statoTablet(page);
    assert.ok(righe.every((r) => r.stato === 'inviata'));
    // Di norma un file; possono essere di più se un tentativo arriva al server ma il tablet non riceve la risposta.
    // Conta che nessuna riga manchi: i doppioni li scarta l'ufficio (PROVA 3).
    assert.ok(inviiSuDisco().length >= prima + 1);
    for (const r of righe) assert.ok(idSuDisco().includes(r.id), 'riga arrivata');
    assert.deepEqual(page.erroriPagina, []);
    await context.close();
  });

  test('server irraggiungibile o script mal configurato: nessuna riga marcata inviata', async () => {
    const { context, page } = await nuovoTablet('TAB04');
    await entra(page, 'Operatore 3');
    script.stato.spento = true;
    await rigaManuale(page, { commessa: '5390001', minuti: 10, pezzi: 1 });
    await page.waitForFunction(() => document.querySelector('#testo-stato')?.textContent.includes('non riuscito'));
    script.stato.spento = false;
    assert.equal((await statoTablet(page))[0].stato, 'da_inviare');
    // risposta di Google con la pagina di login al posto del JSON (accesso non impostato su "Chiunque")
    await page.route('**/exec', (r) => r.fulfill({ status: 200, contentType: 'text/html', headers: { 'Access-Control-Allow-Origin': '*' }, body: '<html>Accedi a Google</html>' }));
    await page.click('#invia');
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Risposta non valida'));
    assert.equal((await statoTablet(page))[0].stato, 'da_inviare');
    await page.unroute('**/exec');
    await page.click('#invia');
    await aspettaTuttoInviato(page);
    assert.equal((await statoTablet(page))[0].stato, 'inviata');
    await context.close();
  });

  test('PROVA 2 — due tablet che inviano insieme', async () => {
    const a = await nuovoTablet('TABA'), b = await nuovoTablet('TABB');
    await a.context.setOffline(true); await b.context.setOffline(true);
    await entra(a.page, 'Operatore 1'); await entra(b.page, 'Operatore 2');
    await rigaManuale(a.page, { commessa: 'OA99-0001', minuti: 20, pezzi: 2 });
    await rigaManuale(b.page, { commessa: 'OA99-0002', minuti: 25, pezzi: 3 });
    const idA = (await statoTablet(a.page))[0].id, idB = (await statoTablet(b.page))[0].id;
    const prima = inviiSuDisco().length;
    await Promise.all([a.context.setOffline(false), b.context.setOffline(false)]);
    await Promise.all([aspettaTuttoInviato(a.page), aspettaTuttoInviato(b.page)]);
    const nuovi = inviiSuDisco().filter((f) => /^RAP_TAB[AB]_/.test(f));
    assert.ok(nuovi.some((f) => f.startsWith('RAP_TABA_')) && nuovi.some((f) => f.startsWith('RAP_TABB_')), 'un file per ciascun tablet');
    assert.ok(inviiSuDisco().length >= prima + 2);
    const ids = idSuDisco();
    assert.ok(ids.includes(idA) && ids.includes(idB), 'nessuna riga persa');
    await aggiorna(ufficio.page);
    assert.equal(await valore(ufficio.page, '#k-totale'), String(new Set(ids).size), 'ogni riga contata una volta');
    await a.context.close(); await b.context.close();
  });

  test('PROVA 3 — invio doppio: risposta persa e file duplicato contano una volta sola', async () => {
    const { context, page } = await nuovoTablet('TAB05');
    await entra(page, 'Operatore 4');
    // il server crea il file, ma la risposta non arriva al tablet
    await page.route('**/exec', async (r) => { await r.fetch(); await r.abort('connectionreset'); });
    const prima = inviiSuDisco().length;
    await rigaManuale(page, { commessa: '902/CL', minuti: 50, pezzi: 7, note: 'prova doppio' });
    await page.waitForFunction(() => document.querySelector('#testo-stato')?.textContent.includes('non riuscito'));
    assert.ok(inviiSuDisco().length >= prima + 1, 'il file è arrivato');
    const primaDelNuovoInvio = inviiSuDisco().length;
    assert.equal((await statoTablet(page))[0].stato, 'da_inviare', 'ma il tablet non lo sa e lo tiene');
    await page.unroute('**/exec');
    await page.click('#invia');
    await aspettaTuttoInviato(page);
    const dopo = inviiSuDisco();
    assert.equal(dopo.length, primaDelNuovoInvio + 1, 'stessa riga in due file');
    // e in più Drive che sincronizza due volte lo stesso file
    const un = dopo.find((f) => JSON.parse(fs.readFileSync(path.join(drive, 'invii', f), 'utf8')).codiceTablet === 'TAB05');
    fs.copyFileSync(path.join(drive, 'invii', un), path.join(drive, 'invii', un.replace('.json', ' (1).json')));

    await aggiorna(ufficio.page);
    const tutti = idSuDisco();
    const unici = new Set(tutti).size;
    assert.ok(tutti.length >= unici + 2);
    assert.equal(await valore(ufficio.page, '#k-totale'), String(unici));
    assert.equal(await ufficio.page.locator('tr', { hasText: 'prova doppio' }).count(), 1);
    assert.match(await ufficio.page.locator('.kpi', { hasText: 'Righe totali' }).innerText(), new RegExp(`${tutti.length - unici} doppioni scartati`));
    await context.close();
  });

  test('cruscotto: ore, pezzi e ultimo invio per tablet; segnalazioni in tabella', async () => {
    const { context, page } = await nuovoTablet('TAB06');
    await entra(page, 'Operatore 1');
    await rigaManuale(page, { commessa: '0042', minuti: 700, pezzi: 0, note: 'lunga e senza pezzi', lavorazione: 'Imballo' });
    await aspettaTuttoInviato(page);
    await context.close();
    await aggiorna(ufficio.page);
    const p = ufficio.page;
    const r = p.locator('tr', { hasText: 'lunga e senza pezzi' });
    const stato = await r.innerText();
    assert.match(stato, /Oltre 10 ore/);
    assert.match(stato, /0 pezzi/);
    assert.equal(await r.getAttribute('class'), 'segnalata');
    const testo = await p.locator('#tablet').innerText();
    for (const t of ['TAB01', 'TAB02', 'TABA', 'TABB', 'TAB06']) assert.ok(testo.includes(t), t);
    const tuttoOggi = idSuDisco().length; // numero indicativo: i kpi devono esserci e non essere zero
    assert.ok(tuttoOggi > 0);
    assert.notEqual(await valore(p, '#k-ore'), '0,0');
    await p.fill('#f-com', '0042');
    assert.equal(await p.locator('#tabella tbody tr').count(), 1);
    await p.fill('#f-com', '');
    await p.selectOption('#f-dip', 'Operatore 2');
    assert.ok((await p.locator('#tabella tbody tr').allInnerTexts()).every((t) => t.includes('Operatore 2')));
    await p.selectOption('#f-dip', '');
    const ieri = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await p.fill('#f-al', ieri); await p.fill('#f-dal', ieri);
    assert.match(await p.locator('#tabella').innerText(), /Nessuna riga/);
    await p.fill('#f-dal', oggi()); await p.fill('#f-al', oggi());
    assert.deepEqual(p.erroriPagina, []);
  });

  test('PROVA 4 — correzione e nuova esportazione, con i file degli invii intatti', async () => {
    const p = ufficio.page;
    const intatti = impronte();
    const wb1 = await esportaFile(p, 'esportazione-1.xlsx');
    const prime = righeFoglio(wb1);
    const totali = await p.locator('#tabella tbody tr').count();
    assert.equal(prime.length, totali, 'la prima volta tutte le righe del filtro');
    const intest = XLSX.utils.sheet_to_json(wb1.Sheets.RAPPORTINI, { header: 1 })[0];
    assert.deepEqual(intest, ['DATA', 'DIPENDENTE', 'N° COMMESSA', 'CODICE ARTICOLO', 'LAVORAZIONE ESEGUITA', 'INIZIO', 'FINE', 'MINUTI', 'PEZZI', 'NOTE']);
    assert.ok(prime.some((r) => r[2] === '0042'), 'lo zero iniziale resta');
    assert.equal(await p.locator('#esporta').isDisabled(), true, 'niente di nuovo da esportare');

    // correzione di una riga già esportata
    const tr = p.locator('tr', { hasText: 'lunga e senza pezzi' });
    await tr.locator('[data-correggi]').click();
    await p.fill('#e-pz', '33');
    await p.fill('#e-min', '420');
    await p.click('#e-salva');
    await p.waitForSelector('#pannello-modifica', { state: 'detached' });
    const corretta = p.locator('tr', { hasText: 'lunga e senza pezzi' });
    assert.match(await corretta.innerText(), /Corretta/);
    assert.match(await corretta.innerText(), /Da riportare in Excel/);
    assert.doesNotMatch(await corretta.innerText(), /Oltre 10 ore/);

    // eliminazione di una riga non ancora esportata e arrivo di una riga nuova
    const { context, page } = await nuovoTablet('TAB07');
    await entra(page, 'Operatore 3');
    await rigaManuale(page, { commessa: '1001', minuti: 15, pezzi: 4, note: 'riga da tenere' });
    await rigaManuale(page, { commessa: '1002', minuti: 16, pezzi: 5, note: 'riga da eliminare' });
    await aspettaTuttoInviato(page);
    await context.close();
    await aggiorna(p);
    const del = p.locator('tr', { hasText: 'riga da eliminare' });
    await del.locator('[data-correggi]').click();
    await p.click('#e-eli'); await p.click('#e-eli-si');
    await p.waitForSelector('#pannello-modifica', { state: 'detached' });
    assert.equal(await p.locator('tr', { hasText: 'riga da eliminare' }).count(), 0);

    const wb2 = await esportaFile(p, 'esportazione-2.xlsx');
    const seconde = righeFoglio(wb2);
    assert.deepEqual(seconde.map((r) => r[9]), ['riga da tenere'], 'solo la riga nuova: né la corretta né l\'eliminata');
    const corr = righeFoglio(wb2, 'CORREZIONI_DA_RIPORTARE');
    assert.equal(corr.length, 2);
    assert.deepEqual([corr[0][0], corr[0][1], corr[0][9], corr[0][10]], ['CORREGGI', 'PRIMA (in Excel)', 700, 0]);
    assert.deepEqual([corr[1][1], corr[1][9], corr[1][10]], ['DOPO', 420, 33]);
    assert.equal(await p.locator('#esporta').isDisabled(), true, 'tutto riportato: niente da rifare');

    await sincronizza(p);
    assert.deepEqual(Object.fromEntries(Object.entries(impronte()).filter(([k]) => k in intatti)), intatti, 'i file degli invii non cambiano mai');
    const corrFile = JSON.parse(fs.readFileSync(path.join(drive, 'ufficio', 'correzioni.json'), 'utf8'));
    assert.equal(Object.keys(corrFile.correzioni).length, 2);
    const impFile = JSON.parse(fs.readFileSync(path.join(drive, 'ufficio', 'importati.json'), 'utf8'));
    assert.ok(Object.keys(impFile.righe).length >= seconde.length + prime.length);

    // ricaricando l'app tutto resta: cartella ricordata, correzioni, esportate
    await p.reload();
    await p.waitForSelector('#aggiorna');
    assert.match(await p.locator('tr', { hasText: 'lunga e senza pezzi' }).innerText(), /Corretta/);
    assert.equal(await p.locator('#esporta').isDisabled(), true);
    assert.deepEqual(p.erroriPagina, []);
  });

  test('ripristino di una riga eliminata', async () => {
    const p = ufficio.page;
    await p.check('#f-eli');
    const r = p.locator('tr', { hasText: 'riga da eliminare' });
    assert.equal(await r.getAttribute('class'), 'eliminata');
    await r.locator('[data-ripristina]').click();
    await p.waitForFunction(() => ![...document.querySelectorAll('tr.eliminata')].length);
    await p.uncheck('#f-eli');
    assert.equal(await p.locator('tr', { hasText: 'riga da eliminare' }).count(), 1);
    assert.match(await p.locator('#esporta').innerText(), /Esporta 1 riga/);
  });

  test('un file degli invii rovinato si segnala senza fermare la lettura', async () => {
    const p = ufficio.page;
    fs.writeFileSync(path.join(drive, 'invii', 'RAP_rotto.json'), '{"righe":[');
    await aggiorna(p);
    await p.waitForFunction(() => document.body.innerText.includes('RAP_rotto.json'));
    assert.ok(Number(await valore(p, '#k-totale')) > 0);
    fs.rmSync(path.join(drive, 'invii', 'RAP_rotto.json'));
    await p.evaluate(async () => {
      const r = await (await navigator.storage.getDirectory()).getDirectoryHandle('archivio');
      await (await r.getDirectoryHandle('invii')).removeEntry('RAP_rotto.json');
    });
    await aggiorna(p);
  });

  test('un file dell\'ufficio rovinato non viene mai sovrascritto', async () => {
    const p = ufficio.page;
    await sincronizza(p);
    const buono = await p.evaluate(async () => {
      const r = await (await navigator.storage.getDirectory()).getDirectoryHandle('archivio');
      const h = await (await r.getDirectoryHandle('ufficio')).getFileHandle('correzioni.json');
      const prima = await (await h.getFile()).text();
      const w = await h.createWritable(); await w.write('{rovinato'); await w.close();
      return prima;
    });
    await p.click('#aggiorna');
    await p.waitForFunction(() => document.body.innerText.includes('correzioni.json non si legge'));
    await p.locator('[data-correggi]').first().click();
    await p.fill('#e-pz', '77');
    await p.click('#e-salva');
    await p.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('non lo sovrascrivo'));
    const ora = await p.evaluate(async () => {
      const r = await (await navigator.storage.getDirectory()).getDirectoryHandle('archivio');
      const h = await (await r.getDirectoryHandle('ufficio')).getFileHandle('correzioni.json');
      return (await h.getFile()).text();
    });
    assert.equal(ora, '{rovinato');
    await p.evaluate(async (t) => {
      const r = await (await navigator.storage.getDirectory()).getDirectoryHandle('archivio');
      const h = await (await r.getDirectoryHandle('ufficio')).getFileHandle('correzioni.json');
      const w = await h.createWritable(); await w.write(t); await w.close();
    }, buono);
    await p.click('#e-x');
    await p.click('#aggiorna');
    await p.waitForSelector('#aggiorna:not([disabled])');
  });

  test('anagrafiche: codice "9/12" resta testo fino al tablet; PIN nuovo funziona; niente PIN in chiaro', async () => {
    const p = ufficio.page;
    // prima lettura: l'archivio di prova dell'ufficio riceve il file delle anagrafiche
    await p.evaluate(async (t) => {
      const r = await (await navigator.storage.getDirectory()).getDirectoryHandle('archivio');
      const h = await (await r.getDirectoryHandle('anagrafiche')).getFileHandle('anagrafiche.json', { create: true });
      const w = await h.createWritable(); await w.write(t); await w.close();
    }, fs.readFileSync(path.join(drive, 'anagrafiche', 'anagrafiche.json'), 'utf8'));
    await p.click('#aggiorna');
    await p.waitForSelector('#aggiorna:not([disabled])');
    await p.click('#t-ana');
    await p.click('#a-nuova');
    await p.fill('#v-cod', '3/4');
    await p.fill('#v-cli', 'ZETA');
    await p.click('#v-salva');
    await p.waitForSelector('#pannello-voce', { state: 'detached' });
    await p.click('[data-sez="dipendenti"]');
    await p.click('#a-nuova');
    await p.fill('#v-nome', 'Operatore 9');
    await p.fill('#v-pin', '12');
    await p.click('#v-salva');
    await p.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('4 cifre'));
    await p.fill('#v-pin', '4567');
    await p.click('#v-salva');
    await p.waitForSelector('#pannello-voce', { state: 'detached' });
    await sincronizza(p);
    const f = fs.readFileSync(path.join(drive, 'anagrafiche', 'anagrafiche.json'), 'utf8');
    assert.ok(f.includes('"codice": "3/4"'));
    assert.ok(f.includes('"codice": "0042"'));
    assert.ok(!f.includes('4567'));

    const { context, page } = await nuovoTablet('TAB08');
    await entra(page, 'Operatore 9', '4567');
    await rigaManuale(page, { commessa: '3/4', minuti: 12, pezzi: 1, note: 'codice testo' });
    await aspettaTuttoInviato(page);
    await context.close();
    await p.click('#t-rap');
    await aggiorna(p);
    const wb = await esportaFile(p, 'esportazione-3.xlsx');
    const riga = righeFoglio(wb).find((r) => r[9] === 'codice testo');
    assert.equal(riga[2], '3/4');
    assert.equal(typeof riga[2], 'string');
    assert.deepEqual(p.erroriPagina, []);
  });

  test('importazione delle anagrafiche dal file Excel di prova', { skip: !fs.existsSync(FILE_DEMO) }, async () => {
    const p = ufficio.page;
    await p.click('#t-ana');
    await p.setInputFiles('#a-file', FILE_DEMO);
    await p.waitForSelector('#pannello-importa');
    assert.match(await p.locator('#pannello-importa').innerText(), /aspetto di una data/);
    await p.click('#imp-ok');
    await p.waitForSelector('#pannello-importa', { state: 'detached' });
    await p.click('[data-sez="dipendenti"]');
    assert.ok((await p.locator('tr', { hasText: 'Operatore 9' }).innerText()).includes('Impostato'), 'il PIN già impostato resta');
    await p.click('#t-rap');
  });

  test('avviso sulle lavorazioni rimaste aperte (giorno precedente e oltre 10 ore)', async () => {
    const { context, page } = await nuovoTablet('TAB10');
    const ora = Date.now();
    await page.clock.install({ time: new Date(ora - 26 * 3600000) });
    await page.reload();
    await entra(page, 'Operatore 2');
    await page.click('#nuova');
    await page.fill('#q', '1001');
    await page.click('[data-com="1001"]');
    await page.click('[data-lav="Crimpatura"]');
    await page.click('#sh-avvia');
    await page.waitForSelector('.run-card');
    await page.clock.setFixedTime(new Date(ora));
    await page.click('#esci');
    await page.waitForSelector('.people');
    assert.match(await page.locator('[data-dip="Operatore 2"]').innerText(), /1 da chiudere/);
    await entra(page, 'Operatore 2');
    assert.match(await page.locator('.run-card').innerText(), /rimasta aperta da un giorno precedente/);
    await page.click('[data-chiudi]');
    assert.equal(await page.inputValue('#c-fin'), '', 'nessuna ora proposta: va scritta quella reale');
    await context.close();
  });

  test('ufficio aperto da file://: sicurezza, cifratura e scelta cartella disponibili', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('file://' + path.join(RADICE, 'ufficio', 'index.html'));
    await page.waitForSelector('#scegli');
    const r = await page.evaluate(async () => ({
      sicuro: isSecureContext, cifra: !!crypto.subtle, cartella: typeof showDirectoryPicker, xlsx: typeof XLSX, logica: typeof Logica,
      impronta: (await Logica.creaPin('1234')).pinHash.length,
    }));
    assert.deepEqual(r, { sicuro: true, cifra: true, cartella: 'function', xlsx: 'object', logica: 'object', impronta: 64 });
    await context.close();
  });

  test('compatibilità: l\'esportazione incollata nel foglio viene letta da Controllo Commesse', { skip: !fs.existsSync(FILE_DEMO) || !fs.existsSync(HTML_RIFERIMENTO) }, async () => {
    // Incolla le colonne A-J nella prima riga libera di una copia del file di prova, come farebbe l'ufficio
    const esp = XLSX.readFile(path.join(USCITE, 'esportazione-1.xlsx'), { cellNF: true });
    const annuale = XLSX.readFile(FILE_DEMO, { cellFormula: true, cellNF: true });
    const ws = annuale.Sheets.RAPPORTINI;
    let libera = 6; while (ws['A' + libera]) libera++;
    const quante = XLSX.utils.decode_range(esp.Sheets.RAPPORTINI['!ref']).e.r;
    for (let r = 0; r < quante; r++) for (const c of 'ABCDEFGHIJ') {
      const cella = esp.Sheets.RAPPORTINI[c + (r + 2)];
      if (cella) ws[c + (libera + r)] = { ...cella };
    }
    const buf = XLSX.write(annuale, { type: 'base64', bookType: 'xlsx' });
    const context = await browser.newContext({ timezoneId: 'Europe/Rome' });
    const page = await context.newPage();
    await page.goto('file://' + HTML_RIFERIMENTO);
    const d = await page.evaluate((b) => {
      const dati = parseWorkbook(XLSX.read(b, { type: 'base64' }), 'prova.xlsx');
      return dati.rap;
    }, buf);
    const incollate = d.slice(-quante);
    const attese = righeFoglio(esp);
    assert.equal(incollate.length, attese.length);
    incollate.forEach((r, i) => {
      assert.equal(r.com, attese[i][2], 'codice commessa');
      assert.equal(r.dip, attese[i][1]);
      assert.equal(r.min, attese[i][7]);
      assert.equal(r.pz, attese[i][8]);
      assert.equal(r.data, oggi());
    });
    assert.ok(incollate.some((r) => r.com === '0042'));
    await context.close();
  });
});
