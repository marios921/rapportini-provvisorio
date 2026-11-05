/* Test della logica condivisa e del vero Codice.gs (con un finto Drive). Nessun browser. */
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../comune/logica.js');
const XLSX = require('../ufficio/vendor/xlsx.full.min.js');
XLSX.set_fs(require('node:fs')); // la copia per browser non ha accesso al disco se non glielo si dà
const { caricaScript } = require('./finto-apps-script.js');

const FILE_DEMO = path.join(__dirname, '..', '..', 'piattaforma-controllo', 'test', 'dati', 'rapportini_demo_2026.xlsx');
const riga = (over = {}) => ({
  id: L.nuovoUuid(), data: '2026-11-03', dipendente: 'Operatore 1', commessa: '1001', codiceArticolo: '', lavorazione: 'Crimpatura',
  inizioMinuti: 480, fineMinuti: 615, minuti: 135, pezzi: 120, note: '', origine: 'tablet', manuale: false, codiceTablet: 'TAB01', creatoIl: '2026-11-03T08:00:00.000Z', ...over,
});

describe('chiusura e inserimento manuale', () => {
  const inizio = new Date(2026, 10, 3, 8, 0, 40);
  const aperta = () => L.creaRigaCronometro({ dipendente: 'A', commessa: '1001', lavorazione: 'X', codiceTablet: 'T' }, inizio);

  test('la riga da cronometro ha lo stesso formato della piattaforma definitiva', () => {
    const r = aperta();
    for (const k of ['id', 'data', 'dipendente', 'commessa', 'codiceArticolo', 'lavorazione', 'inizioMinuti', 'fineMinuti', 'minuti', 'pezzi', 'note', 'origine']) assert.ok(k in r, k);
    assert.equal(r.origine, 'tablet');
    assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test('i minuti tornano con ciò che si legge: 08:00 - 10:15 = 135', () => {
    const r = L.chiudiRiga(aperta(), { oraFine: '10:15', pezzi: '12', note: ' x ' }, new Date(2026, 10, 3, 10, 15, 30));
    assert.deepEqual([r.minuti, r.pezzi, r.fineMinuti, r.note], [135, 12, 615, 'x']);
  });
  test('una fine prima dell\'inizio vale per il giorno dopo', () => {
    const r = L.chiudiRiga({ ...aperta(), inizioIl: new Date(2026, 10, 2, 22, 0).toISOString() }, { oraFine: '06:00', pezzi: 1 }, new Date(2026, 10, 3, 7, 0));
    assert.equal(r.minuti, 480);
  });
  test('rifiuta un\'ora di fine nel futuro, che il prototipo trasformava in 23 ore', () => {
    assert.throws(() => L.chiudiRiga(aperta(), { oraFine: '07:00', pezzi: 1 }, new Date(2026, 10, 3, 9, 0)), /futuro/);
  });
  test('i pezzi sono obbligatori, ma 0 è valido', () => {
    assert.throws(() => L.chiudiRiga(aperta(), { oraFine: '09:00', pezzi: '' }, new Date(2026, 10, 3, 10, 0)), /pezzi/);
    assert.equal(L.chiudiRiga(aperta(), { oraFine: '09:00', pezzi: '0' }, new Date(2026, 10, 3, 10, 0)).pezzi, 0);
  });
  test('la proposta dell\'ora di fine è vuota per i giorni precedenti', () => {
    assert.equal(L.oraFineProposta(aperta(), new Date(2026, 10, 3, 17, 5)), '17:05');
    assert.equal(L.oraFineProposta(aperta(), new Date(2026, 10, 4, 8, 0)), '');
  });
  test('avvisi: giorno precedente e oltre 10 ore', () => {
    assert.equal(L.avvisoAperta(aperta(), new Date(2026, 10, 3, 17, 0)), null);
    assert.equal(L.avvisoAperta(aperta(), new Date(2026, 10, 3, 18, 30)), 'oltre-10-ore');
    assert.equal(L.avvisoAperta(aperta(), new Date(2026, 10, 4, 7, 0)), 'giorno-precedente');
    assert.equal(L.avvisoAperta({ ...aperta(), minuti: 5 }, new Date(2026, 10, 4, 7, 0)), null);
  });
  const base = { data: '2026-11-03', dipendente: 'A', commessa: '1', lavorazione: 'X', codiceTablet: 'T' };
  const dopo = new Date(2026, 10, 5);
  test('manuale: inizio e fine, oppure minuti; i minuti vincono come in Excel', () => {
    assert.equal(L.creaRigaManuale({ ...base, inizio: '08:00', fine: '10:30', pezzi: 5 }, dopo).minuti, 150);
    assert.equal(L.creaRigaManuale({ ...base, minuti: '45', pezzi: 5 }, dopo).minuti, 45);
    assert.equal(L.creaRigaManuale({ ...base, inizio: '08:00', fine: '10:30', minuti: '45', pezzi: 5 }, dopo).minuti, 45);
    assert.equal(L.creaRigaManuale({ ...base, inizio: '22:00', fine: '06:00', pezzi: 5 }, dopo).minuti, 480);
  });
  test('manuale: rifiuta dati incompleti e date future', () => {
    assert.throws(() => L.creaRigaManuale({ ...base, pezzi: 5 }, dopo), /minuti/);
    assert.throws(() => L.creaRigaManuale({ ...base, minuti: 5, pezzi: '' }, dopo), /pezzi/);
    assert.throws(() => L.creaRigaManuale({ ...base, data: '2026-12-01', minuti: 5, pezzi: 1 }, dopo), /futuro/);
  });
  test('il PIN non si salva in chiaro e si verifica', async () => {
    const d = await L.creaPin('1234');
    assert.ok(!JSON.stringify(d).includes('1234'));
    assert.equal(await L.verificaPin(d, '1234'), true);
    assert.equal(await L.verificaPin(d, '4321'), false);
    assert.equal(await L.verificaPin({}, '1234'), false);
    await assert.rejects(L.creaPin('12'), /4 cifre/);
  });
  test('un invio per dipendente, solo righe da inviare, senza lo stato locale', () => {
    const inv = L.preparaInvii([
      riga({ stato: 'da_inviare' }), riga({ stato: 'da_inviare', dipendente: 'Operatore 2' }),
      riga({ stato: 'inviata', inviataIl: 'x' }), riga({ stato: 'aperta', minuti: null }), riga({ stato: 'da_inviare' }),
    ], 'TAB01');
    assert.deepEqual(inv.map((i) => [i.dipendente, i.righe.length]), [['Operatore 1', 2], ['Operatore 2', 1]]);
    assert.ok(!('stato' in inv[0].righe[0]));
  });
});

describe('unione degli invii', () => {
  const file = (nome, righe, extra = {}) => ({ nome, testo: JSON.stringify({ codiceTablet: 'TAB01', ricevutoIl: '2026-11-03T10:00:00.000Z', righe, ...extra }) });
  test('lo stesso invio arrivato due volte conta una volta sola', () => {
    const r = riga();
    const u = L.unisciInvii([file('RAP_a.json', [r]), file('RAP_a (1).json', [r])]);
    assert.equal(u.righe.length, 1);
    assert.equal(u.doppioni, 1);
    assert.equal(u.conflitti.length, 0);
  });
  test('stesso UUID con contenuto diverso: segnalato, non nascosto', () => {
    const r = riga();
    const u = L.unisciInvii([file('a.json', [r]), file('b.json', [{ ...r, pezzi: 999 }])]);
    assert.equal(u.righe.length, 1);
    assert.equal(u.righe[0].pezzi, r.pezzi);
    assert.equal(u.conflitti.length, 1);
  });
  test('un file rovinato non blocca gli altri', () => {
    const u = L.unisciInvii([{ nome: 'rotto.json', testo: '{"righe":[' }, { nome: 'altro.json', testo: '[]' }, file('buono.json', [riga()])]);
    assert.equal(u.righe.length, 1);
    assert.deepEqual(u.illeggibili.map((x) => x.nome), ['altro.json', 'rotto.json']);
  });
  test('l\'ultimo invio di ogni tablet è quello più recente', () => {
    const u = L.unisciInvii([
      file('a.json', [riga()], { ricevutoIl: '2026-11-03T10:00:00Z' }), file('b.json', [riga()], { ricevutoIl: '2026-11-03T12:00:00Z' }),
      file('c.json', [riga()], { codiceTablet: 'TAB02', ricevutoIl: '2026-11-03T09:00:00Z' }),
    ]);
    assert.equal(u.ultimoPerTablet.TAB01.il, '2026-11-03T12:00:00Z');
    assert.equal(u.ultimoPerTablet.TAB02.il, '2026-11-03T09:00:00Z');
  });
  test('le correzioni stanno sopra: la riga originale non cambia', () => {
    const r = riga();
    const copia = JSON.stringify(r);
    let c = L.aggiornaCorrezione(null, r, { ...r, pezzi: 50 });
    assert.deepEqual(c.correzioni[r.id].campi, { pezzi: 50 });
    const [v] = L.applicaCorrezioni([r], c);
    assert.equal(v.pezzi, 50);
    assert.equal(v._originale.pezzi, 120);
    assert.equal(JSON.stringify(r), copia);
    c = L.segnaEliminata(c, r.id, true);
    assert.equal(L.applicaCorrezioni([r], c)[0]._eliminata, true);
    c = L.segnaEliminata(c, r.id, false);
    assert.equal(L.applicaCorrezioni([r], c)[0].pezzi, 50, 'il ripristino conserva la correzione');
    c = L.aggiornaCorrezione(c, r, { pezzi: r.pezzi });
    assert.equal(c.correzioni[r.id], undefined, 'tornata uguale all\'originale, la correzione sparisce');
  });
  test('segnalazioni: 0 pezzi, oltre 10 ore, non chiusa, commessa sconosciuta', () => {
    const ana = { commesse: [{ codice: '1001' }] };
    const testi = (r) => L.segnalazioni(r, ana).map((s) => s.testo);
    assert.deepEqual(testi(riga()), []);
    assert.deepEqual(testi(riga({ pezzi: 0 })), ['0 pezzi']);
    assert.deepEqual(testi(riga({ minuti: 601 })), ['Oltre 10 ore']);
    assert.deepEqual(testi(riga({ minuti: 600 })), []);
    assert.deepEqual(testi(riga({ minuti: null, pezzi: null })), ['Non chiusa']);
    assert.deepEqual(testi(riga({ commessa: 'X' })), ['Commessa non in anagrafica']);
  });
});

describe('esportazione Excel', () => {
  const rilegge = (wb) => XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array', cellNF: true });
  test('stesse intestazioni e stesso ordine delle colonne A-J del foglio RAPPORTINI', { skip: !fs.existsSync(FILE_DEMO) }, () => {
    const ws = XLSX.readFile(FILE_DEMO).Sheets.RAPPORTINI;
    const vere = 'ABCDEFGHIJ'.split('').map((c) => ws[c + '5'].v);
    assert.deepEqual(L.INTESTAZIONI, vere);
  });
  test('i codici commessa restano testo, senza eccezioni', () => {
    const codici = ['7777', '0042', '06/07/2026', '9/12', '6/6', '1E5', '901/CL', 'OA99-0001', '5390001'];
    const wb = L.creaFileExcel(XLSX, { nuove: codici.map((commessa) => riga({ commessa })), daRiportare: [] });
    const ws = rilegge(wb).Sheets.RAPPORTINI;
    codici.forEach((cod, i) => {
      const c = ws['C' + (i + 2)];
      assert.equal(c.t, 's', cod);
      assert.equal(c.v, cod);
      assert.equal(c.z, '@');
    });
  });
  test('data e ore sono numeri veri nel formato del foglio', () => {
    const ws = rilegge(L.creaFileExcel(XLSX, { nuove: [riga()], daRiportare: [] })).Sheets.RAPPORTINI;
    assert.equal(ws.A2.t, 'n');
    assert.equal(ws.A2.v, 46329, 'stesso numero di giorno usato da Excel per il 03/11/2026');
    assert.equal(ws.A2.z, 'dd/mm/yyyy');
    assert.equal(Math.round(ws.F2.v * 1440), 480);
    assert.equal(Math.round(ws.G2.v * 1440), 615);
    assert.equal(ws.H2.v, 135);
    assert.equal(ws.I2.v, 120);
    assert.equal(XLSX.utils.decode_range(ws['!ref']).e.c, 9, 'si ferma alla colonna J: K-O sono formule del foglio');
  });
  test('solo le righe chiuse, non eliminate e non ancora esportate', () => {
    const a = riga(), b = riga({ minuti: null, pezzi: null }), c = riga({ _eliminata: true }), d = riga();
    const imp = { righe: { [d.id]: { valori: L.valoriRiga(d) } } };
    const p = L.preparaEsportazione([a, b, c, d], [a, b, c, d], imp, { soloNuove: true });
    assert.deepEqual(p.nuove.map((r) => r.id), [a.id]);
    assert.equal(p.daRiportare.length, 0);
    assert.equal(L.preparaEsportazione([a, d], [a, d], imp, { soloNuove: false }).nuove.length, 2);
  });
  test('riga corretta dopo l\'esportazione: non si reincolla, si elenca a parte, una volta sola', () => {
    const a = riga();
    let imp = L.registraEsportazione(null, { nuove: [a], daRiportare: [] }, 'f1.xlsx');
    const corretta = { ...a, pezzi: 99 };
    const p = L.preparaEsportazione([corretta], [corretta], imp);
    assert.equal(p.nuove.length, 0);
    assert.equal(p.daRiportare[0].azione, 'CORREGGI');
    assert.equal(p.daRiportare[0].prima[8], 120);
    assert.equal(p.daRiportare[0].dopo[8], 99);
    imp = L.registraEsportazione(imp, p, 'f2.xlsx');
    assert.equal(L.preparaEsportazione([corretta], [corretta], imp).daRiportare.length, 0);
  });
  test('riga eliminata e poi ripristinata dopo l\'esportazione', () => {
    const a = riga();
    let imp = L.registraEsportazione(null, { nuove: [a], daRiportare: [] }, 'f1.xlsx');
    const el = { ...a, _eliminata: true };
    let p = L.preparaEsportazione([el], [el], imp);
    assert.equal(p.daRiportare[0].azione, 'ELIMINA');
    imp = L.registraEsportazione(imp, p, 'f2.xlsx');
    assert.equal(L.preparaEsportazione([el], [el], imp).daRiportare.length, 0);
    p = L.preparaEsportazione([a], [a], imp);
    assert.equal(p.daRiportare[0].azione, 'RIMETTI');
  });
  test('una correzione fuori dal filtro non si perde', () => {
    const a = riga();
    const imp = L.registraEsportazione(null, { nuove: [a], daRiportare: [] }, 'f.xlsx');
    assert.equal(L.preparaEsportazione([], [{ ...a, pezzi: 1 }], imp).daRiportare.length, 1);
  });
});

describe('anagrafiche', () => {
  test('i codici diventano sempre testo, anche se nel file sono numeri', () => {
    const a = L.normalizzaAnagrafiche({ commesse: [{ codice: 7777 }, { codice: '  0042 ' }, { codice: '' }], lavorazioni: [], dipendenti: [] });
    assert.deepEqual(a.commesse.map((c) => c.codice), ['7777', '0042']);
  });
  test('un file senza il formato giusto si rifiuta', () => {
    assert.throws(() => L.normalizzaAnagrafiche({ commesse: [] }), /formato/);
    assert.throws(() => L.normalizzaAnagrafiche(null), /formato/);
  });
  test('sembraData riconosce i codici danneggiati, e solo quelli', () => {
    for (const c of ['06/07/2026', '15/06/2026', '6/6/26']) assert.equal(L.sembraData(c), true, c);
    for (const c of ['7777', '901/CL', 'OA99-0001', '9001/TPOF', '9/12']) assert.equal(L.sembraData(c), false, c);
  });
  test('importa dal file Excel di prova', { skip: !fs.existsSync(FILE_DEMO) }, () => {
    const wb = XLSX.readFile(FILE_DEMO, { cellNF: true });
    const d = L.leggiAnagraficheDaExcel(XLSX, wb);
    assert.equal(d.commesse.length, 194);
    assert.ok(d.commesse.every((c) => typeof c.codice === 'string'));
    assert.ok(d.lavorazioni.length >= 10);
    assert.ok(d.lavorazioni.some((l) => l.contaPezziFiniti));
    assert.equal(d.avvisi.filter((x) => x.includes('aspetto di una data')).length, 4, 'i 4 codici danneggiati si segnalano');
    assert.ok(d.commesse.some((c) => c.codice === '06/07/2026'), 'e restano come sono');
  });
  test('una cella numerica o data non viene mai convertita in un numero di giorno', () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['N° COMMESSA', 'CLIENTE', 'STATO']]);
    ws.A2 = { t: 'n', v: 46210, z: 'dd/mm/yyyy', w: '06/07/2026' }; ws.B2 = { t: 's', v: 'X' };
    ws.A3 = { t: 'n', v: 7777, w: '7777' }; ws.C3 = { t: 's', v: 'CHIUSA' };
    ws['!ref'] = 'A1:C3';
    XLSX.utils.book_append_sheet(wb, ws, 'COMMESSE');
    const d = L.leggiAnagraficheDaExcel(XLSX, wb);
    assert.deepEqual(d.commesse.map((c) => [c.codice, c.attiva]), [['06/07/2026', true], ['7777', false]]);
    assert.ok(d.avvisi.some((a) => a.includes('non è scritto come testo')));
  });
  test('reimportare non cancella niente e non tocca i PIN', () => {
    const a = { commesse: [{ codice: 'A', cliente: 'vecchio' }, { codice: 'B' }], lavorazioni: [], dipendenti: [{ nome: 'Op', pinSale: 's', pinHash: 'h' }] };
    const { anagrafiche: r, conteggio } = L.unisciAnagrafiche(a, { commesse: [{ codice: 'A', cliente: 'nuovo' }, { codice: 'C' }], lavorazioni: [], dipendenti: [{ nome: 'Op', reparto: 'R', attivo: true }, { nome: 'Nuovo', attivo: true }] });
    assert.deepEqual(r.commesse.map((c) => c.codice), ['A', 'B', 'C']);
    assert.equal(r.commesse[0].cliente, 'nuovo');
    assert.equal(r.dipendenti[0].pinHash, 'h');
    assert.equal(r.dipendenti[1].pinHash, null);
    assert.deepEqual([conteggio.commesseNuove, conteggio.commesseAggiornate, conteggio.dipendentiNuovi], [1, 1, 1]);
  });
});

describe('Codice.gs (il file vero, su un finto Drive)', () => {
  function prepara() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-gs-'));
    for (const d of ['anagrafiche', 'invii', 'ufficio']) fs.mkdirSync(path.join(dir, d));
    const s = caricaScript({ cartella: dir, token: 'segreto' });
    const post = (b) => JSON.parse(s.doPost({ postData: { contents: JSON.stringify(b) } }).testo);
    const get = (p) => JSON.parse(s.doGet({ parameter: p }).testo);
    const invii = () => fs.readdirSync(path.join(dir, 'invii'));
    return { dir, post, get, invii };
  }
  const buono = () => ({ token: 'segreto', codiceTablet: 'TAB01', dipendente: 'Operatore 1', righe: [riga()] });

  test('crea un file col nome previsto e risponde con gli ID', () => {
    const { post, invii, dir } = prepara();
    const b = buono();
    const r = post(b);
    assert.equal(r.ok, true);
    assert.deepEqual([...r.idRicevuti], [b.righe[0].id]);
    assert.match(invii()[0], /^RAP_TAB01_Operatore-1_\d{8}-\d{6}\.json$/);
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'invii', invii()[0]), 'utf8'));
    assert.equal(c.righe[0].id, b.righe[0].id);
    assert.ok(c.ricevutoIl);
    assert.ok(!JSON.stringify(c).includes('segreto'), 'il token non finisce nel file');
  });
  test('senza token giusto non scrive niente', () => {
    const { post, invii } = prepara();
    for (const token of ['sbagliato', undefined, '', null]) {
      const r = post({ ...buono(), token });
      assert.equal(r.ok, false);
      assert.match(r.errore, /Token/);
    }
    assert.equal(invii().length, 0);
  });
  test('rifiuta invii malformati', () => {
    const { post, invii } = prepara();
    for (const b of [{ codiceTablet: '../x' }, { codiceTablet: '' }, { dipendente: ' ' }, { righe: [] }, { righe: 'x' }, { righe: [{ id: 'non-uuid' }] }, { righe: [null] }]) {
      assert.equal(post({ ...buono(), ...b }).ok, false, JSON.stringify(b));
    }
    assert.equal(invii().length, 0);
  });
  test('un nome strano non può uscire dalla cartella', () => {
    const { post, invii } = prepara();
    assert.equal(post({ ...buono(), dipendente: '../../etc/passwd' }).ok, true);
    assert.ok(!invii()[0].includes('/'));
  });
  test('un corpo che non è JSON dà un errore ordinato', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-gs-'));
    const s = caricaScript({ cartella: dir, token: 'x' });
    assert.equal(JSON.parse(s.doPost({ postData: { contents: 'non json' } }).testo).ok, false);
  });
  test('due invii nello stesso secondo non si sovrascrivono', () => {
    const { post, invii } = prepara();
    post(buono()); post(buono()); post(buono());
    assert.equal(invii().length, 3);
  });
  test('doGet restituisce le anagrafiche solo col token', () => {
    const { get, dir } = prepara();
    assert.match(get({}).errore, /Token/);
    assert.match(get({ token: 'segreto' }).errore, /non esiste/);
    fs.writeFileSync(path.join(dir, 'anagrafiche', 'anagrafiche.json'), JSON.stringify({ commesse: [{ codice: '0042' }] }));
    assert.equal(get({ token: 'segreto' }).anagrafiche.commesse[0].codice, '0042');
  });
  test('un messaggio d\'errore chiaro se manca la sottocartella', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-gs-'));
    const s = caricaScript({ cartella: dir, token: 'segreto' });
    const r = JSON.parse(s.doPost({ postData: { contents: JSON.stringify(buono()) } }).testo);
    assert.match(r.errore, /sottocartella/);
    s.prepara();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['anagrafiche', 'invii', 'ufficio']);
  });
  test('nel codice non esistono chiamate che modificano o cancellano file', () => {
    const codice = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Codice.gs'), 'utf8');
    assert.doesNotMatch(codice, /setContent|setTrashed|removeFile|\.moveTo\(|setName|\.remove\(/);
  });
});
