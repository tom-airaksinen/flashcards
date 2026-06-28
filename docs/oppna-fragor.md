# Öppna frågor – Glosappen

## Arkitektur & data
- [x] Var lagras innehållet (ämnen/lektioner/ord)? → **Svar:** Firebase Realtime Database (synk, backup, mobil-CRUD, delas med barnen) (2026-05-30)
- [x] Var lagras SRS-statistik? → **Svar:** localStorage per enhet → ingen inloggning behövs (2026-05-30)
- [x] Räcker Firebase gratisnivå vid intensiv träning? → **Svar:** Ja, med stor marginal – glosor är ren text, långt under kvoten (2026-05-30)
- [x] Ny Firebase-databas/nytt projekt, eller återanvänd kassa-appens? → **Svar:** Nytt separat projekt – ren separation, egna regler; enda nackdel ~5 min engångssetup (2026-05-30)
- [x] Vilka säkerhetsregler ska Firebase ha? → **Svar:** Anonym inloggning + regel "kräver inloggad" (tyst, ingen login-ruta; blockar slumpmässiga skrivningar) (2026-05-30)

## SRS-modell
- [x] Leitner eller SM-2? → **Svar:** Graderad Leitner med datum (passar swipe; SM-2 kräver glidande ease factor) (2026-05-30)
- [x] Hur många utfall/gester? → **Svar:** Tre – 👈 kan inte (→låda 1), 👉 kan (+1 låda), 👆 kan väldigt bra (+2 lådor) (2026-05-30)
- [ ] Exakta intervall per låda – startförslag i PLAN.md (idag/2/4/8/16/32 dgr), justeras efter känsla?
- [ ] Behövs en "hoppa över idag/snooza" trots att uppåtgesten nu är "kan väldigt bra"?
- [ ] Svårighets-/historik-minne per ord (leech)? → **Tanke:** ren Leitner är "minneslös" och minns inte att vissa ord alltid är svåra. Förfining (inte krock): räkna bommar/andel rätt per ord och låt det (a) visa en 🔥-indikator på sega ord och/eller (b) vara tiebreaker i "svagast först". Full SM-2 ease factor avråddes (binär-ish input + transparensförlust); 👇 hopplöst + Leitners självkorrigering räcker troligen. (Diskuterad 2026-06-02)

## Träningslägen
- [x] Ett läge eller flera? → **Svar:** Två: (A) lektionsträning (cram, svagast först), (B) "Dags att öva" på ämnesnivå (förfallna idag, valbara lektioner). Samma motor. (2026-05-30)
- [x] Vad ska det schemalagda läget heta? → **Svar:** "Dags att öva" (2026-05-30)
- [x] "Träna ett urval per lektion" (kärnord)? → **Svar:** Stjärnmärkning per ord (personligt per profil) + toggle "Endast stjärnord" vid passinställningen (förfallna enligt SRS; nya stjärnord introduceras via vanliga nyord-kvoten). Full design i [`import-paus-favoriter.md`](import-paus-favoriter.md). (2026-06-28)

## UI/UX
- [x] Tema? → **Svar:** Neutralt/generiskt (inga sportreferenser) (2026-05-30)
- [x] Antal nivåer? → **Svar:** 3 (Ämne → Lektion → Ord) (2026-05-30)
- [ ] Behåller vi "skaka för att ångra" och tryck-för-flippa från fotbollsappen?
- [ ] Ska lådan/styrkan visas i UI:t per ord?
- [ ] Justera antal kort mitt i ett pass? → **Idé + prototyp:** kunna ändra hur många kort som är kvar medan man kör. Tre varianter i mockup: A) tappbar "kvar"-pill → popover med stegare + snabbval (+5/+10, Alla kvar, Avsluta nu) **(rekommenderad)**, B) egen ⚙-knapp med förval, C) inline-stegare `− 8 +`. "Fler" drar in nästa kort ur dagens pool; är poolen slut → erbjud "Kör ändå". Prototyp: `mockups/kort-per-pass.html` (live: https://tom-airaksinen.github.io/flashcards/mockups/kort-per-pass.html). (Diskuterad 2026-06-02)

## Innehållshantering
- [x] CRUD från mobilen? → **Svar:** Ja – skapa/redigera/ta bort/döpa om ämnen, lektioner, ord (2026-05-30)
- [x] Snabbinmatning? → **Svar:** Klistra in flera rader `utländskt;svenskt`, en per ord (2026-05-30)
- [ ] Ska man kunna flytta ord mellan lektioner, eller räcker lägg till/ta bort?
- [ ] Import: slå ihop (merge) eller ersätta befintligt innehåll?
- [x] Behövs export/import-JSON? → **Svar:** Ja, för SRS-statistiken (localStorage) inför ominstallation – content ligger i Firebase och är redan säkert. Byggt 2026-05-30 (export/import via menyn ⋯).

## Projekt & drift
- [x] Repo-namn på privata GitHub-kontot? → **Svar:** "flashcards" (lokal mapp heter "glosappen" – får skilja sig) (2026-05-30)
- [x] Publikt eller privat repo? → **Svar:** Publikt (gratis Pages, inget känsligt i koden; privat kräver GitHub Pro) (2026-05-30)
- [x] Deploy? → **Svar:** GitHub Pages, live på https://tom-airaksinen.github.io/flashcards/ (2026-05-30)
- [x] Egen ikon till hemskärmen? → **Svar:** Ja, neutral kort-stack-ikon (icon.svg → 192/512 px) (2026-05-30)
- [ ] Om anonym inloggning skulle fela på github.io: lägg ev. till domänen under Firebase Auth → Settings → Authorized domains.
