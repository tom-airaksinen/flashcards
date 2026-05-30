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

## Träningslägen
- [x] Ett läge eller flera? → **Svar:** Två: (A) lektionsträning (cram, svagast först), (B) "Dags att öva" på ämnesnivå (förfallna idag, valbara lektioner). Samma motor. (2026-05-30)
- [x] Vad ska det schemalagda läget heta? → **Svar:** "Dags att öva" (2026-05-30)

## UI/UX
- [x] Tema? → **Svar:** Neutralt/generiskt (inga sportreferenser) (2026-05-30)
- [x] Antal nivåer? → **Svar:** 3 (Ämne → Lektion → Ord) (2026-05-30)
- [ ] Behåller vi "skaka för att ångra" och tryck-för-flippa från fotbollsappen?
- [ ] Ska lådan/styrkan visas i UI:t per ord?

## Innehållshantering
- [x] CRUD från mobilen? → **Svar:** Ja – skapa/redigera/ta bort/döpa om ämnen, lektioner, ord (2026-05-30)
- [x] Snabbinmatning? → **Svar:** Klistra in flera rader `utländskt;svenskt`, en per ord (2026-05-30)
- [ ] Ska man kunna flytta ord mellan lektioner, eller räcker lägg till/ta bort?
- [ ] Import: slå ihop (merge) eller ersätta befintligt innehåll?
- [ ] Behövs export/import-JSON till git som backup, eller litar vi på Firebase?

## Projekt & drift
- [x] Repo-namn på privata GitHub-kontot? → **Svar:** "flashcards" (lokal mapp heter "glosappen" – får skilja sig) (2026-05-30)
- [x] Publikt eller privat repo? → **Svar:** Publikt (gratis Pages, inget känsligt i koden; privat kräver GitHub Pro) (2026-05-30)
- [x] Deploy? → **Svar:** GitHub Pages, live på https://tom-airaksinen.github.io/flashcards/ (2026-05-30)
- [x] Egen ikon till hemskärmen? → **Svar:** Ja, neutral kort-stack-ikon (icon.svg → 192/512 px) (2026-05-30)
- [ ] Om anonym inloggning skulle fela på github.io: lägg ev. till domänen under Firebase Auth → Settings → Authorized domains.
