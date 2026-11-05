/* Nessun dato reale nei file destinati al repository. I valori da cercare si leggono da riferimenti/, che resta solo in locale. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('../ufficio/vendor/xlsx.full.min.js');
XLSX.set_fs(require('node:fs')); // la copia per browser non ha accesso al disco se non glielo si dà

const RADICE = path.join(__dirname, '..');
const RIF = path.join(RADICE, '..', 'piattaforma-controllo', 'riferimenti');
const FILE_REALE = fs.existsSync(RIF) ? path.join(RIF, fs.readdirSync(RIF).find((n) => /_Rapportini_2026\.xlsx$/.test(n)) || 'manca') : 'manca';
const PROTOTIPO = path.join(RIF, 'prototipo_rapportino_tablet.html');

function fileDelProgetto(dir = RADICE) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', 'vendor', 'dati', 'risultati', '.git'].includes(e.name)) return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return fileDelProgetto(p);
    return /\.(js|json|gs|md|html|css|webmanifest)$/.test(e.name) && e.name !== 'package-lock.json' ? [p] : [];
  });
}

test('il repository non contiene nomi di clienti, dipendenti o codici reali', { skip: !fs.existsSync(FILE_REALE) || !fs.existsSync(PROTOTIPO) }, () => {
  const wb = XLSX.readFile(FILE_REALE);
  const righe = XLSX.utils.sheet_to_json(wb.Sheets.COMMESSE, { header: 1, range: 5 });
  const seed = JSON.parse(fs.readFileSync(PROTOTIPO, 'utf8').match(/<script type="application\/json" id="seed">(.*?)<\/script>/s)[1]);
  const vietati = new Set([String.fromCharCode(101, 102, 102, 101, 99, 105)]); // il nome dell'azienda, scritto così per non comparire qui
  for (const r of righe) {
    if (r[1] && String(r[1]).length >= 3) vietati.add(String(r[1]).trim().toLowerCase());
    // codici di almeno 5 caratteri: quelli brevi potrebbero coincidere con numeri qualunque
    if (r[0] && String(r[0]).length >= 5 && !/^\d{2}\/\d{2}\/\d{4}$/.test(r[0])) vietati.add(String(r[0]).trim().toLowerCase());
  }
  for (const d of seed.dip) vietati.add(d.toLowerCase());
  const trovati = [];
  for (const f of fileDelProgetto()) {
    const testo = fs.readFileSync(f, 'utf8').toLowerCase();
    for (const v of vietati) if (new RegExp(`(^|[^a-zà-ÿ0-9])${v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^a-zà-ÿ0-9])`).test(testo)) trovati.push(path.relative(RADICE, f) + ': ' + v);
  }
  assert.deepEqual(trovati, []);
});

test('il repository non contiene token o indirizzi reali di script', () => {
  for (const f of fileDelProgetto()) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /script\.google\.com\/macros\/s\/AKfyc/, f);
  }
});

test('nel file di esempio i PIN non sono in chiaro', () => {
  const a = JSON.parse(fs.readFileSync(path.join(RADICE, 'esempi', 'anagrafiche.esempio.json'), 'utf8'));
  for (const d of a.dipendenti) { assert.ok(d.pinHash); assert.ok(!('pin' in d)); }
});
