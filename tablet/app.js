/*
 * App TABLET. Regola di fondo: ogni dato viene prima scritto in IndexedDB e solo dopo mostrato.
 * Una riga diventa "inviata" solo quando il server conferma il suo ID.
 */
'use strict';
const L = window.Logica;
const { esc, fmtData, fmtMinuti, oraDaMinuti, oggiISO } = L;
const $ = (s) => document.querySelector(s);

const OGNI_MINUTO = 60 * 1000;
const RITENTA_INVIO = OGNI_MINUTO;              // righe in attesa: si riprova ogni minuto
const AGGIORNA_ANAGRAFICHE = 30 * OGNI_MINUTO;
const TEMPO_MASSIMO_RETE = 30 * 1000;

/* ---------- archivio locale (IndexedDB) ---------- */
const Archivio = {
  db: null,
  apri() {
    return new Promise((ok, ko) => {
      const rq = indexedDB.open('rapportino', 1);
      rq.onupgradeneeded = () => {
        rq.result.createObjectStore('righe', { keyPath: 'id' });
        rq.result.createObjectStore('valori');
      };
      rq.onsuccess = () => { this.db = rq.result; ok(); };
      rq.onerror = () => ko(rq.error);
    });
  },
  /** Una sola transazione: o si salvano tutte le righe, o nessuna. La promessa si chiude a dati scritti. */
  _tx(store, modo, fn) {
    return new Promise((ok, ko) => {
      const tx = this.db.transaction(store, modo);
      const rq = fn(tx.objectStore(store));
      tx.oncomplete = () => ok(rq && rq.result);
      tx.onerror = tx.onabort = () => ko(tx.error);
    });
  },
  tutteLeRighe() { return this._tx('righe', 'readonly', (s) => s.getAll()); },
  salvaRighe(righe) { return this._tx('righe', 'readwrite', (s) => { righe.forEach((r) => s.put(r)); }); },
  leggi(k) { return this._tx('valori', 'readonly', (s) => s.get(k)); },
  scrivi(k, v) { return this._tx('valori', 'readwrite', (s) => s.put(v, k)); },
};

/* ---------- stato dell'app ---------- */
const S = {
  config: null,                    // {codiceTablet, url, token}
  anagrafiche: null,
  aggiornateIl: null,
  righe: [],
  ultimoInvio: null,               // {il, righe}
  ultimoErrore: null,
  ultimoErroreAnagrafiche: null,
  vista: 'login',                  // setup | login | home | stato | impostazioni
  utente: null, scelto: null, pin: '', pinErr: '',
  foglio: null,
  setup: {},
};
let invioInCorso = false;

function avviso(msg) {
  const h = $('#toastHost');
  h.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(avviso.t);
  avviso.t = setTimeout(() => { h.innerHTML = ''; }, 3200);
}
const inAttesa = () => S.righe.filter((r) => r.stato === 'da_inviare');
const aperte = (dip) => S.righe.filter((r) => r.stato === 'aperta' && (!dip || r.dipendente === dip));
const dipendentiAttivi = () => (S.anagrafiche ? S.anagrafiche.dipendenti.filter((d) => d.attivo) : []);
const lavorazioniAttive = () => (S.anagrafiche ? S.anagrafiche.lavorazioni.filter((l) => l.attiva) : []);
const commesseAttive = () => (S.anagrafiche ? S.anagrafiche.commesse.filter((c) => c.attiva) : []);
const infoCommessa = (cod) => (S.anagrafiche ? S.anagrafiche.commesse.find((c) => c.codice === cod) : null);
const coloreLav = (nome) => { const i = lavorazioniAttive().findIndex((l) => l.nome === nome); return i < 0 ? 'var(--w3)' : `var(--w${(i % 5) + 1})`; };

/* ---------- comunicazione con lo script Google ---------- */
async function chiamata(url, opzioni = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TEMPO_MASSIMO_RETE);
  try {
    const r = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: ctrl.signal, ...opzioni });
    let dati;
    try { dati = await r.json(); } catch { throw new Error('Risposta non valida dal server: controlla la pubblicazione dello script.'); }
    if (!dati || dati.ok !== true) throw new Error((dati && dati.errore) || 'Il server ha rifiutato la richiesta.');
    return dati;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Il server non ha risposto in tempo.');
    if (e.name === 'TypeError') throw new Error('Rete non disponibile.');
    throw e;
  } finally { clearTimeout(t); }
}

/** Il tipo text/plain è voluto: Apps Script non risponde alla richiesta preliminare che il browser farebbe con application/json. */
function inviaAlServer(config, invio) {
  return chiamata(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: config.token, ...invio }),
  });
}

async function inviaTutto(manuale = false) {
  if (invioInCorso || !S.config) return;
  const invii = L.preparaInvii(S.righe, S.config.codiceTablet);
  if (!invii.length) {
    if (manuale) avviso('Niente da inviare: è già tutto all’ufficio.');
    return;
  }
  invioInCorso = true;
  aggiornaBarra();
  let inviate = 0;
  try {
    for (const invio of invii) {
      const risposta = await inviaAlServer(S.config, invio);
      if (!Array.isArray(risposta.idRicevuti)) throw new Error('Il server non ha confermato le righe.');
      const confermati = new Set(risposta.idRicevuti);
      const adesso = new Date().toISOString();
      const aggiornate = S.righe
        .filter((r) => r.stato === 'da_inviare' && confermati.has(r.id))
        .map((r) => ({ ...r, stato: 'inviata', inviataIl: adesso }));
      await Archivio.salvaRighe(aggiornate);
      const perId = new Map(aggiornate.map((r) => [r.id, r]));
      S.righe = S.righe.map((r) => perId.get(r.id) || r);
      inviate += aggiornate.length;
    }
    S.ultimoErrore = null;
  } catch (e) {
    // Non si perde niente: le righe restano "da inviare" e il tentativo si ripete da solo
    S.ultimoErrore = { il: new Date().toISOString(), messaggio: e.message };
    if (manuale) avviso('Invio non riuscito: ' + e.message + ' Le righe restano sul tablet e riprovo da solo.');
  }
  try {
    if (inviate) {
      S.ultimoInvio = { il: new Date().toISOString(), righe: inviate };
      await Archivio.scrivi('ultimoInvio', S.ultimoInvio);
      if (manuale) avviso(`${L.conteggio(inviate, 'riga inviata', 'righe inviate')} all’ufficio.`);
    }
    await Archivio.scrivi('ultimoErrore', S.ultimoErrore);
  } finally {
    invioInCorso = false; // qualunque cosa succeda, il prossimo tentativo deve poter partire
    aggiornaDopoInvio();
  }
}

async function scaricaAnagrafiche(config = S.config) {
  const u = new URL(config.url);
  u.searchParams.set('token', config.token);
  const r = await chiamata(u.toString());
  const a = L.normalizzaAnagrafiche(r.anagrafiche); // se il file è rovinato tengo la copia che ho già
  await Archivio.scrivi('anagrafiche', a);
  const adesso = new Date().toISOString();
  await Archivio.scrivi('anagraficheIl', adesso);
  S.anagrafiche = a; S.aggiornateIl = adesso; S.ultimoErroreAnagrafiche = null;
  return a;
}
async function aggiornaAnagraficheInSilenzio() {
  if (!S.config) return;
  try {
    await scaricaAnagrafiche();
    // Non ridisegno se qualcuno sta scrivendo: l'elenco nuovo si vedrà al prossimo passaggio
    if (!S.foglio && S.vista === 'login' && !S.scelto) disegna();
  } catch (e) {
    S.ultimoErroreAnagrafiche = e.message;
  }
  aggiornaBarra();
}

/* ---------- barra superiore ---------- */
function barraHtml() {
  return `<header class="top">
    <div class="brand">Rapportino<small>${esc(S.anagrafiche?.azienda || 'REPARTO')} · ${esc(S.config?.codiceTablet || '')}</small></div>
    <span class="sp"></span>
    <span id="barra-stato" class="note-bar"></span>
    <button class="btn small primary" id="invia">Invia all’ufficio</button>
    <span class="clock" id="clock"></span>
  </header>`;
}
function aggiornaBarra() {
  const el = $('#barra-stato');
  if (!el) return;
  const n = inAttesa().length;
  let classe = 'live', testo = 'Tutto inviato';
  if (invioInCorso) { classe = ''; testo = 'Invio in corso…'; }
  else if (n && S.ultimoErrore) { classe = 'bad'; testo = `${n} da inviare · non riuscito, riprovo`; }
  else if (n) { classe = ''; testo = `${n} da inviare`; }
  el.innerHTML = `<span class="dot ${classe}"></span><span id="testo-stato">${esc(testo)}</span>`;
  const b = $('#invia');
  if (b) b.disabled = invioInCorso;
}
/** Dopo un invio non si ridisegna tutto: chi sta scrivendo non deve perdere ciò che ha digitato. */
function aggiornaDopoInvio() {
  aggiornaBarra();
  if (S.vista === 'stato' || (S.vista === 'home' && !S.foglio)) disegna();
}

/* ---------- disegno ---------- */
function disegna() {
  const app = $('#app');
  if (S.vista === 'setup') app.innerHTML = vistaSetup();
  else if (S.vista === 'impostazioni') app.innerHTML = barraHtml() + vistaImpostazioni();
  else if (S.vista === 'stato') app.innerHTML = barraHtml() + vistaStato();
  else if (S.vista === 'home') app.innerHTML = barraHtml() + (S.foglio ? vistaFoglio() : vistaHome());
  else app.innerHTML = barraHtml() + vistaLogin();
  collegaEventi();
  aggiornaBarra();
  tic();
}

/* ---------- prima apertura e impostazioni ---------- */
function vistaSetup() {
  const s = S.setup;
  return `<section class="login"><div><h1>Prima configurazione del tablet</h1>
      <p class="note-bar">Da fare una volta sola, con i dati che trovi nelle istruzioni.</p></div>
    <div class="panel step">
      <div class="step"><label for="s-cod">Codice di questo tablet</label><input class="field mono" id="s-cod" autocomplete="off" autocapitalize="characters" placeholder="es. TAB01" value="${esc(s.codiceTablet || '')}"></div>
      <div class="step"><label for="s-url">Indirizzo dello script</label><input class="field mono" id="s-url" autocomplete="off" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(s.url || '')}"></div>
      <div class="step"><label for="s-tok">Token segreto</label><input class="field mono" id="s-tok" type="password" autocomplete="off" value="${esc(s.token || '')}"></div>
      <div class="err" id="s-err">${esc(s.errore || '')}</div>
      <div class="foot">${S.config ? '<button class="btn ghost xl" id="s-annulla">Annulla</button>' : ''}<button class="btn primary xl" id="s-ok" ${s.provaInCorso ? 'disabled' : ''}>${s.provaInCorso ? 'Provo il collegamento…' : 'Salva e prova il collegamento'}</button></div>
      ${s.puoProseguire ? `<div class="foot"><button class="btn" id="s-comunque">Salva comunque, proverò più tardi</button></div>` : ''}
    </div></section>`;
}
function leggiCampiSetup() {
  S.setup.codiceTablet = $('#s-cod').value.trim().toUpperCase();
  S.setup.url = $('#s-url').value.trim();
  S.setup.token = $('#s-tok').value.trim();
  if (!/^[A-Z0-9_-]{1,20}$/.test(S.setup.codiceTablet)) return 'Il codice tablet può contenere solo lettere, numeri, - e _ (es. TAB01).';
  let u;
  try { u = new URL(S.setup.url); } catch { return 'L’indirizzo dello script non è valido.'; }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return 'L’indirizzo dello script deve iniziare con https://';
  if (!S.setup.token) return 'Inserisci il token.';
  return '';
}
async function salvaConfig(forza) {
  const errore = leggiCampiSetup();
  if (errore) { S.setup.errore = errore; disegna(); return; }
  const config = { codiceTablet: S.setup.codiceTablet, url: S.setup.url, token: S.setup.token };
  if (!forza) {
    S.setup.provaInCorso = true; S.setup.errore = ''; disegna();
    try { await scaricaAnagrafiche(config); }
    catch (e) {
      S.setup.provaInCorso = false; S.setup.errore = 'Collegamento non riuscito: ' + e.message; S.setup.puoProseguire = true;
      disegna();
      return;
    }
  }
  await Archivio.scrivi('config', config);
  S.config = config; S.setup = {}; S.vista = 'login';
  disegna();
  inviaTutto();
}
function vistaImpostazioni() {
  return `<section class="login"><div class="panel step">
      <h2>Impostazioni del tablet</h2>
      <p>Codice tablet: <b class="mono">${esc(S.config.codiceTablet)}</b><br>Script: <span class="mono" style="overflow-wrap:anywhere">${esc(S.config.url)}</span></p>
      <div class="step"><label for="i-tok">Per modificare, scrivi il token attuale</label><input class="field mono" id="i-tok" type="password" autocomplete="off"></div>
      <div class="err" id="i-err"></div>
      <div class="foot"><button class="btn ghost" id="i-x">Indietro</button><button class="btn" id="i-mod">Modifica impostazioni</button></div>
    </div></section>`;
}

/* ---------- login ---------- */
function vistaLogin() {
  if (!S.anagrafiche) {
    return `<section class="login"><div><h1>Mancano le anagrafiche</h1>
      <p>Il tablet non ha ancora scaricato l’elenco di dipendenti e commesse.${S.ultimoErroreAnagrafiche ? ' Ultimo errore: ' + esc(S.ultimoErroreAnagrafiche) : ''}</p></div>
      <div class="foot"><button class="btn" id="vai-imp">Impostazioni</button><button class="btn primary" id="agg-ana">Scarica ora</button></div></section>`;
  }
  const dip = dipendentiAttivi();
  return `<section class="login">
    <div><h1>Chi sta lavorando?</h1><p class="note-bar">Tocca il tuo nome e inserisci il PIN.</p></div>
    <div class="people">${dip.map((d) => {
      const lista = aperte(d.nome);
      const dimenticate = lista.filter((r) => L.avvisoAperta(r)).length;
      return `<button class="person" data-dip="${esc(d.nome)}" aria-pressed="${S.scelto === d.nome}"><b>${esc(d.nome)}</b>${
        dimenticate ? `<span class="chip bad">${dimenticate} da chiudere</span>` : lista.length ? `<span class="chip run">${lista.length} in corso</span>` : '<span>—</span>'}</button>`;
    }).join('') || '<p class="empty">Nessun dipendente attivo in anagrafica.</p>'}</div>
    ${S.scelto ? pinBox() : ''}
    <div class="foot"><span class="note-bar">Anagrafiche del ${S.aggiornateIl ? new Date(S.aggiornateIl).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</span>
      <button class="btn small ghost" id="agg-ana">Aggiorna anagrafiche</button>
      <button class="btn small ghost" id="vai-stato">Stato invii</button>
      <button class="btn small ghost" id="vai-imp">Impostazioni</button></div>
  </section>`;
}
function pinBox() {
  const d = S.anagrafiche.dipendenti.find((x) => x.nome === S.scelto);
  if (!d || !d.pinHash) return `<div class="pinbox"><div class="err">Per ${esc(S.scelto)} non è impostato un PIN: chiedi all’ufficio.</div></div>`;
  return `<div class="pinbox">
    <div class="lbl">PIN di ${esc(S.scelto)}</div>
    <div class="pindots">${[0, 1, 2, 3].map((i) => `<i class="${i < S.pin.length ? 'on' : ''}"></i>`).join('')}</div>
    <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}<button data-k="C" aria-label="Cancella">⌫</button><button data-k="0">0</button><button data-k="X" aria-label="Annulla">✕</button></div>
    <div class="err">${esc(S.pinErr)}</div>
  </div>`;
}
async function tastoPin(k) {
  if (k === 'X') { S.scelto = null; S.pin = ''; S.pinErr = ''; disegna(); return; }
  if (k === 'C') { S.pin = S.pin.slice(0, -1); disegna(); return; }
  if (S.pin.length < 4) S.pin += k;
  if (S.pin.length === 4) {
    const d = S.anagrafiche.dipendenti.find((x) => x.nome === S.scelto);
    if (await L.verificaPin(d, S.pin)) { S.utente = S.scelto; S.scelto = null; S.vista = 'home'; S.pinErr = ''; }
    else S.pinErr = 'PIN errato, riprova.';
    S.pin = '';
  }
  disegna();
}

/* ---------- home del dipendente ---------- */
function vistaHome() {
  const oggi = oggiISO();
  const inCorso = aperte(S.utente).sort((a, b) => a.inizioIl.localeCompare(b.inizioIl));
  const chiuse = S.righe.filter((r) => r.dipendente === S.utente && r.data === oggi && r.stato !== 'aperta').sort((a, b) => b.creatoIl.localeCompare(a.creatoIl));
  const totMin = chiuse.reduce((s, r) => s + (r.minuti || 0), 0), totPz = chiuse.reduce((s, r) => s + (r.pezzi || 0), 0);
  return `<div class="actions">
      <button class="btn primary xl" id="nuova">＋ Nuova lavorazione</button>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn xl" id="manuale">Inserisci a mano</button>
        <button class="btn xl ghost" id="vai-stato">Stato invii</button>
        <button class="btn ghost xl" id="esci">Esci · ${esc(S.utente)}</button>
      </div>
    </div>
    <div class="grid2">
      <section class="panel"><h2>In corso <span class="count">${inCorso.length ? L.conteggio(inCorso.length, 'aperta', 'aperte') : ''}</span></h2>
        ${inCorso.length ? inCorso.map(schedaInCorso).join('') : '<p class="empty">Nessuna lavorazione in corso. Premi <b>Nuova lavorazione</b> per avviare il cronometro.</p>'}
      </section>
      <section class="panel"><h2>Oggi <span class="count">${fmtData(oggi)}</span></h2>
        ${chiuse.length ? `<div class="list">${chiuse.map(rigaChiusa).join('')}</div>
        <div class="tot"><span>Tempo <b>${fmtMinuti(totMin)}</b></span><span>Pezzi <b>${totPz}</b></span><span>Righe <b>${chiuse.length}</b></span></div>` : '<p class="empty">Le lavorazioni chiuse oggi compaiono qui.</p>'}
      </section>
    </div>`;
}
function schedaInCorso(r) {
  const c = infoCommessa(r.commessa);
  const a = L.avvisoAperta(r);
  const giorno = r.data !== oggiISO();
  return `<article class="run-card">
    <div><div class="com">${esc(r.commessa)}</div><div class="meta">${esc(c ? c.cliente : '')} · ${esc(r.lavorazione)}${r.codiceArticolo ? ' · art. ' + esc(r.codiceArticolo) : ''}</div><div class="meta">Iniziata alle ${oraDaMinuti(r.inizioMinuti)}${giorno ? ' del ' + fmtData(r.data) : ''}</div></div>
    <div class="timer" data-da="${esc(r.inizioIl)}">00:00:00</div>
    ${a ? `<div class="warn">${a === 'giorno-precedente' ? 'Lavorazione rimasta aperta da un giorno precedente: chiudila indicando l’ora di fine reale.' : 'Aperta da più di 10 ore: controlla che non sia stata dimenticata.'}</div>` : ''}
    <button class="btn run" data-chiudi="${esc(r.id)}">■ Fine lavorazione — inserisci pezzi</button>
  </article>`;
}
const chipStato = (r) => (r.stato === 'inviata' ? '<span class="chip ok">Inviata</span>' : r.stato === 'aperta' ? '<span class="chip run">In corso</span>' : '<span class="chip run">Da inviare</span>');
function rigaChiusa(r) {
  return `<div class="row"><span class="t">${r.inizioMinuti != null ? oraDaMinuti(r.inizioMinuti) + '<br>' + oraDaMinuti(r.fineMinuti) : 'man.'}</span>
    <span class="c">${esc(r.commessa)}</span><span class="n">${r.pezzi ?? 0}<small>pz · ${fmtMinuti(r.minuti)}</small></span>
    <span class="l"><i class="wire" style="background:${coloreLav(r.lavorazione)};height:10px;width:10px;border-radius:2px;margin-right:6px"></i>${esc(r.lavorazione)} ${chipStato(r)}</span></div>`;
}

/* ---------- pagina Stato invii ---------- */
function vistaStato() {
  const ultime = [...S.righe].sort((a, b) => b.creatoIl.localeCompare(a.creatoIl)).slice(0, 50);
  const n = inAttesa().length;
  const quando = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  return `<div class="kpis">
      <div class="kpi ${n ? 'alert' : ''}"><span>Da inviare</span><b id="n-da-inviare">${n}</b></div>
      <div class="kpi"><span>Aperte</span><b>${aperte().length}</b></div>
      <div class="kpi"><span>Ultimo invio riuscito</span><b style="font-size:20px">${quando(S.ultimoInvio?.il)}</b></div>
    </div>
    ${S.ultimoErrore ? `<div class="warn banner">Ultimo tentativo non riuscito (${quando(S.ultimoErrore.il)}): ${esc(S.ultimoErrore.messaggio)} Le righe sono al sicuro sul tablet.</div>` : ''}
    <div class="panel"><h2>Ultime righe <span class="count">al massimo 50</span></h2>
      <div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Dipendente</th><th>Commessa</th><th>Lavorazione</th><th class="num">Minuti</th><th class="num">Pezzi</th><th>Stato</th></tr></thead>
      <tbody>${ultime.map((r) => `<tr><td class="mono">${fmtData(r.data)}</td><td>${esc(r.dipendente)}</td><td class="mono"><b>${esc(r.commessa)}</b></td><td>${esc(r.lavorazione)}</td><td class="num">${r.minuti ?? '–'}</td><td class="num">${r.pezzi ?? '–'}</td><td>${chipStato(r)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Nessuna riga su questo tablet.</td></tr>'}</tbody></table></div>
    </div>
    <div class="foot"><button class="btn" id="stato-x">Indietro</button></div>`;
}

/* ---------- fogli: nuova lavorazione, inserimento a mano, chiusura ---------- */
function vistaFoglio() {
  const f = S.foglio;
  if (f.tipo === 'chiusura') return foglioChiusura(f);
  const q = (f.q || '').trim().toUpperCase();
  const mie = S.righe.filter((r) => r.dipendente === S.utente).sort((a, b) => b.creatoIl.localeCompare(a.creatoIl));
  const recenti = [...new Set(mie.map((r) => r.commessa))].slice(0, 6);
  const attive = commesseAttive();
  let lista;
  if (q) {
    lista = attive.filter((c) => c.codice.toUpperCase().includes(q) || c.cliente.toUpperCase().includes(q));
    lista.sort((a, b) => Number(recenti.includes(b.codice)) - Number(recenti.includes(a.codice)));
  } else {
    lista = recenti.map((cod) => attive.find((c) => c.codice === cod)).filter(Boolean);
    if (!lista.length) lista = attive.slice(0, 12);
  }
  lista = lista.slice(0, 40);
  const manuale = f.tipo === 'manuale';
  const pronta = f.commessa && f.lavorazione;
  return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t"><div class="sheet-in">
    <div class="sheet-head"><h2 id="sh-t">${manuale ? 'Inserimento a mano' : 'Nuova lavorazione'}</h2><button class="btn ghost" id="sh-x">Annulla</button></div>
    <div class="step"><label for="q">1 · Commessa</label>
      <input class="search" id="q" inputmode="text" autocomplete="off" autocapitalize="off" placeholder="Numero commessa o cliente" value="${esc(f.q || '')}">
      ${!q && recenti.length ? '<div class="lbl" style="letter-spacing:.06em">Usate di recente</div>' : ''}
      <div class="coms">${lista.map((c) => `<button class="cbtn ${recenti.includes(c.codice) ? 'recent' : ''}" data-com="${esc(c.codice)}" aria-pressed="${f.commessa === c.codice}"><b>${esc(c.codice)}</b><span>${esc(c.cliente || '—')}${c.pezziOrdine ? ' · ' + c.pezziOrdine + ' pz' : ''}</span></button>`).join('') || '<p class="empty">Nessuna commessa aperta con questo numero. Se è nuova, chiedi all’ufficio di aprirla.</p>'}</div>
    </div>
    <div class="step"><span class="lbl">2 · Lavorazione</span>
      <div class="lavs">${lavorazioniAttive().map((l, i) => `<button class="lbtn" data-lav="${esc(l.nome)}" aria-pressed="${f.lavorazione === l.nome}"><i class="wire" style="background:var(--w${(i % 5) + 1})"></i><span>${esc(l.nome)}${l.contaPezziFiniti ? '<small>conta i pezzi finiti</small>' : ''}</span></button>`).join('')}</div>
    </div>
    <div class="step"><label for="art">3 · Codice articolo <span style="text-transform:none;letter-spacing:0;font-weight:500">(se c’è)</span></label>
      <input class="field mono" id="art" value="${esc(f.codiceArticolo || '')}" autocomplete="off">
    </div>
    ${manuale ? `<div class="step"><span class="lbl">4 · Tempo e pezzi</span>
      <div class="row3">
        <div class="step"><label for="m-data">Data</label><input class="field" type="date" id="m-data" max="${oggiISO()}" value="${esc(f.data)}"></div>
        <div class="step"><label for="m-ini">Inizio</label><input class="field mono" type="time" id="m-ini" value="${esc(f.inizio || '')}"></div>
        <div class="step"><label for="m-fin">Fine</label><input class="field mono" type="time" id="m-fin" value="${esc(f.fine || '')}"></div>
        <div class="step"><label for="m-min">oppure Minuti</label><input class="field mono" type="number" min="1" inputmode="numeric" id="m-min" value="${esc(f.minuti ?? '')}"></div>
        <div class="step"><label for="m-pz">Pezzi fatti</label><input class="field mono" type="number" min="0" inputmode="numeric" id="m-pz" value="${esc(f.pezzi ?? '')}"></div>
        <div class="step"><label for="m-note">Note</label><input class="field" id="m-note" value="${esc(f.note || '')}"></div>
      </div>
      <div class="note-bar">Se inserisci sia inizio/fine sia i minuti, valgono i minuti (come nel file Excel).</div>
    </div>` : ''}
    <div class="summary">${f.commessa ? `<span>Commessa <b>${esc(f.commessa)}</b></span>` : '<span>Scegli la commessa</span>'}${f.lavorazione ? `<span>${esc(f.lavorazione)}</span>` : ''}</div>
    <div class="err" id="sh-err">${esc(f.errore || '')}</div>
    <div class="foot">${manuale
      ? `<button class="btn primary xl" id="sh-salva" ${pronta ? '' : 'disabled'}>Salva riga</button>`
      : `<button class="btn primary xl" id="sh-avvia" ${pronta ? '' : 'disabled'}>▶ Avvia cronometro</button>`}</div>
  </div></div>`;
}
function foglioChiusura(f) {
  const r = f.riga, c = infoCommessa(r.commessa), vecchia = r.data !== oggiISO();
  return `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t"><div class="sheet-in" style="max-width:620px">
    <div class="sheet-head"><h2 id="sh-t">Fine lavorazione</h2><button class="btn ghost" id="sh-x">Indietro</button></div>
    <div class="summary"><span>Commessa <b>${esc(r.commessa)}</b></span><span>${esc(c ? c.cliente : '')}</span><span>${esc(r.lavorazione)}</span><span>dalle <b>${oraDaMinuti(r.inizioMinuti)}</b></span></div>
    <div class="step"><label for="c-pz">Pezzi fatti in questa lavorazione</label>
      <div class="bigpz"><button class="btn" data-pz="-1" aria-label="Meno uno">−</button><input class="field" id="c-pz" type="number" min="0" inputmode="numeric" value="${esc(f.pezzi ?? '')}"><button class="btn" data-pz="1" aria-label="Più uno">+</button></div>
      <div class="note-bar">Solo i pezzi fatti ora, non il totale della commessa.</div>
    </div>
    <div class="row3" style="grid-template-columns:1fr 2fr">
      <div class="step"><label for="c-fin">Ora di fine</label><input class="field mono" type="time" id="c-fin" value="${esc(f.oraFine)}"></div>
      <div class="step"><label for="c-note">Note</label><input class="field" id="c-note" value="${esc(f.note || '')}"></div>
    </div>
    ${vecchia ? `<div class="warn">Questa lavorazione è del ${fmtData(r.data)}: scrivi l’ora di fine reale.</div>` : ''}
    <div class="err" id="sh-err">${esc(f.errore || '')}</div>
    <div class="foot"><button class="btn primary xl" id="c-salva">Chiudi e salva</button></div>
  </div></div>`;
}
/** Ridisegna il foglio senza perdere la posizione di scorrimento. */
function ridisegnaFoglio() {
  const y = $('.sheet')?.scrollTop || 0, cy = $('.coms')?.scrollTop || 0;
  disegna();
  if ($('.sheet')) $('.sheet').scrollTop = y;
  if ($('.coms')) $('.coms').scrollTop = cy;
}

/* ---------- salvataggi ---------- */
async function salvaRiga(riga) {
  await Archivio.salvaRighe([riga]); // prima sul disco del tablet, poi a video
  const i = S.righe.findIndex((r) => r.id === riga.id);
  if (i >= 0) S.righe[i] = riga; else S.righe.push(riga);
}
function erroreSuFoglio(e) {
  S.foglio.errore = e.perUtente ? e.message : 'Salvataggio non riuscito: ' + e.message;
  ridisegnaFoglio();
}
async function avviaCronometro() {
  const f = S.foglio;
  try {
    const r = L.creaRigaCronometro({ dipendente: S.utente, commessa: f.commessa, lavorazione: f.lavorazione, codiceArticolo: f.codiceArticolo, codiceTablet: S.config.codiceTablet });
    await salvaRiga({ ...r, stato: 'aperta' });
    S.foglio = null;
    avviso('Cronometro avviato su ' + r.commessa);
    disegna();
  } catch (e) { erroreSuFoglio(e); }
}
function leggiCampiManuale() {
  const f = S.foglio;
  f.codiceArticolo = $('#art').value.trim();
  f.data = $('#m-data').value; f.inizio = $('#m-ini').value; f.fine = $('#m-fin').value;
  f.minuti = $('#m-min').value; f.pezzi = $('#m-pz').value; f.note = $('#m-note').value;
}
async function salvaManuale() {
  leggiCampiManuale();
  const f = S.foglio;
  try {
    const r = L.creaRigaManuale({ ...f, dipendente: S.utente, codiceTablet: S.config.codiceTablet });
    await salvaRiga({ ...r, stato: 'da_inviare' });
    S.foglio = null;
    avviso('Riga salvata');
    disegna();
    inviaTutto();
  } catch (e) { erroreSuFoglio(e); }
}
async function chiudiLavorazione() {
  const f = S.foglio;
  f.pezzi = $('#c-pz').value; f.oraFine = $('#c-fin').value; f.note = $('#c-note').value;
  try {
    const r = L.chiudiRiga(f.riga, f);
    await salvaRiga({ ...r, stato: 'da_inviare' });
    S.foglio = null;
    avviso(`Lavorazione chiusa: ${r.pezzi} pz in ${fmtMinuti(r.minuti)}`);
    disegna();
    inviaTutto();
  } catch (e) { erroreSuFoglio(e); }
}

/* ---------- eventi ---------- */
function collegaEventi() {
  const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
  // barra e navigazione
  on('#invia', 'click', () => inviaTutto(true));
  on('#vai-stato', 'click', () => { S.dalla = S.vista; S.vista = 'stato'; disegna(); });
  on('#stato-x', 'click', () => { S.vista = S.dalla || 'login'; disegna(); });
  on('#vai-imp', 'click', () => { S.vista = 'impostazioni'; S.scelto = null; disegna(); });
  on('#agg-ana', 'click', async () => {
    try { await scaricaAnagrafiche(); avviso('Anagrafiche aggiornate.'); }
    catch (e) { S.ultimoErroreAnagrafiche = e.message; avviso('Aggiornamento non riuscito: ' + e.message + ' Continuo con la copia che ho già.'); }
    disegna();
  });
  // prima configurazione
  on('#s-ok', 'click', () => salvaConfig(false));
  on('#s-comunque', 'click', () => salvaConfig(true));
  on('#s-annulla', 'click', () => { S.setup = {}; S.vista = 'login'; disegna(); });
  // impostazioni
  on('#i-x', 'click', () => { S.vista = 'login'; disegna(); });
  on('#i-mod', 'click', () => {
    if ($('#i-tok').value.trim() !== S.config.token) { $('#i-err').textContent = 'Token errato.'; return; }
    S.setup = { ...S.config };
    S.vista = 'setup';
    disegna();
  });
  // login
  on('[data-dip]', 'click', (e) => { S.scelto = e.currentTarget.dataset.dip; S.pin = ''; S.pinErr = ''; disegna(); });
  on('[data-k]', 'click', (e) => tastoPin(e.currentTarget.dataset.k));
  // home
  on('#nuova', 'click', () => { S.foglio = { tipo: 'nuova', q: '' }; disegna(); });
  on('#manuale', 'click', () => { S.foglio = { tipo: 'manuale', q: '', data: oggiISO() }; disegna(); });
  on('#esci', 'click', () => { S.utente = null; S.foglio = null; S.vista = 'login'; disegna(); });
  on('[data-chiudi]', 'click', (e) => {
    const r = S.righe.find((x) => x.id === e.currentTarget.dataset.chiudi);
    if (!r) return;
    S.foglio = { tipo: 'chiusura', riga: r, oraFine: L.oraFineProposta(r) };
    disegna();
  });
  // fogli
  on('#sh-x', 'click', () => { S.foglio = null; disegna(); });
  on('#q', 'input', (e) => {
    if (S.foglio.tipo === 'manuale') leggiCampiManuale();
    S.foglio.q = e.target.value;
    const pos = e.target.selectionStart;
    disegna();
    const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos);
  });
  const scegli = (campo, valore) => {
    if (S.foglio.tipo === 'manuale') leggiCampiManuale();
    S.foglio[campo] = valore; S.foglio.errore = '';
    ridisegnaFoglio();
  };
  on('[data-com]', 'click', (e) => scegli('commessa', e.currentTarget.dataset.com));
  on('[data-lav]', 'click', (e) => scegli('lavorazione', e.currentTarget.dataset.lav));
  on('#art', 'input', (e) => { S.foglio.codiceArticolo = e.target.value.trim(); });
  on('#sh-avvia', 'click', avviaCronometro);
  on('#sh-salva', 'click', salvaManuale);
  on('[data-pz]', 'click', (e) => { const i = $('#c-pz'); i.value = Math.max(0, (Number(i.value) || 0) + Number(e.currentTarget.dataset.pz)); });
  on('#c-salva', 'click', chiudiLavorazione);
}

/* ---------- orologio e cronometri ---------- */
function tic() {
  const c = $('#clock');
  if (c) { const d = new Date(); c.textContent = L.pad2(d.getHours()) + ':' + L.pad2(d.getMinutes()); }
  document.querySelectorAll('.timer[data-da]').forEach((t) => { t.textContent = L.fmtDurata(Date.now() - new Date(t.dataset.da)); });
}

/* ---------- avvio ---------- */
(async function avvio() {
  try {
    await Archivio.apri();
    S.config = (await Archivio.leggi('config')) || null;
    S.anagrafiche = (await Archivio.leggi('anagrafiche')) || null;
    S.aggiornateIl = (await Archivio.leggi('anagraficheIl')) || null;
    S.ultimoInvio = (await Archivio.leggi('ultimoInvio')) || null;
    S.ultimoErrore = (await Archivio.leggi('ultimoErrore')) || null;
    S.righe = await Archivio.tutteLeRighe();
  } catch (e) {
    $('#app').innerHTML = `<section class="login"><h1>Archivio del tablet non disponibile</h1><p class="err">${esc(e.message)}</p></section>`;
    return;
  }
  S.vista = S.config ? 'login' : 'setup';
  disegna();
  setInterval(tic, 1000);

  // Chiede al sistema di non cancellare i dati dell'app quando serve spazio
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // Invio automatico: all'avvio, al ritorno della rete, quando l'app torna in primo piano e ogni minuto
  const tentativo = () => { if (inAttesa().length) inviaTutto(); };
  window.addEventListener('online', () => { tentativo(); aggiornaAnagraficheInSilenzio(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tentativo(); });
  setInterval(tentativo, RITENTA_INVIO);
  setInterval(aggiornaAnagraficheInSilenzio, AGGIORNA_ANAGRAFICHE);
  tentativo();
  aggiornaAnagraficheInSilenzio();
})();
