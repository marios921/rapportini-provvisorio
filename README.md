# Rapportini di produzione — soluzione provvisoria

Soluzione temporanea, in attesa della versione definitiva su server (`piattaforma-controllo`). Non c'è né database né server propri: i dati stanno in una cartella Google Drive.

| Parte | Cartella | A cosa serve |
|---|---|---|
| App tablet (PWA) | `tablet/` | I dipendenti registrano le lavorazioni, anche senza rete, e le inviano |
| Script Google | `apps-script/` | Riceve gli invii e scrive su Drive; dà ai tablet le anagrafiche |
| App ufficio | `ufficio/` | Legge la cartella sincronizzata, corregge, gestisce le anagrafiche, esporta in Excel |
| Logica comune | `comune/` | Calcoli e formato dati usati da tablet, ufficio e test |

**Regola fondamentale:** nessun file viene mai modificato da due dispositivi. Ogni invio crea un file nuovo che non cambia più; l'ufficio scrive solo nei propri tre file.

```
<AZIENDA>_Rapportini/                 il nome è libero: conta l'ID della cartella
├── anagrafiche/anagrafiche.json      commesse, lavorazioni, dipendenti (scritto SOLO dall'ufficio)
├── invii/RAP_TAB01_Nome_20261105-173000.json   un file per invio (scritto SOLO dallo script)
└── ufficio/
    ├── correzioni.json               correzioni ed eliminazioni (scritto SOLO dall'ufficio)
    └── importati.json                righe già esportate in Excel (scritto SOLO dall'ufficio)
```

---

## 1. Pubblicare lo script Google

Da fare **con l'account Google che possiede la cartella**.

**Prima: la cartella e il token**

1. Su Google Drive crea la cartella dell'archivio. Aprila e copia la parte finale dell'indirizzo, dopo `/folders/`: è l'**ID della cartella**.
2. Prepara il **token**, una parola segreta lunga. Sul Mac puoi generarla col comando qui sotto. Non scriverlo mai in file che finiscono su GitHub.

```bash
openssl rand -hex 24
```

**Lo script**

3. Vai su [script.google.com](https://script.google.com) → **Nuovo progetto**. Dagli un nome, ad esempio *Rapportini*.
4. Cancella il contenuto dell'editor e incolla tutto `apps-script/Codice.gs`. Salva.
5. Rotella a sinistra (**Impostazioni progetto**) → **Proprietà script** → **Aggiungi proprietà**:
   - `TOKEN` → il token del punto 2
   - `ID_CARTELLA` → l'ID del punto 1
6. Torna nell'editor, scegli la funzione **`prepara`** nel menu in alto e premi **Esegui**. Google chiede le autorizzazioni: concedile (*Avanzate → Vai a Rapportini*, perché lo script è tuo e non verificato). Crea le tre sottocartelle.

**La pubblicazione**

7. **Esegui il deployment → Nuovo deployment** → ingranaggio → **App web**:
   - **Esegui come: Me**
   - **Chi ha accesso: Chiunque**
8. **Esegui il deployment** e copia l'**URL dell'app web** (finisce con `/exec`).

**Controllo:** nel browser apri l'URL aggiungendo `?token=IL_TUO_TOKEN`. Finché le anagrafiche non esistono devi leggere `"ok":false` con il messaggio *Il file anagrafiche.json non esiste ancora*. Se vedi una pagina di accesso Google, l'accesso non è su *Chiunque*.

> **Se modifichi lo script:** **Esegui il deployment → Gestisci i deployment → matita → Versione: Nuova versione**. Così l'indirizzo non cambia. Un "Nuovo deployment" creerebbe un indirizzo diverso, da reinserire su ogni tablet.

> **Se il token finisce in mani sbagliate:** cambia la proprietà `TOKEN` e reinseriscilo sui tablet. "Chiunque" significa che l'indirizzo è raggiungibile da internet: l'unica protezione è il token.

---

## 2. Mettere online l'app tablet

Una PWA si installa solo da un indirizzo `https`. Il modo più semplice è GitHub Pages:

1. Crea su GitHub un repository con questa cartella. Nel repository **non ci sono dati reali**, né token: stanno solo su Drive e sui tablet. Le pagine gratuite richiedono un repository pubblico.
2. **Settings → Pages → Deploy from a branch**, ramo `main`, cartella `/ (root)`.
3. L'app sarà a `https://<utente>.github.io/<repository>/tablet/`.

Va pubblicata la cartella intera, non solo `tablet/`, perché l'app usa anche `comune/`.

## 3. Installare la PWA

Va installata e poi configurata **dall'icona**: su iPad il browser e l'app installata hanno archivi separati.

**Android (Chrome):** apri l'indirizzo → menu ⋮ → **Installa app** (o *Aggiungi a schermata Home*).

**iPad (Safari, non altri browser):** apri l'indirizzo → **Condividi** → **Aggiungi alla schermata Home**.

**Alla prima apertura dall'icona** inserisci:

- **Codice tablet**, diverso per ogni dispositivo: `TAB01`, `TAB02`, …
- **Indirizzo dello script** (punto 8)
- **Token**

Serve la rete, perché il tablet scarica le anagrafiche: crea prima `anagrafiche.json` dall'ufficio (parte 4).

**Da sapere:**

- **Non disinstallare l'app** e non cancellare i dati del browser: le righe non ancora inviate andrebbero perse. Prima guarda *Stato invii*.
- **L'invio avviene solo con l'app aperta.** Un tablet con righe in attesa le invia alla riapertura. Non c'è invio in sottofondo.

## 4. Configurare il PC dell'ufficio

**Un solo PC alla volta** deve usare l'app ufficio. Se il file è cambiato altrove, l'app si ferma e chiede di aggiornare, ma due PC restano da evitare.

1. Installa **Google Drive per desktop** con l'account che possiede la cartella.
2. In Drive per desktop, scegli **Mirroring** (*Preferenze → Google Drive*), oppure tasto destro sulla cartella → **Disponibile offline**. Altrimenti ogni file viene scaricato al momento e la lettura può diventare lenta.
3. Apri in **Chrome o Edge** `https://<utente>.github.io/<repository>/ufficio/`. In alternativa, fai doppio clic su `ufficio/index.html` da una copia locale, con accanto la cartella `comune/`.
4. **Scegli la cartella** dell'archivio e concedi l'accesso in modifica. Viene ricordata; alla riapertura il browser può chiedere di confermare con un clic.
5. **Anagrafiche → Importa dal file Excel dei rapportini**: scegli il file annuale, controlla l'anteprima e gli avvisi, **Conferma**. Commesse, lavorazioni e dipendenti vengono letti dai fogli del file.
6. **Anagrafiche → Dipendenti → Modifica**: assegna a ciascuno un **PIN di 4 cifre**. Senza PIN il dipendente non può entrare. Il PIN non si può rileggere: se viene dimenticato se ne assegna uno nuovo.

### Portare le righe nel file Excel

1. **Esporta** (con *Solo righe non ancora esportate* attivo).
2. Nel file scaricato, foglio **RAPPORTINI**: copia dalla riga 2 in giù.
3. Nel file annuale: prima riga libera della colonna A → **Incolla valori**. Le colonne K–O sono formule già pronte e vanno lasciate stare.
4. Se c'è il foglio **CORREZIONI_DA_RIPORTARE**: quelle righe sono già nel file annuale e sono cambiate dopo. Vanno corrette a mano (PRIMA → DOPO), oppure eliminate. Non si reincollano, perché si conterebbero due volte. Ogni voce viene proposta una volta sola.

---

## 5. Procedura di prova

Prima di consegnare ai reparti, con dati veri ma senza fretta. Sono i passaggi che i test automatici **non** possono coprire, perché richiedono Google e i dispositivi reali.

| # | Cosa fare | Cosa deve succedere |
|---|---|---|
| 1 | Configura un tablet col token **sbagliato** | Errore *Token non valido* |
| 2 | Configuralo col token giusto | Compaiono i nomi dei dipendenti |
| 3 | Entra col PIN sbagliato, poi con quello giusto | Rifiuto, poi accesso |
| 4 | Nuova lavorazione, cerca una commessa, avvia | Parte il cronometro |
| 5 | Chiudi l'app, riaprila dall'icona | Il cronometro continua |
| 6 | Fine lavorazione, inserisci i pezzi | Riga *Inviata*; su Drive compare un file in `invii/` |
| 7 | **Modalità aereo**. Chiudi e riapri l'app, inserisci due righe a mano | L'app funziona; *2 da inviare* |
| 8 | Togli la modalità aereo, con l'app aperta | Entro un minuto *Tutto inviato*, senza toccare nulla |
| 9 | **Due tablet**, stesso momento: *Invia all'ufficio* | Due file distinti su Drive |
| 10 | Sul PC, attendi la sincronizzazione e premi **Aggiorna** | Tutte le righe; ultimo invio per ogni tablet |
| 11 | Su Drive duplica un file di `invii/`, attendi, **Aggiorna** | Stesso numero di righe; *doppione scartato* |
| 12 | **Correggi** una riga, riapri l'app ufficio | La correzione resta; il file in `invii/` non è cambiato |
| 13 | **Esporta**, incolla nel file annuale, caricalo su Controllo Commesse | Colonna CONTROLLO su *OK*; i numeri tornano |
| 14 | Correggi una riga già esportata, **Esporta** di nuovo | La riga è in CORREZIONI_DA_RIPORTARE, non in RAPPORTINI |
| 15 | Modifica una commessa dall'ufficio; sul tablet *Aggiorna anagrafiche* | La modifica arriva (dopo la sincronizzazione di Drive) |

### Provare in locale, senza Google

Serve Node.js. Il comando esegue lo script vero su un finto Drive nella cartella `dati/`, esclusa dal repository, e stampa indirizzi e dati da inserire.

```bash
npm install
```

```bash
npm run server-prova
```

### Test automatici

Usano Google Chrome già installato sul PC.

```bash
npm test
```

Coprono la logica, il vero `Codice.gs` e i due programmi veri nel browser. I file reali di `riferimenti/` si usano solo se presenti: controllano che l'esportazione sia letta da Controllo Commesse e che nel repository non finiscano dati reali.

---

## Migrazione alla piattaforma definitiva

Ogni riga usa i nomi di campo di `righe_rapportino` in `piattaforma-controllo`: `id`, `data`, `dipendente`, `commessa`, `codiceArticolo`, `lavorazione`, `inizioMinuti`, `fineMinuti`, `minuti`, `pezzi`, `note`, `origine` (`tablet`). L'`id` è un UUID che non cambia mai.

Per importare: leggere `invii/`, togliere i doppioni per `id` (`unisciInvii` in `comune/logica.js`) e applicare `correzioni.json` (`applicaCorrezioni`). I campi `manuale`, `codiceTablet`, `inizioIl`, `fineIl`, `creatoIl` servono alla tracciabilità.

## Limiti noti

- **I dati non sono in tempo reale**: l'ufficio vede solo ciò che è stato inviato e sincronizzato. Le lavorazioni aperte sul tablet non si vedono in ufficio.
- **Sicurezza da soluzione provvisoria**: token nell'indirizzo delle letture (Apps Script non legge le intestazioni), PIN di sole 4 cifre. Nel file c'è solo un'impronta del PIN, ma chi ha il file e sa come fare può risalire a 4 cifre con pochi tentativi. Accesso alla cartella Drive e token vanno limitati a chi serve.
- **Dati personali**: nomi dei dipendenti e tempi di lavoro stanno su un account Google. Vale la stessa attenzione indicata in `piattaforma-controllo/docs/PRIVACY.md`.
- **Molti file**: ogni invio è un file. Con migliaia di file la lettura rallenta. È un limite accettabile per un periodo di mesi.
