/**
 * Rapportini provvisori — ricevitore su Google Drive.
 *
 * doPost: riceve un invio dal tablet e crea UN FILE NUOVO in /invii/. Risponde con gli ID ricevuti.
 * doGet:  restituisce il contenuto di /anagrafiche/anagrafiche.json.
 *
 * Questo script non modifica e non cancella mai file esistenti.
 *
 * Proprietà da impostare in "Impostazioni progetto > Proprietà script":
 *   TOKEN        la parola segreta condivisa con i tablet
 *   ID_CARTELLA  l'ID della cartella Drive dell'archivio
 */

var LIMITE_RIGHE = 2000;           // un invio più grande di così non è normale
var FUSO = 'Europe/Rome';
var RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var RE_TABLET = /^[A-Z0-9_-]{1,20}$/;

function doPost(e) {
  try {
    var corpo = JSON.parse(e.postData.contents);
    controllaToken_(corpo.token);
    var errore = controllaInvio_(corpo);
    if (errore) return risposta_({ ok: false, errore: errore });

    var adesso = new Date();
    var ids = corpo.righe.map(function (r) { return r.id; });
    var nome = 'RAP_' + corpo.codiceTablet + '_' + nomeSicuro_(corpo.dipendente) + '_' +
      Utilities.formatDate(adesso, FUSO, 'yyyyMMdd-HHmmss') + '.json';
    var contenuto = {
      versione: 1,
      codiceTablet: corpo.codiceTablet,
      dipendente: corpo.dipendente,
      ricevutoIl: adesso.toISOString(),
      righe: corpo.righe
    };

    // Ogni invio è un file a sé: due tablet insieme non possono darsi fastidio.
    // Se due invii hanno lo stesso nome, Drive tiene entrambi i file.
    sottocartella_('invii').createFile(nome, JSON.stringify(contenuto, null, 1), 'application/json');
    return risposta_({ ok: true, file: nome, idRicevuti: ids });
  } catch (err) {
    return risposta_({ ok: false, errore: messaggio_(err) });
  }
}

function doGet(e) {
  try {
    controllaToken_(e.parameter.token);
    var file = sottocartella_('anagrafiche').getFilesByName('anagrafiche.json');
    // Se per un conflitto di sincronizzazione ce ne fosse più di uno, vale il più recente
    var scelto = null;
    while (file.hasNext()) {
      var f = file.next();
      if (!scelto || f.getLastUpdated() > scelto.getLastUpdated()) scelto = f;
    }
    if (!scelto) return risposta_({ ok: false, errore: 'Il file anagrafiche.json non esiste ancora: crealo dall\'app ufficio.' });
    return risposta_({ ok: true, anagrafiche: JSON.parse(scelto.getBlob().getDataAsString('UTF-8')) });
  } catch (err) {
    return risposta_({ ok: false, errore: messaggio_(err) });
  }
}

/**
 * Da eseguire UNA VOLTA dall'editor, come prima cosa: chiede a Google le autorizzazioni,
 * controlla le proprietà e crea le sottocartelle che mancano.
 */
function prepara() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('TOKEN')) throw new Error('Manca la proprietà TOKEN.');
  if (!p.getProperty('ID_CARTELLA')) throw new Error('Manca la proprietà ID_CARTELLA.');
  var radice = DriveApp.getFolderById(p.getProperty('ID_CARTELLA'));
  ['anagrafiche', 'invii', 'ufficio'].forEach(function (n) {
    if (!radice.getFoldersByName(n).hasNext()) { radice.createFolder(n); Logger.log('Creata la cartella ' + n); }
  });
  Logger.log('Tutto pronto nella cartella: ' + radice.getName());
}

/* ---------- funzioni di servizio (il trattino finale le nasconde dall'esterno) ---------- */

function controllaToken_(token) {
  var atteso = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!atteso) throw new Error('Script non configurato: manca la proprietà TOKEN.');
  if (typeof token !== 'string' || token !== atteso) throw new Error('Token non valido.');
}

function controllaInvio_(c) {
  if (typeof c.codiceTablet !== 'string' || !RE_TABLET.test(c.codiceTablet)) return 'Codice tablet non valido.';
  if (typeof c.dipendente !== 'string' || !c.dipendente.trim()) return 'Dipendente mancante.';
  if (!Array.isArray(c.righe) || c.righe.length === 0) return 'Nessuna riga nell\'invio.';
  if (c.righe.length > LIMITE_RIGHE) return 'Troppe righe in un solo invio.';
  for (var i = 0; i < c.righe.length; i++) {
    if (!c.righe[i] || !RE_UUID.test(String(c.righe[i].id))) return 'Riga senza identificativo valido.';
  }
  return '';
}

function sottocartella_(nome) {
  var id = PropertiesService.getScriptProperties().getProperty('ID_CARTELLA');
  if (!id) throw new Error('Script non configurato: manca la proprietà ID_CARTELLA.');
  var trovate = DriveApp.getFolderById(id).getFoldersByName(nome);
  if (!trovate.hasNext()) throw new Error('Nella cartella manca la sottocartella "' + nome + '": esegui la funzione prepara.');
  return trovate.next();
}

/** Toglie dal nome del dipendente i caratteri che darebbero fastidio nel nome di un file. */
function nomeSicuro_(s) {
  return String(s).trim().replace(/[^A-Za-z0-9À-ÿ.-]+/g, '-').slice(0, 40);
}

function messaggio_(err) {
  return (err && err.message) ? err.message : String(err);
}

function risposta_(oggetto) {
  return ContentService.createTextOutput(JSON.stringify(oggetto)).setMimeType(ContentService.MimeType.JSON);
}
