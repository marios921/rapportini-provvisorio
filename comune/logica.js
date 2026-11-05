/*
 * Logica condivisa tra app TABLET, app UFFICIO e test automatici.
 * Nessun accesso a schermo, rete o disco: solo dati in ingresso e dati in uscita.
 * È uno script classico (non un modulo) perché l'app ufficio si apre anche da file://,
 * dove il browser non carica i moduli JavaScript.
 *
 * FORMATO DI UNA RIGA (stessi nomi di campo di righe_rapportino nella piattaforma definitiva):
 *   id              UUID generato sul tablet: non cambia mai, serve a togliere i doppioni e alla migrazione
 *   data            'AAAA-MM-GG' (giorno in cui è iniziata la lavorazione)
 *   dipendente      testo
 *   commessa        testo, SEMPRE testo: mai numero, mai data
 *   codiceArticolo  testo
 *   lavorazione     testo
 *   inizioMinuti    minuti dalla mezzanotte, oppure null
 *   fineMinuti      minuti dalla mezzanotte, oppure null
 *   minuti          durata, oppure null se la lavorazione è ancora aperta
 *   pezzi           numero, oppure null se la lavorazione è ancora aperta
 *   note            testo
 *   origine         sempre 'tablet'
 * Campi in più, che servono solo qui: manuale, codiceTablet, inizioIl, fineIl, creatoIl.
 */
(function (radice, fabbrica) {
  const modulo = fabbrica();
  if (typeof module === 'object' && module.exports) module.exports = modulo;
  else radice.Logica = modulo;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SOGLIA_ORE_MINUTI = 600; // 10 ore
  const INTESTAZIONI = ['DATA', 'DIPENDENTE', 'N° COMMESSA', 'CODICE ARTICOLO', 'LAVORAZIONE ESEGUITA', 'INIZIO', 'FINE', 'MINUTI', 'PEZZI', 'NOTE'];

  /* ---------- piccole utilità ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const dataISO = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const oggiISO = () => dataISO(new Date());
  const oraDaMinuti = (m) => (m == null ? '' : pad2(Math.floor(m / 60) % 24) + ':' + pad2(m % 60));
  const fmtData = (s) => { if (!s) return ''; const [a, m, g] = String(s).split('-'); return g + '/' + m + '/' + a; };
  const fmtDurata = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor((s % 3600) / 60)) + ':' + pad2(s % 60); };
  const fmtMinuti = (m) => (m == null ? '–' : Math.floor(m / 60) + 'h ' + pad2(Math.round(m % 60)) + "'");
  const fmtNumero = (n) => Number(n || 0).toLocaleString('it-IT');
  /** "1 riga", "3 righe": il singolare e il plurale giusti. */
  const conteggio = (n, uno, molti) => n + ' ' + (n === 1 ? uno : molti);
  const fmtOre = (m) => (m / 60).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  /** Da "08:30" ai minuti dalla mezzanotte; null se il testo non è un'ora valida. */
  function minutiDaOra(t) {
    const x = String(t ?? '').match(/^(\d{1,2}):(\d{2})/);
    if (!x) return null;
    const h = Number(x[1]), m = Number(x[2]);
    return h < 24 && m < 60 ? h * 60 + m : null;
  }

  /** Errore con un messaggio che si può mostrare così com'è all'utente. */
  function errore(messaggio) { const e = new Error(messaggio); e.perUtente = true; return e; }

  function numeroValido(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function nuovoUuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // Tablet con sistema vecchio: stesso formato, generato a mano
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /* ---------- PIN: nel file c'è solo l'impronta, mai il PIN in chiaro ---------- */
  async function impronta(sale, pin) {
    const dati = new TextEncoder().encode(sale + ':' + pin);
    const hash = await crypto.subtle.digest('SHA-256', dati);
    return Array.from(new Uint8Array(hash), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  async function creaPin(pin) {
    if (!/^\d{4}$/.test(String(pin))) throw errore('Il PIN deve essere di 4 cifre.');
    const sale = nuovoUuid();
    return { pinSale: sale, pinHash: await impronta(sale, pin) };
  }
  async function verificaPin(dipendente, pin) {
    if (!dipendente || !dipendente.pinHash) return false;
    return (await impronta(dipendente.pinSale, pin)) === dipendente.pinHash;
  }

  /* ---------- ANAGRAFICHE ---------- */
  /** Un codice che ha l'aspetto di una data va segnalato: di solito è un danno fatto da Excel. */
  const sembraData = (codice) => /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(String(codice ?? '').trim());
  const testo = (v) => String(v ?? '').trim();

  /** Controlla e ripulisce il contenuto di anagrafiche.json. I codici commessa diventano sempre testo. */
  function normalizzaAnagrafiche(a) {
    if (!a || !Array.isArray(a.commesse) || !Array.isArray(a.lavorazioni) || !Array.isArray(a.dipendenti)) {
      throw errore('Il file delle anagrafiche non ha il formato atteso (commesse, lavorazioni, dipendenti).');
    }
    return {
      versione: 1,
      azienda: testo(a.azienda),
      aggiornatoIl: a.aggiornatoIl || null,
      commesse: a.commesse.map((c) => ({
        codice: testo(c.codice),
        cliente: testo(c.cliente),
        descrizione: testo(c.descrizione),
        pezziOrdine: numeroValido(c.pezziOrdine),
        attiva: c.attiva !== false,
      })).filter((c) => c.codice),
      lavorazioni: a.lavorazioni.map((l) => ({
        nome: testo(l.nome),
        contaPezziFiniti: !!l.contaPezziFiniti,
        attiva: l.attiva !== false,
      })).filter((l) => l.nome),
      dipendenti: a.dipendenti.map((d) => ({
        nome: testo(d.nome),
        reparto: testo(d.reparto),
        attivo: d.attivo !== false,
        pinSale: d.pinSale || null,
        pinHash: d.pinHash || null,
      })).filter((d) => d.nome),
    };
  }

  /** Testo mostrato da Excel nella cella: per i codici commessa non si usa mai il valore numerico. */
  function testoCella(cella) {
    if (!cella) return '';
    if (cella.t === 's') return testo(cella.v);
    return testo(cella.w ?? cella.v);
  }

  /**
   * Legge commesse, lavorazioni e dipendenti dal file Excel dei rapportini.
   * Restituisce anche gli avvisi: i codici con aspetto di data si segnalano, non si correggono.
   */
  function leggiAnagraficheDaExcel(XLSX, wb) {
    const trovaFoglio = (nome) => { const n = wb.SheetNames.find((s) => s.trim().toUpperCase() === nome); return n ? wb.Sheets[n] : null; };
    const fc = trovaFoglio('COMMESSE'), fd = trovaFoglio('DIPENDENTI'), fp = trovaFoglio('PARAMETRI');
    if (!fc) throw errore('Nel file manca il foglio COMMESSE.');
    const cella = (f, r, c) => f[XLSX.utils.encode_cell({ r, c })];
    const chiave = (c) => testoCella(c).toUpperCase().replace(/\s+/g, ' ');

    function intestazione(f, obbligatoria) {
      const area = XLSX.utils.decode_range(f['!ref']);
      for (let r = area.s.r; r <= Math.min(area.e.r, 15); r++) {
        const mappa = {};
        for (let c = area.s.c; c <= area.e.c; c++) { const k = chiave(cella(f, r, c)); if (k && !(k in mappa)) mappa[k] = c; }
        if (obbligatoria in mappa) return { riga: r, mappa, ultima: area.e.r };
      }
      return null;
    }

    const avvisi = [];
    const commesse = [], lavorazioni = [], dipendenti = [];
    const ic = intestazione(fc, 'N° COMMESSA');
    if (!ic) throw errore('Nel foglio COMMESSE manca l\'intestazione "N° COMMESSA".');
    const visti = new Set();
    for (let r = ic.riga + 1; r <= ic.ultima; r++) {
      const c0 = cella(fc, r, ic.mappa['N° COMMESSA']);
      const codice = testoCella(c0);
      if (!codice) continue;
      if (visti.has(codice)) { avvisi.push(`Riga ${r + 1}: il codice commessa "${codice}" è ripetuto, tengo solo il primo.`); continue; }
      visti.add(codice);
      if (c0.t !== 's') avvisi.push(`Riga ${r + 1}: il codice "${codice}" in Excel non è scritto come testo.`);
      if (sembraData(codice)) avvisi.push(`Riga ${r + 1}: il codice "${codice}" ha l'aspetto di una data. L'ho lasciato com'è: controllalo.`);
      const stato = chiave(cella(fc, r, ic.mappa['STATO']));
      const pezzi = cella(fc, r, ic.mappa['PEZZI ORDINE']);
      commesse.push({
        codice,
        cliente: testoCella(cella(fc, r, ic.mappa['CLIENTE'])),
        descrizione: testoCella(cella(fc, r, ic.mappa['DESCRIZIONE'])),
        pezziOrdine: pezzi && pezzi.t === 'n' ? pezzi.v : null,
        attiva: stato === '' || stato === 'APERTA',
      });
    }
    if (fd) {
      const id = intestazione(fd, 'NOME');
      if (id) for (let r = id.riga + 1; r <= id.ultima; r++) {
        const nome = testoCella(cella(fd, r, id.mappa['NOME']));
        if (!nome) continue;
        const attivo = chiave(cella(fd, r, id.mappa['ATTIVO']));
        dipendenti.push({ nome, reparto: testoCella(cella(fd, r, id.mappa['REPARTO'])), attivo: attivo !== 'NO' });
      }
    }
    if (fp && fp['!ref']) {
      const area = XLSX.utils.decode_range(fp['!ref']);
      let colonna = -1, riga = -1;
      for (let r = area.s.r; r <= area.e.r && colonna < 0; r++) {
        for (let c = area.s.c; c <= area.e.c; c++) if (chiave(cella(fp, r, c)).startsWith('LAVORAZIONI')) { colonna = c; riga = r; break; }
      }
      if (colonna >= 0) for (let r = riga + 1; r <= area.e.r; r++) {
        const nome = testoCella(cella(fp, r, colonna));
        if (nome) lavorazioni.push({ nome, contaPezziFiniti: chiave(cella(fp, r, colonna + 1)) === 'SI', attiva: true });
      }
    }
    return { commesse, lavorazioni, dipendenti, avvisi };
  }

  /**
   * Unisce i dati letti da Excel a quelli esistenti: aggiunge e aggiorna, non cancella niente
   * e non tocca mai i PIN già impostati.
   */
  function unisciAnagrafiche(attuali, importate) {
    const r = normalizzaAnagrafiche(attuali);
    const conteggio = { commesseNuove: 0, commesseAggiornate: 0, lavorazioniNuove: 0, dipendentiNuovi: 0 };
    for (const c of importate.commesse) {
      const e = r.commesse.find((x) => x.codice === c.codice);
      if (e) { Object.assign(e, c); conteggio.commesseAggiornate++; } else { r.commesse.push({ ...c }); conteggio.commesseNuove++; }
    }
    for (const l of importate.lavorazioni) {
      const e = r.lavorazioni.find((x) => x.nome === l.nome);
      if (e) e.contaPezziFiniti = l.contaPezziFiniti; else { r.lavorazioni.push({ ...l }); conteggio.lavorazioniNuove++; }
    }
    for (const d of importate.dipendenti) {
      const e = r.dipendenti.find((x) => x.nome === d.nome);
      if (e) { e.reparto = d.reparto; e.attivo = d.attivo; } else { r.dipendenti.push({ ...d, pinSale: null, pinHash: null }); conteggio.dipendentiNuovi++; }
    }
    return { anagrafiche: r, conteggio };
  }

  /* ---------- TABLET: creazione e chiusura delle righe ---------- */
  function creaRigaCronometro({ dipendente, commessa, lavorazione, codiceArticolo, codiceTablet }, adesso = new Date()) {
    return {
      id: nuovoUuid(), data: dataISO(adesso), dipendente, commessa: String(commessa), codiceArticolo: codiceArticolo || '',
      lavorazione, inizioMinuti: adesso.getHours() * 60 + adesso.getMinutes(), fineMinuti: null, minuti: null, pezzi: null, note: '',
      origine: 'tablet', manuale: false, codiceTablet, inizioIl: adesso.toISOString(), fineIl: null, creatoIl: adesso.toISOString(),
    };
  }

  /** Ora di fine da proporre: quella attuale, ma vuota se la lavorazione è di un giorno precedente. */
  const oraFineProposta = (riga, adesso = new Date()) => (riga.data === dataISO(adesso) ? oraDaMinuti(adesso.getHours() * 60 + adesso.getMinutes()) : '');

  /** Chiude una lavorazione avviata col cronometro. Se la fine è prima dell'inizio vuol dire il giorno dopo. */
  function chiudiRiga(riga, { oraFine, pezzi, note }, adesso = new Date()) {
    const nPezzi = numeroValido(pezzi);
    if (nPezzi == null) throw errore('Inserisci i pezzi fatti (anche 0).');
    const mFine = minutiDaOra(oraFine);
    if (mFine == null) throw errore('Inserisci l’ora di fine.');
    const ini = new Date(riga.inizioIl);
    ini.setSeconds(0, 0);
    const fine = new Date(ini.getFullYear(), ini.getMonth(), ini.getDate(), Math.floor(mFine / 60), mFine % 60);
    if (fine < ini) fine.setDate(fine.getDate() + 1);
    if (fine.getTime() > adesso.getTime() + 60000) throw errore('L’ora di fine è nel futuro: controllala.');
    return {
      ...riga,
      fineMinuti: mFine, minuti: Math.round((fine - ini) / 60000), pezzi: nPezzi,
      note: testo(note), fineIl: fine.toISOString(),
    };
  }

  /** Riga inserita a mano: inizio/fine oppure minuti. Se ci sono entrambi valgono i minuti, come in Excel. */
  function creaRigaManuale({ data, dipendente, commessa, lavorazione, codiceArticolo, inizio, fine, minuti, pezzi, note, codiceTablet }, adesso = new Date()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data))) throw errore('Inserisci la data.');
    if (data > dataISO(adesso)) throw errore('La data è nel futuro: controllala.');
    const nPezzi = numeroValido(pezzi);
    if (nPezzi == null) throw errore('Inserisci i pezzi fatti (anche 0).');
    const a = minutiDaOra(inizio), b = minutiDaOra(fine);
    let m = numeroValido(minuti);
    if (m == null && a != null && b != null) m = (b - a + 1440) % 1440;
    if (!m) throw errore('Inserisci inizio e fine, oppure i minuti.');
    const momento = (min, giorni = 0) => { const [y, mo, g] = data.split('-').map(Number); return new Date(y, mo - 1, g + giorni, Math.floor(min / 60), min % 60).toISOString(); };
    return {
      id: nuovoUuid(), data, dipendente, commessa: String(commessa), codiceArticolo: codiceArticolo || '', lavorazione,
      inizioMinuti: a, fineMinuti: b, minuti: m, pezzi: nPezzi, note: testo(note), origine: 'tablet', manuale: true, codiceTablet,
      inizioIl: a != null ? momento(a) : null, fineIl: b != null ? momento(b, a != null && b < a ? 1 : 0) : null, creatoIl: adesso.toISOString(),
    };
  }

  /** Avviso per una lavorazione ancora aperta: rimasta da un giorno precedente o da oltre 10 ore. */
  function avvisoAperta(riga, adesso = new Date()) {
    if (riga.minuti != null) return null;
    if (riga.data !== dataISO(adesso)) return 'giorno-precedente';
    if (adesso - new Date(riga.inizioIl) > SOGLIA_ORE_MINUTI * 60000) return 'oltre-10-ore';
    return null;
  }

  /** Divide le righe per dipendente: ogni invio riguarda un solo dipendente e crea un solo file. */
  function preparaInvii(righe, codiceTablet) {
    const gruppi = new Map();
    for (const r of righe) {
      if (r.stato !== 'da_inviare') continue;
      const { stato, inviataIl, ...pulita } = r; // lo stato di invio riguarda solo questo tablet
      if (!gruppi.has(r.dipendente)) gruppi.set(r.dipendente, []);
      gruppi.get(r.dipendente).push(pulita);
    }
    return [...gruppi].map(([dipendente, lista]) => ({ codiceTablet, dipendente, righe: lista }));
  }

  /* ---------- UFFICIO: lettura e unione degli invii ---------- */
  /**
   * Riceve i file di /invii/ come {nome, testo}, unisce le righe e scarta i doppioni per UUID.
   * Un file illeggibile non blocca gli altri: viene segnalato.
   */
  function unisciInvii(file) {
    const perId = new Map();
    const illeggibili = [], conflitti = [], ultimoPerTablet = {};
    let doppioni = 0;
    const ordinati = [...file].sort((a, b) => (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0));
    for (const f of ordinati) {
      let c;
      try { c = JSON.parse(f.testo); } catch { illeggibili.push({ nome: f.nome, motivo: 'contenuto non leggibile (forse ancora in sincronizzazione)' }); continue; }
      if (!c || !Array.isArray(c.righe)) { illeggibili.push({ nome: f.nome, motivo: 'non è un file di invio' }); continue; }
      const tablet = c.codiceTablet || '?';
      const quando = c.ricevutoIl || '';
      if (!ultimoPerTablet[tablet] || quando > ultimoPerTablet[tablet].il) ultimoPerTablet[tablet] = { il: quando, file: f.nome, righe: c.righe.length };
      for (const r of c.righe) {
        if (!r || !r.id) { illeggibili.push({ nome: f.nome, motivo: 'contiene una riga senza identificativo' }); continue; }
        const riga = { ...r, commessa: testo(r.commessa), fileOrigine: f.nome, ricevutoIl: quando };
        const prima = perId.get(r.id);
        if (!prima) { perId.set(r.id, riga); continue; }
        doppioni++;
        if (firmaRiga(prima) !== firmaRiga(riga)) conflitti.push({ id: r.id, fileTenuto: prima.fileOrigine, fileScartato: f.nome });
      }
    }
    return { righe: [...perId.values()], doppioni, conflitti, illeggibili, ultimoPerTablet };
  }

  /** Confronta il contenuto di due copie della stessa riga, ignorando il file da cui arrivano. */
  function firmaRiga(r) {
    return JSON.stringify([r.data, r.dipendente, r.commessa, r.codiceArticolo, r.lavorazione, r.inizioMinuti, r.fineMinuti, r.minuti, r.pezzi, r.note]);
  }

  /** Applica correzioni.json in sovrimpressione. Le righe di partenza non vengono toccate. */
  function applicaCorrezioni(righe, correzioni) {
    const elenco = (correzioni && correzioni.correzioni) || {};
    return righe.map((originale) => {
      const c = elenco[originale.id];
      if (!c) return { ...originale, _corretta: false, _eliminata: false, _originale: originale };
      return { ...originale, ...(c.campi || {}), _corretta: Object.keys(c.campi || {}).length > 0, _eliminata: !!c.eliminata, _originale: originale };
    });
  }

  /** Scrive la correzione di una riga: conserva solo i campi diversi dall'originale. */
  function aggiornaCorrezione(correzioni, originale, campiNuovi, adesso = new Date()) {
    const copia = { versione: 1, correzioni: { ...((correzioni && correzioni.correzioni) || {}) } };
    const campi = {};
    for (const k of Object.keys(campiNuovi)) if (campiNuovi[k] !== originale[k]) campi[k] = campiNuovi[k];
    const eliminata = !!(copia.correzioni[originale.id] && copia.correzioni[originale.id].eliminata);
    if (Object.keys(campi).length || eliminata) copia.correzioni[originale.id] = { campi, eliminata, il: adesso.toISOString() };
    else delete copia.correzioni[originale.id];
    return copia;
  }
  /** Segna o toglie l'eliminazione, lasciando intatte le eventuali correzioni. */
  function segnaEliminata(correzioni, id, eliminata, adesso = new Date()) {
    const copia = { versione: 1, correzioni: { ...((correzioni && correzioni.correzioni) || {}) } };
    const campi = (copia.correzioni[id] && copia.correzioni[id].campi) || {};
    if (eliminata || Object.keys(campi).length) copia.correzioni[id] = { campi, eliminata, il: adesso.toISOString() };
    else delete copia.correzioni[id];
    return copia;
  }

  /** Avvisi da evidenziare su una riga nella tabella ufficio. */
  function segnalazioni(r, anagrafiche) {
    const out = [];
    if (r.minuti == null) out.push({ tipo: 'bad', testo: 'Non chiusa' });
    else {
      if (r.minuti > SOGLIA_ORE_MINUTI) out.push({ tipo: 'bad', testo: 'Oltre 10 ore' });
      if (!r.pezzi) out.push({ tipo: 'bad', testo: '0 pezzi' });
    }
    if (anagrafiche && !anagrafiche.commesse.some((c) => c.codice === r.commessa)) out.push({ tipo: 'bad', testo: 'Commessa non in anagrafica' });
    return out;
  }

  function filtraRighe(righe, { dal, al, dipendente, commessa, conEliminate } = {}) {
    const q = testo(commessa).toUpperCase();
    return righe.filter((r) =>
      (conEliminate || !r._eliminata) &&
      (!dal || r.data >= dal) && (!al || r.data <= al) &&
      (!dipendente || r.dipendente === dipendente) &&
      (!q || String(r.commessa).toUpperCase().includes(q)));
  }

  const ordinaRighe = (righe) => [...righe].sort((a, b) =>
    (a.data + pad2(a.inizioMinuti ?? 0).padStart(4, '0') + (a.creatoIl || '')).localeCompare(b.data + pad2(b.inizioMinuti ?? 0).padStart(4, '0') + (b.creatoIl || '')));

  /* ---------- ESPORTAZIONE nel formato del foglio RAPPORTINI ---------- */
  /** I dieci valori (colonne A-J) di una riga: sono ciò che finisce in Excel e ciò che si ricorda in importati.json. */
  function valoriRiga(r) {
    return [r.data, r.dipendente, String(r.commessa), r.codiceArticolo || '', r.lavorazione || '', r.inizioMinuti ?? null, r.fineMinuti ?? null, r.minuti ?? null, r.pezzi ?? null, r.note || ''];
  }

  /**
   * Decide cosa esportare.
   *  - nuove: righe chiuse e non eliminate, ancora mai esportate (oppure tutte, se soloNuove è falso)
   *  - daRiportare: righe GIÀ esportate e poi cambiate. Non si rimettono tra quelle da incollare, perché
   *    in Excel si conterebbero due volte: si elencano a parte, per correggerle a mano nel foglio.
   * righeFiltrate decide le nuove; tutteLeRighe serve a non perdere nessuna correzione fuori dal filtro.
   */
  function preparaEsportazione(righeFiltrate, tutteLeRighe, importati, { soloNuove = true } = {}) {
    const giaFatte = (importati && importati.righe) || {};
    const nuove = ordinaRighe(righeFiltrate.filter((r) => r.minuti != null && !r._eliminata && (!soloNuove || !giaFatte[r.id])));
    const daRiportare = [];
    if (soloNuove) for (const r of ordinaRighe(tutteLeRighe)) {
      const prima = giaFatte[r.id];
      if (!prima) continue;
      const ora = valoriRiga(r);
      if (r._eliminata) { if (!prima.eliminata) daRiportare.push({ azione: 'ELIMINA', riga: r, prima: prima.valori, dopo: null }); continue; }
      if (prima.eliminata) daRiportare.push({ azione: 'RIMETTI', riga: r, prima: null, dopo: ora });
      else if (JSON.stringify(ora) !== JSON.stringify(prima.valori)) daRiportare.push({ azione: 'CORREGGI', riga: r, prima: prima.valori, dopo: ora });
    }
    return { nuove, daRiportare };
  }

  /** Aggiorna importati.json dopo un'esportazione riuscita. */
  function registraEsportazione(importati, { nuove, daRiportare }, nomeFile, adesso = new Date()) {
    const copia = { versione: 1, righe: { ...((importati && importati.righe) || {}) } };
    const il = adesso.toISOString();
    for (const r of nuove) copia.righe[r.id] = { il, file: nomeFile, valori: valoriRiga(r) };
    for (const d of daRiportare) {
      copia.righe[d.riga.id] = d.azione === 'ELIMINA'
        ? { ...copia.righe[d.riga.id], il, file: nomeFile, eliminata: true }
        : { il, file: nomeFile, valori: d.dopo };
    }
    return copia;
  }

  /** Celle Excel di una riga. Data e ore sono numeri veri, il codice commessa è sempre testo. */
  function celleRiga(v) {
    const [a, m, g] = String(v[0]).split('-').map(Number);
    const seriale = (Date.UTC(a, m - 1, g) - Date.UTC(1899, 11, 30)) / 86400000; // numero di giorno come lo vuole Excel, senza fuso orario
    const ora = (min) => (min == null ? null : { t: 'n', v: min / 1440, z: 'hh:mm' });
    const testoC = (s) => ({ t: 's', v: String(s ?? ''), z: '@' });
    return [
      { t: 'n', v: seriale, z: 'dd/mm/yyyy' }, testoC(v[1]), testoC(v[2]), testoC(v[3]), testoC(v[4]),
      ora(v[5]), ora(v[6]),
      v[7] == null ? null : { t: 'n', v: v[7], z: '0' }, v[8] == null ? null : { t: 'n', v: v[8], z: '#,##0' }, testoC(v[9]),
    ];
  }

  /** Costruisce il file Excel: foglio RAPPORTINI (colonne A-J) e, se serve, l'elenco delle correzioni da riportare. */
  function creaFileExcel(XLSX, { nuove, daRiportare }) {
    const wb = XLSX.utils.book_new();
    const aoa = [INTESTAZIONI.slice(), ...nuove.map((r) => celleRiga(valoriRiga(r)))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [11, 14, 13, 18, 28, 8, 8, 8, 8, 30].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, 'RAPPORTINI');
    if (daRiportare.length) {
      const righe = [['COSA FARE', 'QUALE', ...INTESTAZIONI]];
      for (const d of daRiportare) {
        if (d.prima) righe.push([d.azione, 'PRIMA (in Excel)', ...celleRiga(d.prima)]);
        if (d.dopo) righe.push([d.azione, 'DOPO', ...celleRiga(d.dopo)]);
      }
      const w2 = XLSX.utils.aoa_to_sheet(righe);
      w2['!cols'] = [12, 16, 11, 14, 13, 18, 28, 8, 8, 8, 8, 30].map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(wb, w2, 'CORREZIONI_DA_RIPORTARE');
    }
    return wb;
  }

  return {
    SOGLIA_ORE_MINUTI, INTESTAZIONI,
    esc, pad2, dataISO, oggiISO, oraDaMinuti, minutiDaOra, fmtData, fmtDurata, fmtMinuti, fmtNumero, fmtOre, conteggio, errore, numeroValido, nuovoUuid,
    creaPin, verificaPin, sembraData, normalizzaAnagrafiche, leggiAnagraficheDaExcel, unisciAnagrafiche,
    creaRigaCronometro, oraFineProposta, chiudiRiga, creaRigaManuale, avvisoAperta, preparaInvii,
    unisciInvii, firmaRiga, applicaCorrezioni, aggiornaCorrezione, segnaEliminata, segnalazioni, filtraRighe, ordinaRighe,
    valoriRiga, preparaEsportazione, registraEsportazione, creaFileExcel,
  };
});
