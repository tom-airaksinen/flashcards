# 📚 Flippa

Generisk glosapp med spaced repetition. Mobil-först PWA, installerbar på hemskärmen.
Ren HTML/CSS/JS – inga ramverk eller byggsteg. Innehåll i Firebase, statistik lokalt.

**Live:** https://tom-airaksinen.github.io/flashcards/

## Funktioner

- **3 nivåer:** Ämne (t.ex. Italienska) → Lektion (t.ex. Mat & dryck) → Ord
- **Graderad Leitner-SRS:** 👇 hopplöst · 👈 kan inte · 👉 kan · 👆 kan väldigt bra → ord schemaläggs med förfallodatum
- **Backup:** exportera/importera SRS-statistik (localStorage) som JSON inför ominstallation
- **Två träningslägen:** lektionsträning (svagast först) och "Dags att öva" (förfallna idag)
- **Full redigering från mobilen:** skapa/byt namn/ta bort ämnen, lektioner & ord
- **Snabbinmatning:** klistra in flera ord på formatet `utländskt;svenskt`
- **Uttal:** 🔊-knapp läser upp det utländska ordet (Web Speech API, språk per ämne)
- **Översättning:** slå upp ord åt båda håll (MyMemory, gratis) och lägg till i vald/ny lektion
- **Synk & backup:** innehåll i Firebase (delas mellan enheter), SRS-statistik i localStorage per enhet (ingen inloggning)
- **Offline:** service worker cachar appen + senaste innehållet

## Teknisk stack

- Ren HTML/CSS/JS, PWA (manifest + service worker)
- Firebase Realtime Database (compat-SDK) med anonym inloggning
- GitHub Pages för hosting

## Arkitektur

| Lager | Var |
|---|---|
| Innehåll (ämnen/lektioner/ord) | Firebase Realtime Database |
| SRS-statistik (lådor, datum) | localStorage, per enhet |
| Offline-cache | localStorage + service worker |

Se `PLAN.md` för fullständig spec och `docs/oppna-fragor.md` för designbeslut.

## Publicera uppdateringar

```
git add -A && git commit -m "..." && git push
```

GitHub Pages uppdateras automatiskt. Höj `CACHE`-versionen i `sw.js` när app-filer ändras
så att installerade PWA:er hämtar den nya versionen.
