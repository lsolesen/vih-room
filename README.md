# 🏡 Værelsesfordeling – Kriterier og Regler

Dette dokument beskriver de nøjagtige regler, prioriteter og pointvægte, som fordelingsalgoritmen bruger i `app.js` og `settings.js`.  
Hvis du vil ændre i kriterierne senere, kan du rette direkte i teksten/tallene herunder og sende filen tilbage.

---

## 1. Datakilder og Perioder

- **Fælles værelsesliste (Google Sheets CSV):** Indeholder alle skolens værelser, sengepladser (`Pladser`), værelsestype, prioritet (`1`, `2`, `3`), eventuelt fast køn samt om værelset er aktivt (`Aktiv`).
- **Elevlister per periode (Google Sheets CSV):** Hver fane (`Periode 1`, `Værelsesskift 1`, `Værelsesskift 2` osv.) har sin egen elevliste.
- **Opdatering uden tab af fordeling:** Når du trykker **Hent data fra ark**, bevares alle eksisterende værelsesplaceringer i den aktive periode. Nye elever i arket lægges i puljen *Elever uden værelse*, stoppede elever fjernes automatisk, og nye begrænsninger tjekkes straks.
- **Automatisk registrering af nye og stoppede elever (ved værelsesskift):**
  - Elever, der ikke optræder i nogen tidligere periode-fane, markeres automatisk som **Ny elev** (`✨ Ny`), medmindre kolonnen `Ny_Elev` i arket aktivt angiver noget andet.
  - Elever fra tidligere perioder, som ikke længere findes i den nye elevliste, sorteres automatisk fra som stoppede.

---

## 2. Ufravigelige regler (Hårde begrænsninger)

Algoritmen bryder **aldrig** disse regler ved automatisk fordeling (kun ved manuel drag-and-drop kan du midlertidigt overbelægge eller skabe en konflikt, som derefter markeres visuelt på kortet):

1. **Forhåndslåste værelser (`🔒`):**
   - Elever med et værelsesnummer i elevarkets kolonne `Værelse` / `Låst værelse` placeres og låses fast på det værelse.
   - Elever, der flyttes manuelt med drag-and-drop eller vælges via klik på en ledig seng, låses automatisk (`🔒`).
2. **Kapacitet og aktive værelser:**
   - Der placeres aldrig flere elever på et værelse, end der er sengepladser (`Pladser`).
   - Værelser markeret med `NEJ`, `Lukket`, `Inaktiv` eller `0` i kolonnen `Aktiv` ignoreres.
3. **Kønsopdeling og delt bad/toilet (A/B-værelser):**
   - Værelser med samme grundnummer (f.eks. `214A` og `214B`) regnes som én samlet enhed med delt bad og toilet.
   - Har værelset et fast kønskrav (`Dreng`, `Pige`, `Ikke-binær`), overholdes det.
   - Er værelset sat til `Fri`, bestemmer den første elev, der placeres i værelset eller A/B-gruppen, kønnet for hele enheden. Elever med kønnet `Fri` kan placeres overalt.
4. **"Ikke på værelse med" (`Ikke_Med`):**
   - Kommasepareret liste over fulde navne (eller `Elev ID`) i kolonnen `Ikke_Med` (f.eks. `Navn 1, Navn 2, Navn 3`).
   - Reglen virker automatisk begge veje – det behøver kun stå ud for den ene elev.
   - **Standardindstilling (`abStrictExclude = true`):** To personer på `Ikke_Med`-listen må **heller ikke** bo i hver sin halvdel af et delt bad-par (`A` og `B`).
5. **Fravalg af international (`Fravaelg_International`):**
   - Alle elever med et andet land end `DK`, `Danmark` eller `Denmark` (eller tomt felt) tæller som **International** (`🌍`).
   - En elev med `JA` i `Fravaelg_International` sættes aldrig på værelse med en international elev.
   - **Standardindstilling (`abStrictInternat = false`):** Gælder kun selve værelset (ikke A/B-makkerværelset), medmindre fluebenet slås til under *Indstillinger*.

---

## 3. Prioriteter og pointvægte (Bløde kriterier)

Algoritmen kører **200 tilfældige gennemløb** (fordelt på 4 strategier: streng værelsesprioritet, 2-mandsværelser først, 3+ mandsværelser først og høj variation) efterfulgt af **150 bytte-optimeringer** per gennemløb, og vælger den løsning med højest samlet score.

Elever med flest begrænsninger placeres først i hvert gennemløb (`Ikke-binær`: +10, per `Ikke_Med`-person: +3, `Fravaelg_International`: +2).

### Pointtabel for den samlede fordeling

| Kriterie | Regel / Effekt i koden | Pointvægt |
| :--- | :--- | :--- |
| **Alle elever skal have plads** | Hård straf per elev, der ikke kan placeres uden regelbrud | `-100.000` pr. elev |
| **Undgå eneværelse på flersengsværelser** | Straf hvis et værelse med `2+` sengepladser ender med kun `1` beboer (ægte 1-mandsværelser straffes ikke) | `-5.000` pr. værelse (`+140` ved opfyldning) |
| **Spred nye elever** (`avoidTwoNew = true`) | Nye elever skal bo sammen med erfarne elever – ikke med hinanden | `-600` pr. ekstra ny elev på værelset (`-350` under placering, `-25` i A/B-naboværelse) |
| **Spred internationale elever** | Internationale elever fordeles på forskellige værelser blandt danske elever | `-400` pr. ekstra international elev på værelset (`-250` under placering) |
| **Værelsesprioritet (`1`, `2`, `3`)** | Værelser med `Prio 1` fyldes før `Prio 2`, og `Prio 3` bruges til sidst | `-200 × Prioritet × antal beboere` |
| **Fyld hele bad-gruppen (A + B) op** | Begge værelser i et A/B-par fyldes op, før et nyt A/B-par åbnes | `-120` hvis kun ét af to A/B-værelser er taget i brug (`+65` for makkerværelset) |

### Pointtabel for værelsesskift (Historik på tværs af ALLE tidligere perioder)

Appen sammenligner med **samtlige** tidligere periode-faner, men vægter den **umiddelbart forrige periode** højest:

| Kriterie | Umiddelbart forrige periode | Ældre perioder før den forrige |
| :--- | :--- | :--- |
| **Undgå tidligere roomies** | `-85` pr. gentaget roomie-par | `-45` pr. gentaget roomie-par |
| **Undgå samme værelsesnummer** | `-60` | `-35` |
| **Ny etage** *(udledt af 1. ciffer i værelsesnr., f.eks. `214` = Etage 2)* | `-30` | `-15` |
| **Ny værelsestype** *(kolonnen `Vaerelsestype`)* | `-25` | `-12` |

---

## 4. Visuelle advarsler og statusoversigt

- **Konfliktmarkering på værelseskort:** Hvis en manuel flytning eller en ny begrænsning i regnearket medfører en konflikt (`Ikke_Med`, `Fravaelg_International` eller blandede køn), markeres værelset med orange ramme, `⚠️ Konflikt`-badge og en forklaring på kortet.
- **Overbelægning:** Trækkes en elev ind på et fyldt værelse, markeres værelset med rød ramme og antal overskydende elever.
- **Statuspanel på værelsesskift:** Måler løbende procentdelen af placerede elever, der har fået **Nye roomies**, **Nye elever spredt**, **Ny etage**, **Ny værelsestype** og **Nyt værelse** sammenlignet med alle tidligere perioder.

---

## 5. Noter til fremtidige ændringer *(udfyld her hvis du vil ændre reglerne)*

- [ ] ...