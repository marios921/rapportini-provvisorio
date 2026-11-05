/*
 * Ambiente di prova: esegue il VERO file apps-script/Codice.gs in Node, con un finto Google Drive
 * appoggiato a una cartella locale, e lo espone in HTTP imitando il comportamento di Google:
 *   - nessuna risposta alla richiesta preliminare OPTIONS (per questo il tablet usa text/plain)
 *   - risposta dopo un reindirizzamento 302 verso un altro indirizzo (Google usa script.googleusercontent.com)
 *   - permesso a tutte le origini, sul reindirizzamento e sulla risposta finale
 * Non sostituisce la prova su Google vera: quella è nel README, parte "Procedura di prova".
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');

/* ---------- finti servizi Google ---------- */
function iteratore(lista) { let i = 0; return { hasNext: () => i < lista.length, next: () => lista[i++] }; }

function fileDrive(p) {
  return {
    getLastUpdated: () => fs.statSync(p).mtime,
    getBlob: () => ({ getDataAsString: () => fs.readFileSync(p, 'utf8') }),
  };
}
function cartellaDrive(dir) {
  return {
    getName: () => path.basename(dir),
    getFoldersByName: (n) => iteratore(fs.existsSync(path.join(dir, n)) ? [cartellaDrive(path.join(dir, n))] : []),
    getFilesByName: (n) => iteratore(fs.existsSync(path.join(dir, n)) ? [fileDrive(path.join(dir, n))] : []),
    createFolder: (n) => { fs.mkdirSync(path.join(dir, n)); return cartellaDrive(path.join(dir, n)); },
    createFile: (nome, contenuto) => {
      // Come Drive: due file con lo stesso nome convivono. La sincronizzazione locale aggiunge " (1)".
      let finale = nome, k = 0;
      while (fs.existsSync(path.join(dir, finale))) finale = nome.replace(/\.json$/, ` (${++k}).json`);
      fs.writeFileSync(path.join(dir, finale), contenuto, { flag: 'wx' });
      return fileDrive(path.join(dir, finale));
    },
  };
}

function caricaScript({ cartella, token }) {
  const proprieta = { TOKEN: token, ID_CARTELLA: 'ID-PROVA' };
  const contesto = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => proprieta[k] ?? null }) },
    DriveApp: { getFolderById: (id) => { if (id !== 'ID-PROVA') throw new Error('Cartella inesistente'); return cartellaDrive(cartella); } },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (t) => { const o = { testo: t, setMimeType: () => o }; return o; },
    },
    Utilities: {
      formatDate: (d) => {
        const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'medium' }).format(d);
        return p.replace(/-/g, '').replace(' ', '-').replace(/:/g, '');
      },
    },
    Logger: { log: () => {} },
    JSON, Date, String, Array, Error,
  };
  vm.createContext(contesto);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Codice.gs'), 'utf8'), contesto, { filename: 'Codice.gs' });
  return contesto;
}

/* ---------- finto servizio HTTP ---------- */
function avviaServer({ cartella, token, porta = 0 }) {
  const script = caricaScript({ cartella, token });
  const risposte = new Map();
  const stato = { spento: false };

  const server = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://localhost');
    if (stato.spento) { rq.socket.destroy(); return; }
    if (rq.method === 'OPTIONS') { rs.writeHead(405); rs.end(); return; } // Google non gestisce il preliminare
    if (u.pathname === '/risposta') {
      const t = risposte.get(u.searchParams.get('id'));
      rs.writeHead(t ? 200 : 404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      rs.end(t || '');
      return;
    }
    const pezzi = [];
    rq.on('data', (d) => pezzi.push(d));
    rq.on('end', () => {
      let uscita;
      if (rq.method === 'POST') {
        uscita = script.doPost({ postData: { contents: Buffer.concat(pezzi).toString('utf8') } });
      } else {
        uscita = script.doGet({ parameter: Object.fromEntries(u.searchParams) });
      }
      const id = crypto.randomUUID();
      risposte.set(id, uscita.testo);
      const porta = server.address().port;
      rs.writeHead(302, { Location: `http://localhost:${porta}/risposta?id=${id}`, 'Access-Control-Allow-Origin': '*' });
      rs.end();
    });
  });
  return new Promise((ok) => server.listen(porta, '127.0.0.1', () => ok({
    server, stato, script,
    url: `http://127.0.0.1:${server.address().port}/exec`,
    chiudi: () => new Promise((fine) => { server.closeAllConnections(); server.close(fine); }),
  })));
}

/* ---------- servitore dei file dell'applicazione ---------- */
const TIPI = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
function avviaSitoStatico(radice = path.join(__dirname, '..'), porta = 0) {
  const server = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://localhost');
    let p = path.normalize(path.join(radice, decodeURIComponent(u.pathname)));
    if (!p.startsWith(radice)) { rs.writeHead(403); rs.end(); return; }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { 'Content-Type': TIPI[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(p).pipe(rs);
  });
  return new Promise((ok) => server.listen(porta, '127.0.0.1', () => ok({
    server,
    // localhost e non 127.0.0.1: così l'indirizzo è diverso da quello dello script, come in produzione
    url: `http://localhost:${server.address().port}`,
    chiudi: () => new Promise((fine) => { server.closeAllConnections(); server.close(fine); }),
  })));
}

module.exports = { avviaServer, avviaSitoStatico, caricaScript };
