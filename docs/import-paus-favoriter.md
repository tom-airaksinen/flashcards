# Spec – CSV-import, pausa lektioner & favoriter

Underlag inför bygge (beslutad design 2026-06-28). Inget är byggt ännu. Sprang ur
behovet att importera en 127-sidig Collins-PDF med ~3000 italienska ord/fraser i
sektioner utan att det blir övermäktigt.

> Relaterad öppen fråga (nu besvarad): "Träna ett urval per lektion (kärnord)" i
> [`oppna-fragor.md`](oppna-fragor.md).

## Grundinsikt

Alla tre funktioner handlar egentligen om **vilka kort som är behöriga att dras
in i ett pass**. Idag drar kö-byggaren från alla lektioner och introducerar ≤10
nya/dag proportionellt. **Paus** och **endast stjärnord** är båda *filter* på den
poolen; **import** är det som fyller poolen. Designa därför ett gemensamt
behörighetssteg som paus + stjärnfilter matar in i → de blir komponerbara.

## Datamodell (allt personligt per profil, precis som SRS)

| Nyckel (localStorage) | Innehåll |
|---|---|
| `flippa-paused-v1` | profil → lista av pausade lektions-id:n |
| `flippa-fav-v1` | profil → set av **ordnycklar** (`normPart(front)\|normPart(back)`) |

- Favoriter nycklas **per ord**, inte per kort-id → en stjärna följer ordet även
  om det finns i flera lektioner (konsekvent med SRS).
- Innehållet i Firebase är oförändrat förutom de nya korten från importen.
  `minnesregel` skrivs till kortets `hint` (delat); `favorit` sätts i den
  importerande profilens lokala fav-lista (personligt, syns inte för andra).

---

## 1) CSV-import → lektioner

- **Ingång:** knapp på ämnesnivå intill "Ny lektion"/"Slå upp ord":
  **⬆️ Importera CSV**. Tillåter flera filer på en gång.
- **Kolumner:** `sektion;italienska;svenska;favorit;minnesregel`
  (de två sista valfria). Se [`csv-import-mall.md`](csv-import-mall.md).
- **Tolkning:** auto-detektera avgränsare (`;` eller `,`), UTF-8, hoppa ev.
  rubrikrad.
- **Gruppering:** en lektion per unik `sektion`. Befintlig lektion med samma namn
  → slås ihop (med dubblettkontroll, `confirmDuplicates`); annars skapas ny.
- **Förhandsgranskning innan skrivning:** t.ex. "12 lektioner, 2 980 ord, 20
  dubbletter hoppas över – importera?".
- **Skrivning batchas** (3000 ord är mycket för Firebase – chunka `addCards`).
- **Vid import:** kort → Firebase; favorit-ord → profilens fav-lista; **nya
  lektioner pausas automatiskt** (se §2) så man slår på sektion för sektion.

## 2) Pausa lektioner

- Pausflagga per lektion och profil (`flippa-paused-v1`).
- **Effekt:** "Dags att öva" hoppar över pausade lektioner (både nya ord och
  repetition). **Men** man kan fortfarande klicka in i en pausad lektion och öva
  den explicit (manuell lektionsträning påverkas inte).
- Pausade lektioner **exkluderas ur den proportionella nyord-fördelningen** så de
  inte äter dagskvoten.
- **UI i lektionslistan:** pausad lektion nedtonad + ⏸-märke, med en på/av-knapp.

## 3) Favoriter + fokuspass

- Stjärnmarkering per ord, per profil (`flippa-fav-v1`).
- **UI:** stjärnknapp på kortet under förhör (intill jordglob/penna), i ordlistan
  och i Redigera-rutan. Stjärnindikator i listorna.
- **Fokus:** toggle **"Endast stjärnord"** vid passinställningen (där antal
  kort/pass finns). Filtrerar passet till stjärnord som är **förfallna** enligt
  SRS.
- **Nya stjärnord flödar INTE in i fokusläget.** De introduceras via den vanliga
  nyord-kvoten precis som allt annat – annars riskerar för många helt nya ord att
  dras in på en gång även om de är viktiga. Toggeln kommer ihåg sitt läge.

---

## Föreslagen byggordning (var och en deploybar för sig)

1. **Favoriter** – stjärna + indikatorer + lokal fav-lista. Liten, direkt nyttig.
2. **Paus** – flagga, hoppa över i "Dags att öva", exkludera ur nyord-kvot,
   lektionslist-UI. Medel.
3. **Fokus-toggle** "Endast stjärnord" vid passinställningen. Liten, bygger på #1.
4. **CSV-import** sist – störst; sätter både paus och favoriter som då redan
   finns. Förhandsgranskning, sektionssplit, batchade skrivningar.

## Att hålla koll på

- **Prestanda/säkerhet vid 3000 ord:** chunkade Firebase-skrivningar; tydlig
  förhandsgranskning så inget oavsiktligt skrivs.
- **Samma ord i flera lektioner:** paus är per lektion men SRS/favorit per ord –
  ett ord som även finns i en aktiv lektion kommer fortfarande därifrån.
- **Profilbyte:** paus/favoriter är knutna till aktiv profil; byter man profil
  byts även dessa.
