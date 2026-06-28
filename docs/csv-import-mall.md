# CSV-mall & extraktionsprompt för import

Formatet som [`import-paus-favoriter.md`](import-paus-favoriter.md) §1 förväntar
sig, plus en färdig prompt för att få ut det ur Collins-PDF:en.

## Format

- **Avgränsare:** `;` (semikolon). Kommatecken funkar också om filen är
  konsekvent – importen auto-detekterar.
- **Teckenkodning:** UTF-8 (viktigt för åäö och italienska accenter: à è é ì ò ù).
- **Rubrikrad:** valfri. Om första raden är exakt rubrikerna nedan hoppas den över.
- **Kolumner (i ordning):**

| # | Kolumn | Krävs | Innehåll |
|---|---|---|---|
| 1 | `sektion` | ja | Lektionsnamn. En lektion skapas per unik sektion. |
| 2 | `italienska` | ja | Framsidan (utländska ordet/frasen). |
| 3 | `svenska` | ja | Baksidan (översättningen). |
| 4 | `favorit` | nej | `x` eller `1` = stjärnmärks direkt. Tomt = vanlig. |
| 5 | `minnesregel` | nej | Frivillig minnesregel/exempel → kortets hint-fält. |

- **En rad = en glosa.** Tomma rader ignoreras.
- Innehåller ett fält självt `;` eller `,` → omslut fältet med dubbla citattecken,
  t.ex. `"buongiorno, signora"`.

### Exempel

Se [`exempel-import.csv`](exempel-import.csv):

```
sektion;italienska;svenska;favorit;minnesregel
Transport;il treno;tåget;;
Transport;l'autobus;bussen;x;
Transport;la stazione;stationen;;liknar "station"
Mat och dryck;il pane;brödet;x;som i "panera"
Mat och dryck;l'acqua;vattnet;;"aqua, som akvarium"
På apoteket;la medicina;medicinen;;
```

Detta blir tre lektioner (Transport, Mat och dryck, På apoteket), sex ord, två
stjärnmärkta. Alla tre lektioner importeras pausade.

---

## Extraktionsprompt (kör mot PDF:en, t.ex. i Claude)

Klistra in nedan tillsammans med PDF:en:

> Du får en PDF från Collins med italienska ord och fraser indelade i sektioner.
> Extrahera **allt** innehåll till **en enda CSV-fil** med exakt dessa kolumner,
> i denna ordning, separerade med semikolon (`;`):
>
> `sektion;italienska;svenska;favorit;minnesregel`
>
> Regler:
> - **En rad per glosa.** Första raden ska vara rubrikraden ovan.
> - **`sektion`** = bokens avsnittsrubrik som glosan står under (t.ex.
>   "Transport", "Mat och dryck", "På apoteket"). Använd exakt samma sektionsnamn
>   för alla glosor i samma avsnitt så de hamnar i samma lektion.
> - **`italienska`** = det italienska ordet/frasen. **`svenska`** = den svenska
>   översättningen. Om boken är italienska↔engelska: översätt engelskan till
>   **svenska** och lägg den svenska i kolumn 3.
> - **`favorit`** = lämna tomt (jag stjärnmärker själv senare). Lämnas tom kolumn.
> - **`minnesregel`** = lämna oftast tomt. Fyll bara i om PDF:en innehåller ett
>   tydligt användningsexempel eller uttalshjälp som är värt att spara.
> - Bevara alla accenter (à è é ì ò ù) och spara filen som **UTF-8**.
> - Behåll bestämd/obestämd artikel som den står i boken (t.ex. "il treno").
> - Om ett fält innehåller `;` eller `,`, omslut fältet med dubbla citattecken.
> - Ta med **alla** poster – hoppa inte över avsnitt för att spara plats. Om det
>   blir långt, fortsätt tills allt är med.
>
> Returnera enbart CSV-innehållet, inget annat.

### Tips
- Får du för mycket på en gång: be om en sektion i taget och klistra ihop, eller
  importera flera CSV-filer (importen tar flera filer samtidigt och slår ihop
  sektioner med samma namn).
- Kontrollera ett stickprov av accenter innan du importerar – fel kodning syns
  som `Ã ` istället för `à`.
