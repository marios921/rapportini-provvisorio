/*
 * Prova a mano sul proprio computer, senza Google: npm run server-prova
 * Crea la cartella dati/ (esclusa dal repository) che fa da finto Drive.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { avviaServer, avviaSitoStatico } = require('./finto-apps-script.js');
const DATI = path.join(__dirname, '..', 'dati');
(async () => {
  for (const d of ['anagrafiche', 'invii', 'ufficio']) fs.mkdirSync(path.join(DATI, d), { recursive: true });
  const ana = path.join(DATI, 'anagrafiche', 'anagrafiche.json');
  if (!fs.existsSync(ana)) fs.copyFileSync(path.join(__dirname, '..', 'esempi', 'anagrafiche.esempio.json'), ana);
  const script = await avviaServer({ cartella: DATI, token: 'prova', porta: 8901 });
  const sito = await avviaSitoStatico(undefined, 8900);
  console.log(`\nTablet:  ${sito.url}/tablet/\nUfficio: ${sito.url}/ufficio/\n\nPrima configurazione del tablet:\n  codice  TAB01\n  script  ${script.url}\n  token   prova\n\nPIN di tutti i dipendenti di esempio: 1234\nCartella da aprire dall'ufficio: ${DATI}\nPer fermare: Ctrl+C\n`);
})();
