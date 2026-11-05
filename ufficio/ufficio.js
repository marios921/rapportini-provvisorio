/*
 * App UFFICIO. Lavora sulla cartella Drive sincronizzata sul PC.
 * Legge /invii/ ma non ci scrive mai: scrive soltanto i tre file elencati in FILE_UFFICIO.
 */
'use strict';
const L = window.Logica;
const { esc, fmtData, oraDaMinuti, minutiDaOra, oggiISO, numeroValido } = L;
const $ = (s) => document.querySelector(s);

const F_ANAGRAFICHE = 'anagrafiche/anagrafiche.json';
const F_CORREZIONI = 'ufficio/correzioni.json';
const F_IMPORTATI = 'ufficio/importati.json';
const FILE_UFFICIO = [F_ANAGRAFICHE, F_CORREZIONI, F_IMPORTATI];
const SOTTOCARTELLE = ['anagrafiche', 'invii', 'ufficio'];
const LETTURE_INSIEME = 16;
const MAX_RIGHE_ANAGRAFICA = 300;

const lunedi = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return L.dataISO(d); };

const U = {
  cartella: null,
  daRiaprire: null,            // cartella ricordata, in attesa del permesso
  daCreare: false,
  caricamento: false,
  letturaIl: null,
  invii: { righe: [], doppioni: 0, conflitti: [], illeggibili: [], ultimoPerTablet: {} },
  righe: [],
  correzioni: { versione: 1, correzioni: {} },
  importati: { versione: 1, righe: {} },
  anagrafiche: { versione: 1, azienda: '', commesse: [], lavorazioni: [], dipendenti: [] },
  fileRovinati: {},            // percorso -> messaggio: su questi file non si scrive
  versioni: {},                // percorso -> data di modifica vista alla lettura
  scheda: 'rapportini',
  filtri: { dal: lunedi(), al: oggiISO(), dipendente: '', commessa: '', conEliminate: false },
  soloNuove: true,
  modifica: null, confermaElimina: false,
  esitoExport: null,
  ana: { sezione: 'commesse', cerca: '', voce: null, importa: null },
};

function avviso(msg) {
  const h = $('#toastHost');
  h.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(avviso.t);
  avviso.t = setTimeout(() => { h.innerHTML = ''; }, 4000);
}

/* ---------- memoria della cartella scelta (solo su questo PC) ---------- */
function memoria(modo, fn) {
  return new Promise((ok, ko) => {
    const rq = indexedDB.open('rapportini-ufficio', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('valori');
    rq.onerror = () => ko(rq.error);
    rq.onsuccess = () => {
      const tx = rq.result.transaction('valori', modo);
      const r = fn(tx.objectStore('valori'));
      tx.oncomplete = () => { rq.result.close(); ok(r.result); };
      tx.onerror = () => ko(tx.error);
    };
  });
}

/* ---------- lettura e scrittura nella cartella ---------- */
async function apriDir(nome, crea = false) { return U.cartella.getDirectoryHandle(nome, { create: crea }); }

async function leggiJson(percorso, predefinito) {
  const [dir, nome] = percorso.split('/');
  delete U.fileRovinati[percorso];
  try {
    const h = await (await apriDir(dir)).getFileHandle(nome);
    const f = await h.getFile();
    U.versioni[percorso] = f.lastModified;
    return JSON.parse(await f.text());
  } catch (e) {
    if (e.name === 'NotFoundError') { U.versioni[percorso] = null; return predefinito; }
    // Un file che c'è ma non si legge non va mai sovrascritto: si perderebbe il contenuto
    U.fileRovinati[percorso] = e.message;
    return predefinito;
  }
}

async function scriviJson(percorso, dati) {
  if (!FILE_UFFICIO.includes(percorso)) throw L.errore('Scrittura non consentita: ' + percorso);
  if (U.fileRovinati[percorso]) throw L.errore(`Il file ${percorso} non si legge correttamente: non lo sovrascrivo. Controllalo su Drive.`);
  const [dir, nome] = percorso.split('/');
  const h = await (await apriDir(dir, true)).getFileHandle(nome, { create: true });
  const attuale = (await h.getFile()).lastModified;
  if (U.versioni[percorso] != null && attuale !== U.versioni[percorso]) {
    throw L.errore(`Il file ${percorso} è cambiato dopo l’ultima lettura (un altro PC?). Premi Aggiorna e ripeti l’operazione.`);
  }
  const w = await h.createWritable();
  await w.write(JSON.stringify(dati, null, 1));
  await w.close();
  U.versioni[percorso] = (await h.getFile()).lastModified;
}

/** Legge tutti i file di /invii/, non importa come si chiamano: Drive può aggiungere " (1)" ai nomi uguali. */
async function leggiInvii() {
  let dir;
  try { dir = await apriDir('invii'); } catch { return []; }
  const handles = [];
  for await (const [nome, h] of dir.entries()) {
    if (h.kind === 'file' && /\.json$/i.test(nome) && !nome.startsWith('.')) handles.push([nome, h]);
  }
  const risultati = [];
  let i = 0;
  await Promise.all(Array.from({ length: LETTURE_INSIEME }, async () => {
    while (i < handles.length) {
      const [nome, h] = handles[i++];
      try { risultati.push({ nome, testo: await (await h.getFile()).text() }); }
      catch { risultati.push({ nome, testo: '' }); }
    }
  }));
  return risultati;
}

async function carica() {
  U.caricamento = true;
  disegna();
  try {
    U.invii = L.unisciInvii(await leggiInvii());
    U.correzioni = await leggiJson(F_CORREZIONI, { versione: 1, correzioni: {} });
    U.importati = await leggiJson(F_IMPORTATI, { versione: 1, righe: {} });
    const a = await leggiJson(F_ANAGRAFICHE, { commesse: [], lavorazioni: [], dipendenti: [] });
    try { U.anagrafiche = L.normalizzaAnagrafiche(a); }
    catch (e) { U.fileRovinati[F_ANAGRAFICHE] = e.message; U.anagrafiche = L.normalizzaAnagrafiche({ commesse: [], lavorazioni: [], dipendenti: [] }); }
    ricalcola();
    U.letturaIl = new Date();
  } catch (e) {
    avviso('Lettura non riuscita: ' + e.message);
  }
  U.caricamento = false;
  disegna();
}
function ricalcola() { U.righe = L.applicaCorrezioni(U.invii.righe, U.correzioni); }

/* ---------- scelta della cartella ---------- */
async function scegliCartella() {
  let h;
  try { h = await window.showDirectoryPicker({ id: 'archivio-rapportini', mode: 'readwrite' }); }
  catch (e) { if (e.name !== 'AbortError') avviso('Cartella non aperta: ' + e.message); return; }
  await usaCartella(h);
}
async function usaCartella(h) {
  U.cartella = h; U.daRiaprire = null;
  try { await memoria('readwrite', (s) => s.put(h, 'cartella')); } catch { /* la cartella si potrà scegliere di nuovo */ }
  const mancanti = [];
  for (const n of SOTTOCARTELLE) { try { await h.getDirectoryHandle(n); } catch { mancanti.push(n); } }
  if (mancanti.length === SOTTOCARTELLE.length) { U.daCreare = true; disegna(); return; }
  for (const n of mancanti) await h.getDirectoryHandle(n, { create: true });
  U.daCreare = false;
  await carica();
}
async function riapriCartella() {
  const h = U.daRiaprire;
  if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') await usaCartella(h);
  else avviso('Senza il permesso non posso leggere la cartella.');
}

/* ---------- disegno ---------- */
function disegna() {
  const app = $('#app');
  if (!window.showDirectoryPicker) {
    app.innerHTML = `<section class="login"><h1>Serve Chrome o Edge</h1><p>Questa app lavora sulla cartella del PC con una funzione che c’è solo in Google Chrome e Microsoft Edge. Aprila con uno dei due.</p></section>`;
    return;
  }
  if (!U.cartella) { app.innerHTML = vistaCartella(); collega(); return; }
  if (U.daCreare) { app.innerHTML = vistaCrea(); collega(); return; }
  app.innerHTML = barra() + (U.scheda === 'anagrafiche' ? vistaAnagrafiche() : vistaRapportini());
  collega();
}
function vistaCartella() {
  return `<section class="login"><div><h1>Apri l’archivio dei rapportini</h1>
      <p>Scegli la cartella sincronizzata da Google Drive per desktop. La ricorderò per le prossime volte.</p></div>
    <div class="foot">${U.daRiaprire ? `<button class="btn primary xl" id="riapri">Riapri «${esc(U.daRiaprire.name)}»</button><button class="btn xl" id="scegli">Scegli un’altra cartella</button>` : '<button class="btn primary xl" id="scegli">Scegli la cartella</button>'}</div></section>`;
}
function vistaCrea() {
  return `<section class="login"><div><h1>Questa cartella non contiene un archivio</h1>
      <p>In «${esc(U.cartella.name)}» non ci sono le sottocartelle anagrafiche, invii e ufficio. È la cartella giusta?</p></div>
    <div class="foot"><button class="btn xl" id="scegli">Scegli un’altra cartella</button><button class="btn primary xl" id="crea">Sì, crea qui le sottocartelle</button></div></section>`;
}
function barra() {
  return `<header class="top">
    <div class="brand">Rapportini<small>${esc(U.anagrafiche.azienda || 'UFFICIO')}</small></div>
    <div class="seg" role="group" aria-label="Sezione">
      <button id="t-rap" aria-pressed="${U.scheda === 'rapportini'}">Rapportini</button>
      <button id="t-ana" aria-pressed="${U.scheda === 'anagrafiche'}">Anagrafiche</button>
    </div>
    <span class="sp"></span>
    <span class="note-bar">Cartella: ${esc(U.cartella.name)}${U.letturaIl ? ' · letta alle ' + U.letturaIl.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
    <button class="btn small primary" id="aggiorna" ${U.caricamento ? 'disabled' : ''}>${U.caricamento ? 'Lettura…' : 'Aggiorna'}</button>
  </header>
  <div class="info banner">I dati sono aggiornati all’ultimo invio dei tablet, non in tempo reale: una lavorazione ancora aperta o non inviata qui non si vede. Dopo un invio, Drive può impiegare qualche minuto a portare il file su questo PC.</div>
  ${Object.entries(U.fileRovinati).map(([p, m]) => `<div class="warn banner">Il file ${esc(p)} non si legge (${esc(m)}): non verrà sovrascritto. Controllalo su Drive.</div>`).join('')}`;
}

/* ---------- scheda Rapportini ---------- */
function righeFiltrate() { return L.filtraRighe(U.righe, U.filtri); }

function vistaRapportini() {
  const oggi = oggiISO();
  const diOggi = U.righe.filter((r) => r.data === oggi && !r._eliminata);
  const min = diOggi.reduce((s, r) => s + (r.minuti || 0), 0);
  const pz = diOggi.reduce((s, r) => s + (r.pezzi || 0), 0);
  const finiti = new Set(U.anagrafiche.lavorazioni.filter((l) => l.contaPezziFiniti).map((l) => l.nome));
  const pzFiniti = diOggi.reduce((s, r) => s + (finiti.has(r.lavorazione) ? r.pezzi || 0 : 0), 0);
  const filtrate = righeFiltrate();
  const daControllare = filtrate.filter((r) => !r._eliminata && L.segnalazioni(r, U.anagrafiche).length).length;
  const prep = L.preparaEsportazione(filtrate, U.righe, U.importati, { soloNuove: U.soloNuove });
  const nDaRiportare = new Set(prep.daRiportare.map((d) => d.riga.id));
  const lista = [...L.ordinaRighe(filtrate)].reverse();
  const tablet = Object.entries(U.invii.ultimoPerTablet).sort((a, b) => a[0].localeCompare(b[0]));
  const quando = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  return `<div class="kpis">
      <div class="kpi"><span>Ore oggi</span><b id="k-ore">${L.fmtOre(min)}</b></div>
      <div class="kpi"><span>Pezzi lavorati oggi</span><b id="k-pezzi">${L.fmtNumero(pz)}</b><small>di cui finiti ${L.fmtNumero(pzFiniti)}</small></div>
      <div class="kpi ${daControllare ? 'alert' : ''}"><span>Righe da controllare</span><b id="k-controllo">${daControllare}</b><small>nel periodo scelto</small></div>
      <div class="kpi"><span>Righe totali ricevute</span><b id="k-totale">${U.invii.righe.length}</b><small>${U.invii.doppioni ? L.conteggio(U.invii.doppioni, 'doppione scartato', 'doppioni scartati') : 'nessun doppione'}</small></div>
    </div>
    ${U.invii.illeggibili.length ? `<div class="warn banner">File non letti (${U.invii.illeggibili.length}): ${U.invii.illeggibili.slice(0, 5).map((f) => esc(f.nome + ' — ' + f.motivo)).join('; ')}. Di solito è una sincronizzazione in corso: premi Aggiorna tra poco.</div>` : ''}
    ${U.invii.conflitti.length ? `<div class="warn banner">Righe arrivate due volte con contenuto diverso (${U.invii.conflitti.length}): ho tenuto la prima (${esc(U.invii.conflitti[0].fileTenuto)}). Controlla.</div>` : ''}
    <div class="panel"><h2>Ultimo invio per tablet</h2>
      <div id="tablet" class="note-bar" style="font-size:15px;gap:16px">${tablet.map(([cod, u]) => `<span><b class="mono">${esc(cod)}</b> ${quando(u.il)}</span>`).join('') || 'Nessun invio ricevuto finora.'}</div>
    </div>
    ${U.esitoExport ? `<div class="info banner" id="esito">${U.esitoExport}</div>` : ''}
    <div class="filters">
      <div class="f"><label class="lbl" for="f-dal">Dal</label><input class="field" type="date" id="f-dal" value="${esc(U.filtri.dal)}"></div>
      <div class="f"><label class="lbl" for="f-al">Al</label><input class="field" type="date" id="f-al" value="${esc(U.filtri.al)}"></div>
      <div class="f"><label class="lbl" for="f-dip">Dipendente</label><select class="field" id="f-dip"><option value="">Tutti</option>${[...new Set(U.righe.map((r) => r.dipendente))].sort().map((d) => `<option ${U.filtri.dipendente === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></div>
      <div class="f"><label class="lbl" for="f-com">Commessa</label><input class="field mono" id="f-com" autocomplete="off" value="${esc(U.filtri.commessa)}"></div>
      <label class="check"><input type="checkbox" id="f-eli" ${U.filtri.conEliminate ? 'checked' : ''}> Mostra eliminate</label>
      <span style="flex:1"></span>
      <label class="check"><input type="checkbox" id="x-nuove" ${U.soloNuove ? 'checked' : ''}> Solo righe non ancora esportate</label>
      <button class="btn primary" id="esporta" ${prep.nuove.length || prep.daRiportare.length ? '' : 'disabled'}>Esporta ${L.conteggio(prep.nuove.length, 'riga', 'righe')}${prep.daRiportare.length ? ' + ' + L.conteggio(prep.daRiportare.length, 'correzione', 'correzioni') : ''} (.xlsx)</button>
    </div>
    ${U.soloNuove ? '' : '<div class="warn banner">Stai esportando anche righe già esportate: incollandole nel foglio le conteresti due volte.</div>'}
    ${prep.daRiportare.length ? `<div class="warn banner">${L.conteggio(prep.daRiportare.length, 'riga già esportata è stata cambiata', 'righe già esportate sono state cambiate')} dopo: nel file Excel va riportato a mano. Le trovi nel foglio CORREZIONI_DA_RIPORTARE della prossima esportazione.</div>` : ''}
    ${U.modifica ? pannelloModifica() : ''}
    <div class="tbl-wrap"><table id="tabella" style="min-width:980px">
      <thead><tr><th>Data</th><th>Dipendente</th><th>Commessa</th><th>Lavorazione</th><th>Art.</th><th class="num">Inizio</th><th class="num">Fine</th><th class="num">Minuti</th><th class="num">Pezzi</th><th>Stato</th><th>Note</th><th></th></tr></thead>
      <tbody>${lista.map((r) => rigaTabella(r, nDaRiportare)).join('') || '<tr><td colspan="12" class="empty">Nessuna riga nel periodo. Le righe inviate dai tablet compaiono qui.</td></tr>'}</tbody>
    </table></div>
    <p class="note-bar" style="margin-top:12px">L’esportazione contiene le colonne A–J del foglio RAPPORTINI (${L.INTESTAZIONI.map(esc).join(', ')}). Le colonne K–O del foglio sono formule: non vanno toccate.</p>`;
}
function rigaTabella(r, nDaRiportare) {
  const seg = L.segnalazioni(r, U.anagrafiche);
  const chip = [
    ...seg.map((s) => `<span class="chip ${s.tipo}">${esc(s.testo)}</span>`),
    r.manuale ? '<span class="chip man">Manuale</span>' : '',
    r._corretta ? '<span class="chip run">Corretta</span>' : '',
    r._eliminata ? '<span class="chip bad">Eliminata</span>' : '',
    nDaRiportare.has(r.id) ? '<span class="chip bad">Da riportare in Excel</span>' : U.importati.righe[r.id] ? '<span class="chip ok">Esportata</span>' : '',
  ].join(' ');
  const cli = U.anagrafiche.commesse.find((c) => c.codice === r.commessa);
  return `<tr class="${r._eliminata ? 'eliminata' : seg.length ? 'segnalata' : ''}" data-riga="${esc(r.id)}">
    <td class="mono">${fmtData(r.data)}</td><td>${esc(r.dipendente)}</td><td class="mono"><b>${esc(r.commessa)}</b>${cli ? `<br><small style="color:var(--muted)">${esc(cli.cliente)}</small>` : ''}</td>
    <td>${esc(r.lavorazione)}</td><td class="mono">${esc(r.codiceArticolo)}</td>
    <td class="num">${oraDaMinuti(r.inizioMinuti)}</td><td class="num">${oraDaMinuti(r.fineMinuti)}</td><td class="num">${r.minuti ?? '–'}</td><td class="num">${r.pezzi ?? '–'}</td>
    <td>${chip}</td><td>${esc(r.note)}</td>
    <td style="white-space:nowrap">${r._eliminata ? `<button class="tbtn" data-ripristina="${esc(r.id)}">Ripristina</button>` : `<button class="tbtn" data-correggi="${esc(r.id)}">Correggi</button>`}</td></tr>`;
}
function pannelloModifica() {
  const r = U.righe.find((x) => x.id === U.modifica);
  if (!r) return '';
  return `<div class="panel" id="pannello-modifica"><h2>Correggi riga · ${esc(r.dipendente)} · ${fmtData(r.data)}</h2>
    <div class="row3">
      <div class="step"><label class="lbl" for="e-data">Data</label><input class="field" type="date" id="e-data" value="${esc(r.data)}"></div>
      <div class="step"><label class="lbl" for="e-dip">Dipendente</label><input class="field" id="e-dip" list="l-dip" value="${esc(r.dipendente)}"></div>
      <div class="step"><label class="lbl" for="e-com">Commessa</label><input class="field mono" id="e-com" list="l-com" autocomplete="off" value="${esc(r.commessa)}"></div>
      <div class="step"><label class="lbl" for="e-lav">Lavorazione</label><input class="field" id="e-lav" list="l-lav" value="${esc(r.lavorazione)}"></div>
      <div class="step"><label class="lbl" for="e-art">Codice articolo</label><input class="field mono" id="e-art" value="${esc(r.codiceArticolo)}"></div>
      <div class="step"><label class="lbl" for="e-note">Note</label><input class="field" id="e-note" value="${esc(r.note)}"></div>
      <div class="step"><label class="lbl" for="e-ini">Inizio</label><input class="field mono" type="time" id="e-ini" value="${oraDaMinuti(r.inizioMinuti)}"></div>
      <div class="step"><label class="lbl" for="e-fin">Fine</label><input class="field mono" type="time" id="e-fin" value="${oraDaMinuti(r.fineMinuti)}"></div>
      <div class="step"><label class="lbl" for="e-min">Minuti</label><input class="field mono" type="number" min="0" id="e-min" value="${esc(r.minuti ?? '')}"></div>
      <div class="step"><label class="lbl" for="e-pz">Pezzi</label><input class="field mono" type="number" min="0" id="e-pz" value="${esc(r.pezzi ?? '')}"></div>
    </div>
    <datalist id="l-com">${U.anagrafiche.commesse.map((c) => `<option value="${esc(c.codice)}">`).join('')}</datalist>
    <datalist id="l-lav">${U.anagrafiche.lavorazioni.map((l) => `<option value="${esc(l.nome)}">`).join('')}</datalist>
    <datalist id="l-dip">${U.anagrafiche.dipendenti.map((d) => `<option value="${esc(d.nome)}">`).join('')}</datalist>
    <p class="note-bar">La riga originale inviata dal tablet resta intatta: la correzione si salva a parte e si può togliere.</p>
    <div class="foot">
      ${U.confermaElimina ? '<span style="color:var(--bad);font-weight:700">Eliminare la riga?</span><button class="btn danger" id="e-eli-si">Sì, elimina</button><button class="btn" id="e-eli-no">No</button>' : '<button class="btn danger" id="e-eli">Elimina riga</button>'}
      ${r._corretta ? '<button class="btn" id="e-togli">Torna all’originale</button>' : ''}
      <span style="flex:1"></span><button class="btn ghost" id="e-x">Annulla</button><button class="btn primary" id="e-salva">Salva correzione</button>
    </div></div>`;
}
async function salvaCorrezioni(nuove, msg) {
  try {
    await scriviJson(F_CORREZIONI, nuove);
    U.correzioni = nuove;
    ricalcola();
    U.modifica = null; U.confermaElimina = false;
    avviso(msg);
    disegna();
  } catch (e) { avviso(e.perUtente ? e.message : 'Salvataggio non riuscito: ' + e.message); }
}
function salvaModifica() {
  const r = U.righe.find((x) => x.id === U.modifica);
  const commessa = $('#e-com').value.trim(), data = $('#e-data').value, dipendente = $('#e-dip').value.trim();
  const inizio = minutiDaOra($('#e-ini').value), fine = minutiDaOra($('#e-fin').value);
  const testoMin = $('#e-min').value.trim(), testoPz = $('#e-pz').value.trim();
  const minuti = numeroValido(testoMin), pezzi = numeroValido(testoPz);
  if (!commessa || !data || !dipendente) { avviso('Data, dipendente e commessa sono obbligatori.'); return; }
  if ((testoMin && minuti == null) || (testoPz && pezzi == null)) { avviso('Minuti e pezzi devono essere numeri non negativi.'); return; }
  if (minuti == null || pezzi == null) { avviso('Indica minuti e pezzi (anche 0).'); return; }
  const campi = {
    data, dipendente, commessa, lavorazione: $('#e-lav').value.trim(), codiceArticolo: $('#e-art').value.trim(),
    inizioMinuti: inizio, fineMinuti: fine, minuti, pezzi, note: $('#e-note').value.trim(),
  };
  if (L.sembraData(commessa) && commessa !== r._originale.commessa) avviso(`Attenzione: il codice "${commessa}" ha l’aspetto di una data.`);
  salvaCorrezioni(L.aggiornaCorrezione(U.correzioni, r._originale, campi), 'Correzione salvata.');
}

/* ---------- esportazione ---------- */
async function salvaSuDisco(nome, dati) {
  const blob = new Blob([dati], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  if (window.showSaveFilePicker) {
    let h;
    try { h = await window.showSaveFilePicker({ suggestedName: nome, types: [{ description: 'File Excel', accept: { [blob.type]: ['.xlsx'] } }] }); }
    catch (e) { if (e.name === 'AbortError') return null; throw e; }
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    return h.name;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return nome;
}
async function esporta() {
  if (U.fileRovinati[F_IMPORTATI]) { avviso('Il file importati.json non si legge: risolvi prima questo problema.'); return; }
  U.esitoExport = null;
  disegna();
  const prep = L.preparaEsportazione(righeFiltrate(), U.righe, U.importati, { soloNuove: U.soloNuove });
  const wb = L.creaFileExcel(window.XLSX, prep);
  const dati = window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const date = prep.nuove.map((r) => r.data).sort();
  const nome = `Rapportini_tablet_${date[0] || oggiISO()}_${date[date.length - 1] || oggiISO()}.xlsx`;
  let salvato;
  try { salvato = await salvaSuDisco(nome, dati); }
  catch (e) { avviso('File non salvato: ' + e.message + ' Nessuna riga è stata segnata come esportata.'); return; }
  if (!salvato) return; // l'utente ha annullato: niente viene segnato come esportato
  try {
    const nuovo = L.registraEsportazione(U.importati, prep, salvato);
    await scriviJson(F_IMPORTATI, nuovo);
    U.importati = nuovo;
    U.esitoExport = `File «${esc(salvato)}» pronto: ${L.conteggio(prep.nuove.length, 'riga', 'righe')} da incollare. In Excel: copia dal foglio RAPPORTINI, dalla riga 2 in giù (colonne A–J), poi nel file annuale vai sulla prima riga libera della colonna A e usa <b>Incolla valori</b>.${prep.daRiportare.length ? ` Poi riporta a mano le voci del foglio CORREZIONI_DA_RIPORTARE.` : ''}`;
  } catch (e) {
    U.esitoExport = `<b>Attenzione:</b> il file è salvato, ma non sono riuscito a segnare le righe come esportate (${esc(e.message)}). La prossima esportazione le riproporrà: non incollarle due volte.`;
  }
  disegna();
}

/* ---------- scheda Anagrafiche ---------- */
function vistaAnagrafiche() {
  const a = U.ana, sez = a.sezione;
  const titoli = { commesse: `Commesse (${U.anagrafiche.commesse.length})`, lavorazioni: `Lavorazioni (${U.anagrafiche.lavorazioni.length})`, dipendenti: `Dipendenti (${U.anagrafiche.dipendenti.length})` };
  const sospetti = U.anagrafiche.commesse.filter((c) => L.sembraData(c.codice));
  return `<div class="panel"><h2>Anagrafiche <span class="count">${U.anagrafiche.aggiornatoIl ? 'salvate il ' + new Date(U.anagrafiche.aggiornatoIl).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : 'non ancora salvate'}</span></h2>
      <div class="filters">
        <div class="f"><label class="lbl" for="a-azienda">Nome azienda (appare sui tablet)</label><input class="field" id="a-azienda" value="${esc(U.anagrafiche.azienda)}"></div>
        <span style="flex:1"></span>
        <label class="btn" for="a-file" tabindex="0">Importa dal file Excel dei rapportini</label><input type="file" id="a-file" accept=".xlsx,.xlsm" hidden>
      </div>
      <p class="note-bar">I tablet ricevono le modifiche al prossimo aggiornamento (entro mezz’ora, oppure con «Aggiorna anagrafiche» sul tablet), dopo che Drive ha sincronizzato il file.</p>
    </div>
    ${a.importa ? pannelloImporta() : ''}
    ${sospetti.length ? `<div class="warn banner">${L.conteggio(sospetti.length, 'codice commessa ha', 'codici commessa hanno')} l’aspetto di una data (${sospetti.slice(0, 6).map((c) => esc(c.codice)).join(', ')}). Resta trattato come testo; se è un danno fatto da Excel, correggilo qui con il codice giusto.</div>` : ''}
    <div class="filters"><div class="seg">${Object.keys(titoli).map((k) => `<button data-sez="${k}" aria-pressed="${sez === k}">${titoli[k]}</button>`).join('')}</div>
      ${sez === 'commesse' ? `<div class="f"><input class="field" id="a-cerca" placeholder="Cerca codice o cliente" autocomplete="off" value="${esc(a.cerca)}"></div>` : ''}
      <span style="flex:1"></span><button class="btn primary small" id="a-nuova">＋ Aggiungi</button></div>
    ${a.voce ? pannelloVoce() : ''}
    <div class="tbl-wrap">${sez === 'commesse' ? tabellaCommesse() : sez === 'lavorazioni' ? tabellaLavorazioni() : tabellaDipendenti()}</div>`;
}
const chipAttivo = (v) => (v ? '<span class="chip ok">Attiva</span>' : '<span class="chip bad">Non attiva</span>');
function tabellaCommesse() {
  const q = U.ana.cerca.trim().toUpperCase();
  const tutte = U.anagrafiche.commesse.map((c, i) => ({ ...c, i })).filter((c) => !q || c.codice.toUpperCase().includes(q) || c.cliente.toUpperCase().includes(q));
  return `<table><thead><tr><th>N° commessa</th><th>Cliente</th><th>Descrizione</th><th class="num">Pezzi ordine</th><th>Stato</th><th></th></tr></thead><tbody>
    ${tutte.slice(0, MAX_RIGHE_ANAGRAFICA).map((c) => `<tr><td class="mono"><b>${esc(c.codice)}</b>${L.sembraData(c.codice) ? ' <span class="chip bad">Sembra una data</span>' : ''}</td><td>${esc(c.cliente)}</td><td>${esc(c.descrizione)}</td><td class="num">${c.pezziOrdine ?? ''}</td><td>${chipAttivo(c.attiva)}</td><td><button class="tbtn" data-voce="${c.i}">Modifica</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nessuna commessa.</td></tr>'}
    ${tutte.length > MAX_RIGHE_ANAGRAFICA ? `<tr><td colspan="6" class="empty">Ne mostro ${MAX_RIGHE_ANAGRAFICA} su ${tutte.length}: usa la ricerca.</td></tr>` : ''}</tbody></table>`;
}
function tabellaLavorazioni() {
  return `<table><thead><tr><th>Lavorazione</th><th>Conta i pezzi finiti</th><th>Stato</th><th></th></tr></thead><tbody>
    ${U.anagrafiche.lavorazioni.map((l, i) => `<tr><td>${esc(l.nome)}</td><td>${l.contaPezziFiniti ? 'Sì' : 'No'}</td><td>${chipAttivo(l.attiva)}</td><td><button class="tbtn" data-voce="${i}">Modifica</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nessuna lavorazione.</td></tr>'}</tbody></table>`;
}
function tabellaDipendenti() {
  return `<table><thead><tr><th>Nome</th><th>Reparto</th><th>PIN</th><th>Stato</th><th></th></tr></thead><tbody>
    ${U.anagrafiche.dipendenti.map((d, i) => `<tr><td><b>${esc(d.nome)}</b></td><td>${esc(d.reparto)}</td><td>${d.pinHash ? '<span class="chip ok">Impostato</span>' : '<span class="chip bad">Manca</span>'}</td><td>${chipAttivo(d.attivo)}</td><td><button class="tbtn" data-voce="${i}">Modifica</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nessun dipendente.</td></tr>'}</tbody></table>`;
}
function pannelloVoce() {
  const { sezione: sez, voce } = U.ana;
  const lista = U.anagrafiche[sez];
  const v = voce.i == null ? {} : lista[voce.i];
  const attivo = voce.i == null || (sez === 'dipendenti' ? v.attivo : v.attiva);
  let campi;
  if (sez === 'commesse') {
    // Il codice è un campo di testo: nessuna conversione, né qui né altrove
    campi = `<div class="step"><label class="lbl" for="v-cod">N° commessa</label><input class="field mono" id="v-cod" type="text" autocomplete="off" value="${esc(v.codice || '')}"></div>
      <div class="step"><label class="lbl" for="v-cli">Cliente</label><input class="field" id="v-cli" value="${esc(v.cliente || '')}"></div>
      <div class="step"><label class="lbl" for="v-des">Descrizione</label><input class="field" id="v-des" value="${esc(v.descrizione || '')}"></div>
      <div class="step"><label class="lbl" for="v-pz">Pezzi ordine</label><input class="field mono" id="v-pz" type="number" min="0" value="${esc(v.pezziOrdine ?? '')}"></div>`;
  } else if (sez === 'lavorazioni') {
    campi = `<div class="step"><label class="lbl" for="v-nome">Lavorazione</label><input class="field" id="v-nome" value="${esc(v.nome || '')}"></div>
      <label class="check"><input type="checkbox" id="v-finiti" ${v.contaPezziFiniti ? 'checked' : ''}> Conta i pezzi finiti</label>`;
  } else {
    campi = `<div class="step"><label class="lbl" for="v-nome">Nome</label><input class="field" id="v-nome" value="${esc(v.nome || '')}"></div>
      <div class="step"><label class="lbl" for="v-rep">Reparto</label><input class="field" id="v-rep" value="${esc(v.reparto || '')}"></div>
      <div class="step"><label class="lbl" for="v-pin">${v.pinHash ? 'Nuovo PIN (vuoto = resta quello attuale)' : 'PIN di 4 cifre'}</label><input class="field mono" id="v-pin" inputmode="numeric" maxlength="4" autocomplete="off"></div>`;
  }
  return `<div class="panel" id="pannello-voce"><h2>${voce.i == null ? 'Nuova voce' : 'Modifica'}</h2>
    <div class="row3">${campi}<label class="check"><input type="checkbox" id="v-attivo" ${attivo ? 'checked' : ''}> Attiva (compare sui tablet)</label></div>
    ${sez === 'commesse' && voce.i != null ? '<p class="note-bar">Cambiando il codice, le righe già ricevute conservano il codice vecchio: se serve, correggile dalla scheda Rapportini.</p>' : ''}
    <div class="foot" style="margin-top:12px"><button class="btn ghost" id="v-x">Annulla</button><button class="btn primary" id="v-salva">Salva</button></div></div>`;
}
function pannelloImporta() {
  const { importa: p } = U.ana;
  const anteprima = L.unisciAnagrafiche(U.anagrafiche, p.dati).conteggio;
  return `<div class="panel" id="pannello-importa"><h2>Importa da «${esc(p.nome)}»</h2>
    <p>Commesse nuove: <b>${anteprima.commesseNuove}</b>, da aggiornare: <b>${anteprima.commesseAggiornate}</b>. Lavorazioni nuove: <b>${anteprima.lavorazioniNuove}</b>. Dipendenti nuovi: <b>${anteprima.dipendentiNuovi}</b>.<br>Non cancello niente e non tocco i PIN già impostati. I dipendenti nuovi non potranno accedere finché non assegni loro un PIN.</p>
    ${p.dati.avvisi.length ? `<div class="warn" style="margin-bottom:12px">${p.dati.avvisi.map(esc).join('<br>')}</div>` : ''}
    <div class="foot"><button class="btn ghost" id="imp-x">Annulla</button><button class="btn primary" id="imp-ok">Conferma e salva</button></div></div>`;
}
async function salvaAnagrafiche(nuove, msg) {
  const copia = L.normalizzaAnagrafiche({ ...nuove, aggiornatoIl: new Date().toISOString() });
  try {
    await scriviJson(F_ANAGRAFICHE, copia);
    U.anagrafiche = copia;
    U.ana.voce = null; U.ana.importa = null;
    avviso(msg);
    disegna();
    return true;
  } catch (e) { avviso(e.perUtente ? e.message : 'Salvataggio non riuscito: ' + e.message); return false; }
}
async function salvaVoce() {
  const { sezione: sez, voce } = U.ana;
  const copia = L.normalizzaAnagrafiche(U.anagrafiche);
  const lista = copia[sez];
  const attivo = $('#v-attivo').checked;
  const nuovoNome = (sez === 'commesse' ? $('#v-cod') : $('#v-nome')).value.trim();
  if (!nuovoNome) { avviso('Il campo principale è obbligatorio.'); return; }
  const chiave = sez === 'commesse' ? 'codice' : 'nome';
  if (lista.some((x, i) => x[chiave] === nuovoNome && i !== voce.i)) { avviso(`"${nuovoNome}" esiste già.`); return; }
  let dati;
  if (sez === 'commesse') dati = { codice: nuovoNome, cliente: $('#v-cli').value, descrizione: $('#v-des').value, pezziOrdine: numeroValido($('#v-pz').value), attiva: attivo };
  else if (sez === 'lavorazioni') dati = { nome: nuovoNome, contaPezziFiniti: $('#v-finiti').checked, attiva: attivo };
  else {
    dati = { nome: nuovoNome, reparto: $('#v-rep').value, attivo };
    const pin = $('#v-pin').value.trim();
    if (pin) {
      try { Object.assign(dati, await L.creaPin(pin)); } catch (e) { avviso(e.message); return; }
    }
  }
  if (voce.i == null) lista.push(dati); else Object.assign(lista[voce.i], dati);
  if (sez === 'commesse' && L.sembraData(nuovoNome)) avviso(`Attenzione: il codice "${nuovoNome}" ha l’aspetto di una data.`);
  await salvaAnagrafiche(copia, 'Anagrafiche salvate.');
}
async function leggiFileExcel(file) {
  try {
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellNF: true, cellText: true });
    U.ana.importa = { nome: file.name, dati: L.leggiAnagraficheDaExcel(window.XLSX, wb) };
  } catch (e) { avviso(e.perUtente ? e.message : 'File non leggibile: ' + e.message); }
  disegna();
}

/* ---------- eventi ---------- */
function collega() {
  const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));
  on('#scegli', 'click', () => { U.daCreare = false; U.cartella = null; scegliCartella(); });
  on('#riapri', 'click', riapriCartella);
  on('#crea', 'click', async () => {
    for (const n of SOTTOCARTELLE) await U.cartella.getDirectoryHandle(n, { create: true });
    U.daCreare = false;
    await carica();
  });
  on('#aggiorna', 'click', carica);
  on('#t-rap', 'click', () => { U.scheda = 'rapportini'; disegna(); });
  on('#t-ana', 'click', () => { U.scheda = 'anagrafiche'; disegna(); });
  // filtri
  on('#f-dal', 'change', (e) => { U.filtri.dal = e.target.value; disegna(); });
  on('#f-al', 'change', (e) => { U.filtri.al = e.target.value; disegna(); });
  on('#f-dip', 'change', (e) => { U.filtri.dipendente = e.target.value; disegna(); });
  on('#f-com', 'input', (e) => {
    U.filtri.commessa = e.target.value;
    const pos = e.target.selectionStart;
    disegna();
    const c = $('#f-com'); c.focus(); c.setSelectionRange(pos, pos);
  });
  on('#f-eli', 'change', (e) => { U.filtri.conEliminate = e.target.checked; disegna(); });
  on('#x-nuove', 'change', (e) => { U.soloNuove = e.target.checked; disegna(); });
  on('#esporta', 'click', esporta);
  // correzioni
  on('[data-correggi]', 'click', (e) => { U.modifica = e.currentTarget.dataset.correggi; U.confermaElimina = false; disegna(); $('#pannello-modifica')?.scrollIntoView(); });
  on('[data-ripristina]', 'click', (e) => salvaCorrezioni(L.segnaEliminata(U.correzioni, e.currentTarget.dataset.ripristina, false), 'Riga ripristinata.'));
  const ricalcolaMinuti = () => {
    const a = minutiDaOra($('#e-ini').value), b = minutiDaOra($('#e-fin').value);
    if (a != null && b != null) $('#e-min').value = (b - a + 1440) % 1440;
  };
  on('#e-ini', 'change', ricalcolaMinuti);
  on('#e-fin', 'change', ricalcolaMinuti);
  on('#e-x', 'click', () => { U.modifica = null; disegna(); });
  on('#e-eli', 'click', () => { U.confermaElimina = true; disegna(); });
  on('#e-eli-no', 'click', () => { U.confermaElimina = false; disegna(); });
  on('#e-eli-si', 'click', () => salvaCorrezioni(L.segnaEliminata(U.correzioni, U.modifica, true), 'Riga eliminata. Si può ripristinare da «Mostra eliminate».'));
  on('#e-togli', 'click', () => { const r = U.righe.find((x) => x.id === U.modifica); salvaCorrezioni(L.aggiornaCorrezione(U.correzioni, r._originale, {}), 'Tornata ai valori originali.'); });
  on('#e-salva', 'click', salvaModifica);
  // anagrafiche
  on('[data-sez]', 'click', (e) => { U.ana.sezione = e.currentTarget.dataset.sez; U.ana.voce = null; disegna(); });
  on('#a-cerca', 'input', (e) => {
    U.ana.cerca = e.target.value;
    const pos = e.target.selectionStart;
    disegna();
    const c = $('#a-cerca'); c.focus(); c.setSelectionRange(pos, pos);
  });
  on('#a-nuova', 'click', () => { U.ana.voce = { i: null }; disegna(); });
  on('[data-voce]', 'click', (e) => { U.ana.voce = { i: Number(e.currentTarget.dataset.voce) }; disegna(); $('#pannello-voce')?.scrollIntoView(); });
  on('#v-x', 'click', () => { U.ana.voce = null; disegna(); });
  on('#v-salva', 'click', salvaVoce);
  on('#a-azienda', 'change', (e) => salvaAnagrafiche({ ...U.anagrafiche, azienda: e.target.value }, 'Nome azienda salvato.'));
  on('#a-file', 'change', (e) => { if (e.target.files[0]) leggiFileExcel(e.target.files[0]); });
  on('#imp-x', 'click', () => { U.ana.importa = null; disegna(); });
  on('#imp-ok', 'click', () => salvaAnagrafiche(L.unisciAnagrafiche(U.anagrafiche, U.ana.importa.dati).anagrafiche, 'Anagrafiche importate e salvate.'));
}

/* ---------- avvio: se c'è una cartella ricordata, si riapre (col permesso del browser) ---------- */
(async function avvio() {
  try {
    const h = await memoria('readonly', (s) => s.get('cartella'));
    if (h) {
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') { await usaCartella(h); return; }
      U.daRiaprire = h;
    }
  } catch { /* nessuna cartella ricordata */ }
  disegna();
})();
