/*
 * Crea esempi/anagrafiche.esempio.json: dati inventati, adatti a stare nel repository.
 * Il PIN di tutti i dipendenti di esempio è 1234.
 */
const fs = require('node:fs');
const path = require('node:path');
const L = require('../comune/logica.js');
(async () => {
  const dipendenti = [];
  for (const nome of ['Operatore 1', 'Operatore 2', 'Operatore 3', 'Operatore 4']) dipendenti.push({ nome, reparto: 'Reparto A', attivo: true, ...(await L.creaPin('1234')) });
  const commesse = [
    ['OA99-0001', 'ALFA', 'Cablaggio esempio', 60], ['OA99-0002', 'ALFA', '', 250], ['OA99-0003', 'ALFA', '', 600],
    ['1001', 'BETA', '', 1000], ['1002', 'BETA', '', 500], ['901/CL', 'GAMMA', '', 60], ['902/CL', 'GAMMA', '', 63],
    ['0042', 'GAMMA', 'Codice con zero iniziale: deve restare 0042', 10], ['5390001', 'DELTA', '', 400], ['5390002', 'DELTA', '', 150],
    ['06/07/2026', 'EPSILON', 'Codice con aspetto di data: deve restare testo', 120], ['9/12', 'EPSILON', 'Excel lo trasformerebbe in data', 15],
  ].map(([codice, cliente, descrizione, pezziOrdine]) => ({ codice, cliente, descrizione, pezziOrdine, attiva: true }));
  const lavorazioni = [
    ['Taglio a misura', false], ['Spellatura', false], ['Crimpatura', false], ['Cablaggio', false], ['Assemblaggio', false],
    ['Chiusura', true], ['Collaudo', true], ['Imballo', true], ['ALTRO (specificare nelle note)', false],
  ].map(([nome, contaPezziFiniti]) => ({ nome, contaPezziFiniti, attiva: true }));
  const a = { versione: 1, azienda: 'Azienda di esempio', aggiornatoIl: '2026-01-01T08:00:00.000Z', commesse, lavorazioni, dipendenti };
  fs.mkdirSync(path.join(__dirname, '..', 'esempi'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'esempi', 'anagrafiche.esempio.json'), JSON.stringify(a, null, 1) + '\n');
})();
