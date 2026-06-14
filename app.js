"use strict";

/* =========================================================================
   Flashcards – generisk glosapp
   Innehåll i Firebase (delas, synkas), SRS i localStorage (per enhet).
   ========================================================================= */

// ---- Firebase init ----
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const statusBanner = $("status-banner");
const screens = {
  subjects: $("subjects-screen"),
  lessons: $("lessons-screen"),
  editor: $("editor-screen"),
  training: $("training-screen"),
  congrats: $("congrats-screen"),
};

// ---- App-state ----
// OBS: CACHE_KEY måste vara initierad INNAN loadCachedContent() anropas här, annars
// kastar den (const i TDZ) ett ReferenceError som try/catch sväljer → cachen blir
// alltid tom och "visa cachat innehåll offline" fungerar inte.
const CACHE_KEY = "flashcards-content-cache-v1";
let content = loadCachedContent(); // [{id,name,order,owner,lessons:[{id,name,order,cards:[{id,front,back,order}]}]}]
let currentSubject = null;         // valt ämnesobjekt
let currentLessonId = null;        // lektion öppen i editorn

// ---- Användare (lokal profilväljare – INTE inloggning/säkerhet) ----
// Varje område har en ägare (owner). Vald profil filtrerar vilka områden som visas.
// Lektioner ärver områdets ägare automatiskt. Lätt att utöka med fler profiler.
const USERS = [
  { id: "tom", name: "Tom" },
  { id: "hedvig", name: "Hedvig" },
  { id: "guest", name: "Gäst" },
];
const USER_KEY = "flippa-user";
let currentUser = localStorage.getItem(USER_KEY) || null; // null = ingen vald (ny enhet)
function userName(id) { return (USERS.find((u) => u.id === id) || {}).name || ""; }
function setUser(id) {
  currentUser = id;
  if (id) localStorage.setItem(USER_KEY, id); else localStorage.removeItem(USER_KEY);
  renderSubjects();
}
// Engångsfix: ge äldre områden (utan owner) en ägare efter namn. Skrivs till Firebase
// via den inloggade klienten, så alla enheter ser samma ägarskap sen.
const OWNER_MIGRATED_KEY = "flippa-owners-assigned-v1";
function migrateOwners() {
  if (localStorage.getItem(OWNER_MIGRATED_KEY)) return;
  content.forEach((s) => {
    if (s.owner) return;
    const n = (s.name || "").trim().toLowerCase();
    const owner = n === "spanska" ? "hedvig"
      : (n === "bahasa indonesia" || n === "ukrainska") ? "guest"
      : "tom";
    s.owner = owner; // sätt lokalt direkt så filtret funkar innan Firebase ekar tillbaka
    db.ref(`content/subjects/${s.id}/owner`).set(owner).catch(writeError);
  });
  localStorage.setItem(OWNER_MIGRATED_KEY, "1");
}
let seeding = false;

// ---- Språk (för uttal) ----
const LANG_OPTIONS = [
  { label: "Inget / ej språk", code: "" },
  { label: "Italienska", code: "it-IT" },
  { label: "Tyska", code: "de-DE" },
  { label: "Franska", code: "fr-FR" },
  { label: "Spanska", code: "es-ES" },
  { label: "Engelska", code: "en-GB" },
  { label: "Portugisiska", code: "pt-PT" },
  { label: "Ukrainska", code: "uk-UA" },
  { label: "Indonesiska", code: "id-ID" },
];
const LANG_GUESS = {
  italienska: "it-IT", tyska: "de-DE", franska: "fr-FR",
  spanska: "es-ES", engelska: "en-GB", portugisiska: "pt-PT", ukrainska: "uk-UA",
  indonesiska: "id-ID", "bahasa indonesia": "id-ID",
};
// Returnerar ämnets språkkod (explicit fält, annars gissning från namnet)
function subjectLang(s) {
  if (!s) return "";
  return s.lang || LANG_GUESS[(s.name || "").trim().toLowerCase()] || "";
}
// Flagga-emoji per språk (tomt om inget språk)
const LANG_FLAG = {
  "it-IT": "🇮🇹", "de-DE": "🇩🇪", "fr-FR": "🇫🇷", "es-ES": "🇪🇸",
  "en-GB": "🇬🇧", "pt-PT": "🇵🇹", "uk-UA": "🇺🇦", "id-ID": "🇮🇩",
};
function subjectFlag(s) {
  return LANG_FLAG[subjectLang(s)] || "";
}

// =========================================================================
//  SRS-lager (localStorage) – graderad Leitner
// =========================================================================
const SRS_KEY = "flashcards-srs-v1";
let srs = JSON.parse(localStorage.getItem(SRS_KEY) || "{}");

// Lådintervall i dagar (låda 1..6). Box 0 = ny (förfaller direkt).
const BOX_INTERVALS = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16, 6: 32 };
const MAX_BOX = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

function saveSRS() {
  localStorage.setItem(SRS_KEY, JSON.stringify(srs));
}

// SRS nycklas på ORDET (utländskt + svenska), inte på kort-ID:t. Då delar samma ord
// sin inlärning mellan lektioner. Olika översättning = olika nyckel, så homonymer
// (t.ex. "tra/fra" = om / mellan) hålls isär eftersom baksidan skiljer sig.
function normPart(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function srsKey(card, dir) {
  return `${normPart(card.front)}|${normPart(card.back)}|${dir}`;
}

function getEntry(card, dir) {
  const k = srsKey(card, dir);
  if (!srs[k]) srs[k] = { box: 0, due: 0, lastSeen: 0 };
  return srs[k];
}

// "Dags att öva" = introducerade ord (låda ≥ 1) vars datum passerat.
// Nya, aldrig tränade ord (låda 0) räknas inte – dem lär man in i lektionen.
function isDue(card, dir, now) {
  const e = getEntry(card, dir);
  return e.box >= 1 && e.due <= now;
}

// Förfallen att öva NU givet vald riktning. Räkning av "dags att öva" och själva
// passet måste använda SAMMA riktningslogik – annars kan taggen visa t.ex. 10
// (förfallna i b2f) medan ett f2b-pass inte hittar något ("ur synk").
function isDueNow(card, dirMode, now) {
  if (dirMode === "mixed") return isDue(card, "f2b", now) || isDue(card, "b2f", now);
  return isDue(card, dirMode, now);
}

// grade: "fail" | "good" | "easy" | "hard"
function gradeCard(card, dir, grade) {
  const e = getEntry(card, dir);
  const now = Date.now();
  if (grade === "fail" || grade === "hard") {
    e.box = 1;
    e.due = now; // dyker upp igen idag
  } else {
    // kan = +1 låda, kan väldigt bra = +2. Nytt ord + "kan" → låda 1 = tidigast imorgon.
    const step = grade === "easy" ? 2 : 1;
    e.box = Math.min(MAX_BOX, (e.box || 0) + step);
    e.due = now + BOX_INTERVALS[e.box] * DAY_MS;
  }
  e.lastSeen = now;
  saveSRS();
}

// Ett kort är "nytt" (aldrig tränat) när BÅDA riktningarna ligger i låda 0.
function isNewCard(c) {
  return getEntry(c, "f2b").box === 0 && getEntry(c, "b2f").box === 0;
}

// =========================================================================
//  Daglig introduktion av nya ord (max 10/dag per ämne, proportionellt)
// =========================================================================
// "Dags att öva" tar in nya ord (låda 0) men släpper in högst 10 nya per dag
// och ämne, slumpat proportionellt över lektionerna. Uppsättningen väljs en
// gång per dag och persisteras (hård gräns – ingen påfyllning samma dag).
const NEW_INTRO_KEY = "flippa-newintro-v1";
const NEW_PER_DAY = 10;

function todayStr() {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD i lokal tid
}

// Hamilton/största-rest: fördela `total` platser proportionellt mot bucket-storlekar.
function allocProportional(counts, total) {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum <= total) return counts.slice(); // alla ryms
  const ideal = counts.map((n) => (total * n) / sum);
  const base = ideal.map(Math.floor);
  let rest = total - base.reduce((a, b) => a + b, 0);
  // dela ut återstoden till största bråkdelarna
  const order = ideal
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) base[order[k].i]++;
  return base;
}

// Returnerar dagens valda nya kort (objekt) för ett ämne som FORTFARANDE är låda 0.
// Väljer (och persisterar) uppsättningen första gången den efterfrågas en ny dag.
function todaysNewCards(subject) {
  if (!subject) return [];
  let ledger;
  try { ledger = JSON.parse(localStorage.getItem(NEW_INTRO_KEY) || "{}"); } catch { ledger = {}; }
  const today = todayStr();
  let entry = ledger[subject.id];
  if (!entry || entry.date !== today) {
    // Bygg buckets per lektion av nya kort och fördela proportionellt.
    const buckets = subject.lessons.map((l) => l.cards.filter(isNewCard));
    const counts = buckets.map((b) => b.length);
    const totalNew = counts.reduce((a, b) => a + b, 0);
    const alloc = allocProportional(counts, Math.min(NEW_PER_DAY, totalNew));
    const ids = [];
    buckets.forEach((cards, i) => {
      const shuffled = cards
        .map((c) => ({ c, r: Math.random() }))
        .sort((a, b) => a.r - b.r)
        .map((x) => x.c);
      shuffled.slice(0, alloc[i]).forEach((c) => ids.push(c.id));
    });
    entry = { date: today, ids };
    ledger[subject.id] = entry;
    localStorage.setItem(NEW_INTRO_KEY, JSON.stringify(ledger));
  }
  const idSet = new Set(entry.ids);
  const out = [];
  subject.lessons.forEach((l) =>
    l.cards.forEach((c) => {
      if (idSet.has(c.id) && isNewCard(c)) out.push(c); // ej graderat ännu
    })
  );
  return out;
}

// Migrera gammal statistik (nycklad på kort-ID "cardId:dir") till ordnyckeln.
// Idempotent: kör säkert flera ggr; behåller starkaste posten vid krock.
const SRS_MIGRATED_KEY = "flippa-srs-keyed-by-word";
function migrateSrsKeys(contentArr) {
  let changed = false;
  contentArr.forEach((s) =>
    s.lessons.forEach((l) =>
      l.cards.forEach((c) => {
        ["f2b", "b2f"].forEach((dir) => {
          const old = srs[`${c.id}:${dir}`];
          if (!old || !(old.box > 0 || old.due > 0)) return;
          const k = srsKey(c, dir);
          const cur = srs[k];
          if (!cur || (old.box || 0) > (cur.box || 0)) {
            srs[k] = { box: old.box || 0, due: old.due || 0, lastSeen: old.lastSeen || 0 };
            changed = true;
          }
        });
      })
    )
  );
  if (changed) saveSRS();
}

// =========================================================================
//  Datalager – Firebase + localStorage-cache
// =========================================================================
// (CACHE_KEY deklareras högre upp, före loadCachedContent()-anropet vid boot)

function loadCachedContent() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) || [];
  } catch {
    return [];
  }
}

function cacheContent(c) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(c));
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

function normalize(subjectsObj) {
  return Object.entries(subjectsObj || {})
    .map(([id, s]) => ({
      id,
      name: s.name,
      order: s.order ?? 0,
      lang: s.lang || null,
      owner: s.owner || null,
      lessons: Object.entries(s.lessons || {})
        .map(([lid, l]) => ({
          id: lid,
          name: l.name,
          order: l.order ?? 0,
          cards: Object.entries(l.cards || {})
            .map(([cid, c]) => ({ id: cid, front: c.front, back: c.back, hint: c.hint ?? null, order: c.order ?? 0 }))
            .sort(byOrder),
        }))
        .sort(byOrder),
    }))
    .sort(byOrder);
}

function showStatus(msg) {
  if (!msg) {
    statusBanner.classList.add("hidden");
    return;
  }
  statusBanner.textContent = msg;
  statusBanner.classList.remove("hidden");
}

function boot() {
  // Visa cachat innehåll direkt (funkar offline)
  if (content.length) renderSubjects();
  else showStatus("Ansluter …");

  auth.signInAnonymously().catch((err) => {
    console.error(err);
    if (content.length) {
      showStatus("Offline – visar sparat innehåll");
    } else {
      showStatus("Kunde inte ansluta: " + (err.code || err.message));
    }
  });

  auth.onAuthStateChanged((user) => {
    if (!user) return;
    listenContent();
  });
}

function listenContent() {
  db.ref("content/subjects").on(
    "value",
    (snap) => {
      const val = snap.val();
      if (!val) {
        seedIfEmpty();
        return;
      }
      content = normalize(val);
      if (!localStorage.getItem(SRS_MIGRATED_KEY)) {
        migrateSrsKeys(content);
        localStorage.setItem(SRS_MIGRATED_KEY, "1");
      }
      migrateOwners(); // sätt ägare på äldre områden en gång (skrivs till Firebase)
      cacheContent(content);
      showStatus(null);
      renderCurrentScreen();
    },
    (err) => {
      console.error(err);
      showStatus("Läsfel: " + (err.code || err.message));
    }
  );
}

function seedIfEmpty() {
  if (seeding) return;
  seeding = true;
  showStatus("Lägger in startinnehåll …");
  const ts = firebase.database.ServerValue.TIMESTAMP;
  const subjRef = db.ref("content/subjects").push();
  const lessRef = subjRef.child("lessons").push();
  const cardsObj = {};
  SEED.cards.forEach((c, i) => {
    cardsObj[`c${i}`] = { front: c.front, back: c.back, order: i, createdAt: ts };
  });
  subjRef
    .set({
      name: SEED.subject,
      order: 0,
      createdAt: ts,
      lessons: {
        [lessRef.key]: { name: SEED.lesson, order: 0, createdAt: ts, cards: cardsObj },
      },
    })
    .catch((err) => {
      console.error(err);
      showStatus("Kunde inte seeda: " + (err.code || err.message));
      seeding = false;
    });
}

// =========================================================================
//  Navigation / rendering
// =========================================================================
// Skärm-djup styr glidriktningen: djupare = push (in från höger), grundare = pop.
const SCREEN_DEPTH = { subjects: 0, lessons: 1, editor: 2, training: 2, congrats: 3 };
const NAV_DUR = 220;
const NAV_EASE = "cubic-bezier(.4,0,.2,1)";
const prefersReducedMotion = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
let shownScreen = "subjects";
let navCleanup = null; // avslutar pågående övergång

function setOnlyScreen(screenName) {
  Object.entries(screens).forEach(([name, el]) => el.classList.toggle("hidden", name !== screenName));
}

function show(screenName) {
  const from = shownScreen;
  // Lämnar man Klar-skärmen (Grymt!/Fortsätt) avbryts röstlyssning och ångra-möjligheten.
  if (from === "congrats" && screenName !== "congrats") { stopCongratsListen(); lastSession = null; }
  if (navCleanup) navCleanup(); // snabbspola ev. pågående glid innan nästa
  const fromEl = screens[from];
  // Ingen animation: samma skärm, okänd ursprungsskärm, reducerad rörelse, eller
  // att ursprunget inte var synligt (t.ex. allra första renderingen).
  if (screenName === from || !fromEl || prefersReducedMotion || fromEl.classList.contains("hidden")) {
    setOnlyScreen(screenName);
    shownScreen = screenName;
    return;
  }
  const dir = (SCREEN_DEPTH[screenName] ?? 0) >= (SCREEN_DEPTH[from] ?? 0) ? 1 : -1;
  const inEl = screens[screenName], outEl = fromEl;
  inEl.classList.remove("hidden");
  inEl.classList.add("nav-anim");
  outEl.classList.add("nav-anim");
  inEl.style.zIndex = "2"; outEl.style.zIndex = "1"; // inkommande ovanpå
  inEl.style.transition = "none";
  outEl.style.transition = "none";
  inEl.style.transform = `translateX(${dir > 0 ? 100 : -100}%)`;
  inEl.style.opacity = "1";
  outEl.style.transform = "none";
  outEl.style.opacity = "1";
  void inEl.offsetWidth; // tvinga startläge
  inEl.style.transition = `transform ${NAV_DUR}ms ${NAV_EASE}`;
  // Gamla skärmen glider undan OCH fejdar ut, så inget gammalt skräp ligger kvar och stör.
  outEl.style.transition = `transform ${NAV_DUR}ms ${NAV_EASE}, opacity ${NAV_DUR}ms ease-out`;
  inEl.style.transform = "none";
  outEl.style.transform = `translateX(${dir > 0 ? -22 : 22}%)`;
  outEl.style.opacity = "0";
  shownScreen = screenName;

  const cleanup = () => {
    navCleanup = null;
    [inEl, outEl].forEach((el) => {
      el.classList.remove("nav-anim");
      el.style.transition = ""; el.style.transform = ""; el.style.zIndex = ""; el.style.opacity = "";
    });
    setOnlyScreen(screenName);
  };
  navCleanup = cleanup;
  setTimeout(() => { if (navCleanup === cleanup) cleanup(); }, NAV_DUR + 40);
}

let activeScreen = "subjects";

function renderCurrentScreen() {
  if (activeScreen === "subjects") renderSubjects();
  else if (activeScreen === "lessons") renderLessons();
  else if (activeScreen === "editor") renderEditor();
}

function renderSubjects() {
  activeScreen = "subjects";
  show("subjects");
  // Profilväljaren högst upp speglar vald användare
  const pill = $("user-pill");
  pill.textContent = currentUser ? `👤 ${userName(currentUser)} ▾` : "👤 Vem är du? ▾";
  const list = $("subjects-list");

  // Ingen profil vald (t.ex. ny enhet) → tomt läge
  if (!currentUser) {
    list.innerHTML = `<p class="empty">Vem är du? Välj här 👆</p>`;
    return;
  }
  // Bara den valda användarens områden
  const mine = content.filter((s) => s.owner === currentUser);
  if (!mine.length) {
    list.innerHTML = `<p class="empty">Inga områden för ${esc(userName(currentUser))} än. Tryck ＋ för att skapa ett.</p>`;
    return;
  }
  list.innerHTML = mine
    .map((s) => {
      const cardCount = s.lessons.reduce((n, l) => n + l.cards.length, 0);
      const flag = subjectFlag(s);
      return `<div class="row" data-subject="${s.id}">
        <span class="row-title">${flag ? flag + " " : ""}${esc(s.name)}</span>
        <span class="row-meta">${s.lessons.length} lekt · ${cardCount} ord</span>
      </div>`;
    })
    .join("");
  // Ingen penna här – namn/språk/ägare redigeras inne i området (✎ uppe på lektionsskärmen).
  list.querySelectorAll(".row").forEach((row) => {
    row.addEventListener("click", () => openSubject(row.dataset.subject));
  });
}

// Profilväljaren: tryck → välj användare (enkel lista, lätt att utöka)
async function pickUser() {
  const choice = await actionSheet("Vem är du?", USERS.map((u) => ({ label: u.name, value: u.id })));
  if (choice) setUser(choice);
}

function openSubject(id) {
  currentSubject = content.find((s) => s.id === id);
  $("lessons-search").value = "";
  renderLessons();
}

function dueCountForLessons(lessons) {
  const now = Date.now();
  const dirMode = dirSelect.value; // räkna i vald riktning (matchar vad passet ger)
  // Dagens nya ord (låda 0) räknas också – men de väljs per ämne, så vi
  // begränsar setet till de lektioner vi räknar på.
  const newSet = new Set(todaysNewCards(currentSubject).map((c) => c.id));
  let n = 0;
  lessons.forEach((l) =>
    l.cards.forEach((c) => {
      if (isDueNow(c, dirMode, now) || newSet.has(c.id)) n++;
    })
  );
  return n;
}

function renderLessons() {
  if (!currentSubject) return renderSubjects();
  stopHandsfree();
  closeChoosers();
  syncOptionPills();
  if (lessonDrag && lessonDrag.active) return; // rita inte om mitt i en drag-omordning
  // Plocka färsk referens (innehåll kan ha uppdaterats från Firebase)
  currentSubject = content.find((s) => s.id === currentSubject.id) || currentSubject;
  activeScreen = "lessons";
  show("lessons");
  $("lessons-title").textContent = (subjectFlag(currentSubject) ? subjectFlag(currentSubject) + " " : "") + currentSubject.name;

  const dueBtn = $("due-btn");
  const due = dueCountForLessons(currentSubject.lessons);
  if (due > 0) {
    dueBtn.textContent = `⏰ Dags att öva (${due})`;
    dueBtn.classList.remove("hidden");
    dueBtn.onclick = startDueSession;
  } else {
    dueBtn.classList.add("hidden");
  }

  const list = $("lessons-list");
  const filter = ($("lessons-search").value || "").trim().toLowerCase();
  if (!currentSubject.lessons.length) {
    list.innerHTML = `<p class="empty">Inga lektioner än. Tryck ＋ för att skapa en.</p>`;
    return;
  }
  const lessonsToShow = filter
    ? currentSubject.lessons.filter((l) =>
        l.cards.some((c) =>
          c.front.toLowerCase().includes(filter) || c.back.toLowerCase().includes(filter)
        )
      )
    : currentSubject.lessons;
  if (!lessonsToShow.length) {
    const raw = ($("lessons-search").value || "").trim();
    const canLookUp = !!subjectLang(currentSubject); // uppslag kräver att ämnet har ett språk
    list.innerHTML = `<p class="empty">Inga lektioner matchar "${esc(filter)}".</p>`
      + (canLookUp ? `<p class="empty"><button type="button" class="link-action" id="lookup-add">🔎 Slå upp &amp; lägg till</button></p>` : "");
    if (canLookUp) $("lookup-add").onclick = () => openTranslate(null, raw);
    return;
  }
  list.innerHTML = lessonsToShow
    .map((l) => {
      const d = dueCountForLessons([l]);
      const dueTag = d > 0 ? `<span class="due-tag">${d} dags</span>` : "";
      return `<div class="row" data-lesson="${l.id}">
        <span class="row-title">${esc(l.name)}</span>
        <span class="row-meta">${dueTag}${l.cards.length} ord</span>
        <button class="row-edit" data-edit="${l.id}" title="Öppna lektionen för att ändra">›</button>
      </div>`;
    })
    .join("");
  list.querySelectorAll(".row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("row-edit")) return;
      if (suppressLessonClick) return; // precis avslutat en drag-omordning
      startLessonSession(row.dataset.lesson);
    });
    row.addEventListener("pointerdown", (e) => onLessonPointerDown(e, row, list));
  });
  list.querySelectorAll(".row-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor(btn.dataset.edit);
    });
  });
}

// ---- Drag & drop-ordning av lektioner (långtryck) ----
let lessonDrag = null;
let suppressLessonClick = false;

function onLessonPointerDown(e, row, listEl) {
  if (e.target.closest(".row-edit")) return;
  if (e.button != null && e.button > 0) return;
  const state = { row, listEl, pointerId: e.pointerId, startY: e.clientY, active: false };
  lessonDrag = state;
  state.moveHandler = (ev) => onLessonPointerMove(ev, state);
  state.upHandler = (ev) => onLessonPointerUp(ev, state);
  window.addEventListener("pointermove", state.moveHandler, { passive: false });
  window.addEventListener("pointerup", state.upHandler);
  window.addEventListener("pointercancel", state.upHandler);
  state.holdTimer = setTimeout(() => beginLessonDrag(state), 420);
}

function cleanupLessonDrag(state) {
  clearTimeout(state.holdTimer);
  window.removeEventListener("pointermove", state.moveHandler);
  window.removeEventListener("pointerup", state.upHandler);
  window.removeEventListener("pointercancel", state.upHandler);
  if (state.touchBlocker) document.removeEventListener("touchmove", state.touchBlocker);
  if (lessonDrag === state) lessonDrag = null;
}

function beginLessonDrag(state) {
  const rows = [...state.listEl.querySelectorAll(".row")];
  state.rows = rows;
  state.rects = rows.map((r) => r.getBoundingClientRect());
  state.index = rows.indexOf(state.row);
  if (state.index < 0) { cleanupLessonDrag(state); return; }
  state.gap = state.rects[0].height + 10;
  state.targetIndex = state.index;
  state.active = true;
  state.row.classList.add("dragging");
  try { state.row.setPointerCapture(state.pointerId); } catch (e) {}
  state.touchBlocker = (te) => te.preventDefault(); // stoppa sidans scroll under drag (iOS)
  document.addEventListener("touchmove", state.touchBlocker, { passive: false });
  if (navigator.vibrate) navigator.vibrate(12);
}

function onLessonPointerMove(ev, state) {
  if (!state.active) {
    if (Math.abs(ev.clientY - state.startY) > 8) cleanupLessonDrag(state); // rörde sig = scroll, avbryt
    return;
  }
  ev.preventDefault();
  const dy = ev.clientY - state.startY;
  state.row.style.transform = `translateY(${dy}px) scale(1.03)`;
  const draggedCenter = state.rects[state.index].top + state.rects[state.index].height / 2 + dy;
  let newIndex = 0;
  state.rects.forEach((r, i) => {
    if (i === state.index) return;
    if (r.top + r.height / 2 < draggedCenter) newIndex++;
  });
  state.targetIndex = newIndex;
  state.rows.forEach((r, i) => {
    if (i === state.index) return;
    let shift = 0;
    if (state.index < state.targetIndex && i > state.index && i <= state.targetIndex) shift = -state.gap;
    else if (state.index > state.targetIndex && i >= state.targetIndex && i < state.index) shift = state.gap;
    r.style.transform = shift ? `translateY(${shift}px)` : "";
  });
}

function onLessonPointerUp(ev, state) {
  if (!state.active) { cleanupLessonDrag(state); return; }
  const fromIndex = state.index;
  const toIndex = state.targetIndex;
  state.rows.forEach((r) => (r.style.transform = ""));
  state.row.classList.remove("dragging");
  state.active = false;
  cleanupLessonDrag(state);
  suppressLessonClick = true;
  setTimeout(() => (suppressLessonClick = false), 350);
  if (fromIndex !== toIndex) {
    const ids = currentSubject.lessons.map((l) => l.id);
    const [moved] = ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, moved);
    persistLessonOrder(ids);
  }
}

function persistLessonOrder(orderedIds) {
  const subj = content.find((s) => s.id === currentSubject.id) || currentSubject;
  orderedIds.forEach((id, i) => {
    const les = subj.lessons.find((l) => l.id === id);
    if (les) les.order = i;
  });
  subj.lessons.sort(byOrder);
  currentSubject = subj;
  renderLessons(); // optimistisk omritning
  const updates = {};
  orderedIds.forEach((id, i) => (updates[`${id}/order`] = i));
  db.ref(`content/subjects/${subj.id}/lessons`).update(updates).catch(writeError);
}

// Back-knappar
document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.back;
    if (target === "subjects") renderSubjects();
    else if (target === "lessons") renderLessons();
  });
});

$("congrats-done").addEventListener("click", () => renderLessons());

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// =========================================================================
//  Träning – sessionskö
// =========================================================================
const card = $("card");
const cardInner = card.querySelector(".card-inner");
const cardFront = $("card-front");
const cardFrontText = $("card-front-text");
const cardFrontHint = $("card-front-hint");
const cardAnswer = $("card-answer");
const cardHint = $("card-hint");
const hintBtn = $("hint-btn");
const dirSelect = $("dir-select");
const progressPill = $("progress-pill");
const feedbackEl = $("swipe-feedback");

let session = null; // { queue:[card], dirMode, current, shownDir }
let undoStack = [];  // shake-to-undo: snapshots av state före varje svar i sessionen
// Kort som redan visats i den pågående "Fortsätt"-kedjan (rundan). Nollställs vid ny
// runda (när man startar från knappen, inte via Fortsätt) så att fel-svarade ord inte
// kommer tillbaka förrän man tryckt Klar och börjar om.
let runSeen = new Set();

// ---- Antal kort per pass ----
const SESSION_LIMIT_KEY = "flashcards-session-limit";
const sessionLimitSel = $("session-limit");
sessionLimitSel.value = localStorage.getItem(SESSION_LIMIT_KEY) || "10"; // default på ny enhet: 10 kort/pass
sessionLimitSel.addEventListener("change", () => {
  localStorage.setItem(SESSION_LIMIT_KEY, sessionLimitSel.value);
});
function sessionLimit() {
  return parseInt(sessionLimitSel.value, 10) || 0; // 0 = alla
}

// ---- Riktning (kommer ihåg senaste valet) ----
const DIR_KEY = "flashcards-dir";
dirSelect.value = localStorage.getItem(DIR_KEY) || "b2f";
dirSelect.addEventListener("change", () => localStorage.setItem(DIR_KEY, dirSelect.value));

// ---- Alternativ-pills: riktning + kort per pass (lektionsskärmen) ----
const dirPill = $("dir-pill"), limitPill = $("limit-pill");
const dirChooser = $("dir-chooser"), limitChooser = $("limit-chooser");
function limitLabel(v) { return v === "0" ? "Alla" : v; }
function closeChoosers() { dirChooser.classList.add("hidden"); limitChooser.classList.add("hidden"); }
function syncOptionPills() {
  const dirOpt = dirSelect.options[dirSelect.selectedIndex];
  $("dir-val").textContent = dirOpt ? dirOpt.text : "Från svenska";
  $("limit-val").textContent = limitLabel(sessionLimitSel.value);
  dirChooser.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === dirSelect.value));
  limitChooser.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === sessionLimitSel.value));
}
dirPill.onclick = () => { limitChooser.classList.add("hidden"); dirChooser.classList.toggle("hidden"); };
limitPill.onclick = () => { dirChooser.classList.add("hidden"); limitChooser.classList.toggle("hidden"); };
$("dir-segs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  dirSelect.value = b.dataset.v;
  localStorage.setItem(DIR_KEY, dirSelect.value);
  syncOptionPills(); closeChoosers();
});
$("limit-segs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  sessionLimitSel.value = b.dataset.v;
  sessionLimitSel.dispatchEvent(new Event("change")); // sparar SESSION_LIMIT_KEY
  syncOptionPills(); closeChoosers();
});
syncOptionPills();

function pickDir(dirMode) {
  if (dirMode === "f2b") return "f2b";
  if (dirMode === "b2f") return "b2f";
  return Math.random() < 0.5 ? "f2b" : "b2f";
}

async function startLessonSession(lessonId, force = false, continuing = false) {
  const lesson = currentSubject.lessons.find((l) => l.id === lessonId);
  if (!lesson) return;
  if (!lesson.cards.length) {
    toast("Inga ord att öva på än. Gå in i lektionen med pilknappen för att börja lägga till innehåll", 4000);
    return;
  }
  if (!continuing) runSeen = new Set(); // ny runda
  const dirMode = dirSelect.value;
  // Bara ord som är aktiva idag: nya + de man svarat fel/hopplöst på (due <= nu).
  // Kan/kan-bra-ord har skjutits framåt och dyker inte upp igen samma dag.
  const now = Date.now();
  const activeToday = (c) =>
    dirMode === "f2b" ? getEntry(c, "f2b").due <= now
    : dirMode === "b2f" ? getEntry(c, "b2f").due <= now
    : (getEntry(c, "f2b").due <= now || getEntry(c, "b2f").due <= now);
  const pool = (force ? [...lesson.cards] : lesson.cards.filter(activeToday)).filter((c) => !runSeen.has(c.id));
  if (!pool.length) {
    const yes = await confirmPrimary(
      "Inget kvar att öva idag",
      `Du har redan lärt in alla ord i "${lesson.name}" idag. Köra igenom hela lektionen ändå?`,
      "Kör ändå!"
    );
    if (yes) startLessonSession(lessonId, true);
    return;
  }
  // svagast först (lägsta låda), men slumpad ordning inom samma låda
  const minBox = (c) => Math.min(getEntry(c, "f2b").box || 0, getEntry(c, "b2f").box || 0);
  const ordered = [...pool]
    .map((c) => ({ c, box: minBox(c), r: Math.random() }))
    .sort((a, b) => a.box - b.box || a.r - b.r)
    .map((x) => x.c);
  const lim = sessionLimit();
  const queue = lim ? ordered.slice(0, lim) : ordered;
  queue.forEach((c) => runSeen.add(c.id)); // markera som sedda i rundan
  const note = lim && ordered.length > queue.length
    ? `Pass klart! 🎉 ${queue.length} av ${ordered.length} ord – resten kommer nästa pass.`
    : "";
  beginSession({ queue, dirMode, label: lesson.name, note, kind: "lesson", lessonId, forced: force, continueLimit: (lim && ordered.length > queue.length) ? lim : 0 });
}

function startDueSession(continuing = false) {
  if (!continuing) runSeen = new Set(); // ny runda
  const now = Date.now();
  const dirMode = dirSelect.value;
  const due = [];
  const inDue = new Set();
  currentSubject.lessons.forEach((l) =>
    l.cards.forEach((c) => {
      if (isDueNow(c, dirMode, now) && !runSeen.has(c.id)) {
        due.push(c); inDue.add(c.id);
      }
    })
  );
  // Lägg till dagens nya ord (låda 0, disjunkt från isDue-mängden).
  todaysNewCards(currentSubject).forEach((c) => {
    if (!inDue.has(c.id) && !runSeen.has(c.id)) { due.push(c); inDue.add(c.id); }
  });
  if (!due.length) return;
  due.sort((a, b) => Math.min(getEntry(a, "f2b").due, getEntry(a, "b2f").due) -
    Math.min(getEntry(b, "f2b").due, getEntry(b, "b2f").due));
  const lim = sessionLimit();
  const queue = lim ? due.slice(0, lim) : due;
  queue.forEach((c) => runSeen.add(c.id)); // markera som sedda i rundan
  const note = lim && due.length > queue.length
    ? `Pass klart! 🎉 ${queue.length} av ${due.length} förfallna ord – resten kvar.`
    : "";
  beginSession({ queue, dirMode, label: "Dags att öva", note, kind: "due", continueLimit: (lim && due.length > queue.length) ? lim : 0 });
}

function beginSession({ queue, dirMode, label, note, kind, lessonId, forced, continueLimit }) {
  // nollställ ev. kvarvarande svep-feedback så den inte blinkar till vid sessionsstart
  feedbackEl.classList.remove("show");
  feedbackEl.textContent = "";
  session = { queue: queue.slice(), dirMode, total: queue.length, done: 0, label, note: note || "",
              graded: new Set(), kind: kind || null, lessonId: lessonId || null, forced: forced || false, continueLimit: continueLimit || 0 };
  undoStack = []; // ny session → inget att ångra
  requestMotionPermissionOnce(); // sker inom klick-gesten (krav på iOS)
  show("training");
  activeScreen = "training";
  updateAutospeakRow();
  loadCard();
}

function updateProgress() {
  if (!session) return;
  progressPill.textContent = `${session.queue.length} kvar`;
}

function loadCard(forceDir) {
  if (!session || session.queue.length === 0) {
    finishSession();
    return;
  }
  // Snäpp tillbaka till framsidan UTAN flip-animation, annars hinner baksidan
  // (svaret) skymtas medan nästa kort vänder sig rätt.
  cardInner.style.transition = "none";
  card.classList.remove("flipped");
  void cardInner.offsetWidth; // tvinga omritning så transition:none gäller
  cardInner.style.transition = "";
  const c = session.queue[0];
  const dir = forceDir || pickDir(session.dirMode);
  session.current = c;
  session.shownDir = dir;
  const showFrontFirst = dir === "f2b";
  cardFrontText.textContent = showFrontFirst ? c.front : c.back;
  cardAnswer.textContent = showFrontFirst ? c.back : c.front;
  // Minnesregeln är en svensk hjälp för det UTLÄNDSKA ordet → visa bara när svaret
  // är utländskt (b2f). Kör man TILL svenska vore den en gratisledtråd – göm den.
  cardHint.textContent = !showFrontFirst ? (c.hint || "") : "";
  cardFrontHint.textContent = ""; cardFrontHint.classList.add("hidden"); // ny ledtråd döljs tills lampan trycks
  updateProgress();
  updateStack();
  showSpeakSoon(300);
  editCardBtn.classList.remove("hidden");
  updateHintBtn();
  if (handsfreeActive) { clearTimeout(hfLoadCardTimer); hfLoadCardTimer = setTimeout(() => { if (handsfreeActive) hfSpeakFront(); }, 400); }
}

const DONE_LABELS = ["Grymt!", "Nice!", "Hell yeah!", "Snyggt!", "Kanon!", "Toppen!", "Bra jobbat!", "Yes!", "Så ska det se ut!", "Mästerligt!"];

// Hur många kort återstår faktiskt för en "Fortsätt"-knapp (respekterar runSeen,
// som vid fortsättning inte nollställs – fel-svarade visas inte förrän ny runda).
function remainingForContinue(cont) {
  const now = Date.now();
  if (cont.kind === "due") {
    const dirMode = dirSelect.value;
    const newSet = new Set(todaysNewCards(currentSubject).map((c) => c.id));
    let n = 0;
    currentSubject.lessons.forEach((l) =>
      l.cards.forEach((c) => {
        if (runSeen.has(c.id)) return;
        if (isDueNow(c, dirMode, now) || newSet.has(c.id)) n++;
      })
    );
    return n;
  }
  // lesson
  const lesson = currentSubject.lessons.find((l) => l.id === cont.lessonId);
  if (!lesson) return 0;
  const dirMode = dirSelect.value;
  const activeToday = (c) =>
    dirMode === "f2b" ? getEntry(c, "f2b").due <= now
    : dirMode === "b2f" ? getEntry(c, "b2f").due <= now
    : (getEntry(c, "f2b").due <= now || getEntry(c, "b2f").due <= now);
  return lesson.cards.filter((c) => !runSeen.has(c.id) && (cont.forced || activeToday(c))).length;
}

// Sparas så man kan ångra sista svaret även EFTER att passet tagit slut (Klar-skärmen).
let lastSession = null;
let lastSessionWasHF = false;

function finishSession() {
  const wasHF = handsfreeActive;
  stopHandsfree();
  const cont = session ? { limit: session.continueLimit, kind: session.kind, lessonId: session.lessonId, forced: session.forced } : null;
  $("congrats-sub").textContent = (session && session.note) || `${session ? session.label : ""} – klar! 🎉`;
  $("congrats-done").textContent = DONE_LABELS[Math.floor(Math.random() * DONE_LABELS.length)];

  // "Fortsätt"-knapp om man kör i pass och det finns mer kvar. Texten anpassas:
  // färre kvar än passlängden → "Ta de sista X direkt".
  const contBtn = $("congrats-continue");
  const remaining = cont && cont.limit > 0 ? remainingForContinue(cont) : 0;
  if (remaining > 0) {
    contBtn.textContent = remaining < cont.limit
      ? (remaining === 1 ? "Ta det sista direkt" : `Ta de sista ${remaining} direkt`)
      : `Fortsätt med ${cont.limit} till`;
    contBtn.classList.remove("hidden");
    contBtn.onclick = () => (cont.kind === "due" ? startDueSession(true) : startLessonSession(cont.lessonId, cont.forced, true));
  } else {
    contBtn.classList.add("hidden");
  }

  // Behåll passet så det går att ångra sista svaret från Klar-skärmen.
  lastSession = session;
  lastSessionWasHF = wasHF;
  session = null;

  // Hint om att man kan ta tillbaka sista svaret (skaka alltid; röst om handsfree).
  const undoHint = $("congrats-undo-hint");
  if (undoStack.length) {
    undoHint.textContent = wasHF
      ? 'Fel på sista? Säg "ångra" eller skaka telefonen.'
      : "Fel på sista? Skaka telefonen för att ta tillbaka.";
    undoHint.classList.remove("hidden");
  } else {
    undoHint.classList.add("hidden");
  }

  show("congrats");
  activeScreen = "congrats";
  launchConfetti();
  if (wasHF) startCongratsListen(); // lyssna efter "ångra" i röstläge
}

// Ångra sista svaret från Klar-skärmen: återuppta passet och kör vanliga undo.
function undoFromCongrats() {
  if (activeScreen !== "congrats" || !lastSession || !undoStack.length) return false;
  if (navCleanup) navCleanup();
  stopCongratsListen();
  const resumeHF = lastSessionWasHF;
  session = lastSession;
  lastSession = null;
  $("congrats-undo-hint").classList.add("hidden");
  setOnlyScreen("training"); // direkt byte – kortets in-glidning är feedbacken
  shownScreen = "training";
  activeScreen = "training";
  updateAutospeakRow();
  if (resumeHF) {
    // Återuppta handsfree: loadCard (i undoLastAnswer) läser då upp kortet och lyssnar.
    handsfreeActive = true;
    hfBtn.classList.add("active");
    if ("wakeLock" in navigator) navigator.wakeLock.request("screen").then((l) => { hfWakeLock = l; }).catch(() => {});
  }
  // Sista svarets fly-out kan ha lämnat animating=true en kort stund; på Klar-skärmen
  // är den animationen redan klar visuellt, så nollställ så undoLastAnswer inte blockeras.
  animating = false;
  return undoLastAnswer();
}

// Liten röstlyssnare på Klar-skärmen (handsfree): bara kommandot "ångra".
let congratsRec = null, congratsListening = false, congratsListenTimer = null;
function startCongratsListen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !undoStack.length) return;
  congratsListening = true;
  clearTimeout(congratsListenTimer);
  congratsListenTimer = setTimeout(stopCongratsListen, 25000); // håll inte mikrofonen för evigt
  const startRec = () => {
    if (!congratsListening) return;
    const rec = new SR();
    congratsRec = rec;
    rec.lang = "sv-SE"; rec.continuous = false; rec.interimResults = false; rec.maxAlternatives = 3;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        for (let j = 0; j < e.results[i].length; j++) {
          const t = e.results[i][j].transcript.toLowerCase();
          if (t.includes("ångra") || t.includes("ongra")) { undoFromCongrats(); return; }
        }
      }
    };
    rec.onerror = (e) => { if (e.error === "not-allowed") stopCongratsListen(); };
    rec.onend = () => { if (congratsListening) setTimeout(() => { if (congratsListening) { congratsRec = null; startRec(); } }, 250); };
    try { rec.start(); } catch (_) {}
  };
  startRec();
}
function stopCongratsListen() {
  congratsListening = false;
  clearTimeout(congratsListenTimer);
  if (congratsRec) { try { congratsRec.abort(); } catch (_) {} congratsRec = null; }
}

function launchConfetti() {
  const colors = ["#5b8cff", "#5bbf72", "#f4c542", "#e05a4f", "#b06bf0", "#ff8fab"];
  const host = $("congrats-screen"); // ligger inuti skärmen (absolut), inte fixed på body
  host.querySelectorAll(".confetti-root").forEach((el) => el.remove());
  const root = document.createElement("div");
  root.className = "confetti-root";
  for (let i = 0; i < 60; i++) {
    const p = document.createElement("i");
    const size = 6 + Math.random() * 8;
    p.style.cssText =
      `left:${Math.random() * 100}%;` +
      `width:${size}px; height:${size * 0.6}px;` +
      `background:${colors[i % colors.length]};` +
      `animation-duration:${1.6 + Math.random() * 1.6}s;` +
      `animation-delay:${Math.random() * 0.4}s;` +
      `--drift:${(Math.random() * 2 - 1) * 140}px;` +
      `--spin:${(Math.random() * 4 + 2) * 360}deg;`;
    root.appendChild(p);
  }
  host.appendChild(root);
  setTimeout(() => root.remove(), 4000);
}

function answer(grade) {
  const c = session.current;
  const dir = session.shownDir;
  // Snapshot för shake-to-undo (innan någon mutation): kö, SRS-poster, graded-medlemskap.
  const gradedKey = c.id + ":" + dir;
  const otherDir0 = dir === "f2b" ? "b2f" : "f2b";
  const k1 = srsKey(c, dir), k2 = srsKey(c, otherDir0);
  undoStack.push({
    card: c, dir, grade,
    queue: session.queue.slice(),
    gradedKey, gradedHadKey: session.graded.has(gradedKey),
    srs: [[k1, srs[k1] ? { ...srs[k1] } : null], [k2, srs[k2] ? { ...srs[k2] } : null]],
  });
  if (undoStack.length > 40) undoStack.shift();
  // Endast första svaret per ord+riktning i sessionen räknas mot SRS.
  // Senare möten (efter felsvar) nöter ordet men ändrar inte lådan – så ett ord
  // man först bommade ligger kvar lågt och kommer oftare än ett man kunde direkt.
  const key = c.id + ":" + dir;
  if (!session.graded.has(key)) {
    gradeCard(c, dir, grade);
    session.graded.add(key);
    // Ett LYCKAT svar räknas som repetition även för andra riktningen:
    // är den introducerad och förfallen, skjut fram datumet (behåll lådan)
    // så att ett tränat ord försvinner helt från "Dags att öva".
    if (grade === "good" || grade === "easy") {
      const otherDir = dir === "f2b" ? "b2f" : "f2b";
      const oe = getEntry(c, otherDir);
      const now = Date.now();
      if (oe.box >= 1 && oe.due <= now) {
        oe.due = now + BOX_INTERVALS[oe.box] * DAY_MS;
        saveSRS();
      }
    }
  }
  // Köhantering inom passet (oberoende av SRS-räkningen):
  // fel → tillbaka sist; hopplöst → tillbaka snart (drilla hårt); kan/kan bra → klart
  session.queue.shift();
  if (grade === "fail") session.queue.push(c);
  else if (grade === "hard") session.queue.splice(Math.min(3, session.queue.length), 0, c);
  loadCard();
}

// ---- Feedback ----
function showFeedback(grade) {
  const map = { fail: ["✗", "#e05a4f"], good: ["✓", "#5bbf72"], easy: ["★", "#f4c542"], hard: ["⇊", "#b06bf0"] };
  const [sym, color] = map[grade];
  feedbackEl.textContent = sym;
  feedbackEl.style.color = color;
  feedbackEl.classList.remove("show", "undo-show");
  void feedbackEl.offsetWidth;
  feedbackEl.classList.add("show");
}

// =========================================================================
//  Shake-to-undo – skaka telefonen för att ångra senaste svaret
// =========================================================================
function undoLastAnswer() {
  if (!session || animating) return false;
  const snap = undoStack.pop();
  if (!snap) return false;
  // Återställ SRS-poster (radera de som inte fanns före svaret)
  snap.srs.forEach(([k, v]) => { if (v === null) delete srs[k]; else srs[k] = v; });
  saveSRS();
  // Återställ in-session "graded"-medlemskap
  if (!snap.gradedHadKey) session.graded.delete(snap.gradedKey);
  // Återställ kön (kopian hade det ångrade kortet först) och visa samma kort + riktning
  session.queue = snap.queue.slice();
  showUndoFeedback();
  loadCard(snap.dir);
  // Kortet glider tillbaka in från samma håll det lämnade (omvänd fly-out)
  const inClass = { good: "in-right", easy: "in-up", hard: "in-down", fail: "in-left" }[snap.grade] || "in-up";
  card.classList.remove("emerge", "in-right", "in-left", "in-up", "in-down");
  void card.offsetWidth;
  animating = true;
  card.classList.add(inClass);
  // 0,7s delay + 0,7s inglidning = 1,4s; lite buffert innan vi släpper interaktion
  setTimeout(() => { card.classList.remove(inClass); animating = false; }, 1450);
  return true;
}

function showUndoFeedback() {
  feedbackEl.textContent = "↩️";
  feedbackEl.style.color = "#5b8cff";
  feedbackEl.classList.remove("show", "undo-show");
  void feedbackEl.offsetWidth;
  feedbackEl.classList.add("undo-show");
}

let motionReqDone = false;
let motionListening = false;
function enableShake() {
  if (motionListening) return;
  window.addEventListener("devicemotion", onMotion);
  motionListening = true;
}
function requestMotionPermissionOnce() {
  if (motionReqDone) { enableShake(); return; }
  motionReqDone = true;
  const DME = window.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === "function") {
    DME.requestPermission().then((res) => { if (res === "granted") enableShake(); }).catch(() => {});
  } else {
    enableShake(); // äldre iOS / Android: inget tillstånd krävs
  }
}

let shakeLast = { x: 0, y: 0, z: 0, t: 0 };
let lastShakeTrigger = 0;
const SHAKE_THRESHOLD = 1800; // empiriskt; högt så vanlig gång/rörelse inte triggar – kräver medvetet kraftig skak
function onMotion(e) {
  // Skaka för att ångra fungerar både under passet och på Klar-skärmen (sista svaret).
  if (activeScreen !== "training" && activeScreen !== "congrats") return;
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  const t = Date.now();
  if (t - shakeLast.t < 100) return;
  const dt = (t - shakeLast.t) || 1;
  const speed = Math.abs((a.x || 0) + (a.y || 0) + (a.z || 0) - shakeLast.x - shakeLast.y - shakeLast.z) / dt * 10000;
  shakeLast = { x: a.x || 0, y: a.y || 0, z: a.z || 0, t };
  if (speed > SHAKE_THRESHOLD && t - lastShakeTrigger > 1200) {
    lastShakeTrigger = t;
    if (activeScreen === "congrats") undoFromCongrats();
    else undoLastAnswer();
  }
}

// =========================================================================
//  Uttal (Web Speech API)
// =========================================================================
const speakBtn = $("speak-btn");

// Autoläge: läs upp automatiskt varje gång den utländska sidan visas
const AUTO_SPEAK_KEY = "flippa-autospeak";
let autoSpeak = localStorage.getItem(AUTO_SPEAK_KEY) === "1";
function saveAutoSpeak() { localStorage.setItem(AUTO_SPEAK_KEY, autoSpeak ? "1" : "0"); }

function speak(text, lang, onEnd) {
  if (!text || !("speechSynthesis" in window)) { if (onEnd) setTimeout(onEnd, 0); return; }
  const u = new SpeechSynthesisUtterance(text);
  if (lang) {
    u.lang = lang;
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => x.lang === lang) ||
              voices.find((x) => x.lang.replace("_", "-").startsWith(lang.slice(0, 2)));
    if (v) u.voice = v;
  }
  if (onEnd) u.onend = onEnd;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// Är den utländska sidan (front-fältet) synlig just nu?
function foreignVisible() {
  if (!session || !session.current) return false;
  const flipped = card.classList.contains("flipped");
  return session.shownDir === "f2b" ? !flipped : flipped;
}

// Finns en röst för språket på den här enheten? (okänt = visa hellre)
function hasVoiceFor(lang) {
  if (!lang || !("speechSynthesis" in window)) return false;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return true; // röstlistan ej laddad än
  const p = lang.slice(0, 2);
  return voices.some((v) => v.lang.replace("_", "-").slice(0, 2) === p);
}

function updateSpeakBtn() {
  const lang = subjectLang(currentSubject);
  const ok = !!lang && foreignVisible() && hasVoiceFor(lang);
  speakBtn.classList.toggle("hidden", !ok);
}

// Dölj knappen direkt och visa den först när animationen (flipp/emerge) är klar
function showSpeakSoon(delay) {
  speakBtn.classList.add("hidden");
  setTimeout(() => {
    updateSpeakBtn();
    // autoläge: läs upp så fort den utländska sidan blir synlig
    if (autoSpeak && !handsfreeActive && session && session.current && foreignVisible() && hasVoiceFor(subjectLang(currentSubject))) {
      speak(session.current.front, subjectLang(currentSubject));
    }
  }, delay);
}

// Stacken speglar antal kort kvar UNDER det aktiva: 2+ → två, 1 → ett, sista → inga
const cardStack = document.querySelector(".card-stack");
function updateStack() {
  const under = session ? Math.max(0, session.queue.length - 1) : 0;
  const n = under >= 2 ? 2 : under;
  cardStack.classList.toggle("stack-2", n === 2);
  cardStack.classList.toggle("stack-1", n === 1);
  cardStack.classList.toggle("stack-0", n === 0);
}

// Högtalaren på kortet: ett tryck = läs upp en gång (tryck flera ggr för att höra igen)
function speakCurrent() {
  if (session && session.current) speak(session.current.front, subjectLang(currentSubject));
}
speakBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
speakBtn.addEventListener("click", (e) => { e.stopPropagation(); speakCurrent(); });

// Glödlampan: visas på prompt-sidan när man kör Från svenska (b2f) och kortet har en
// minnesregel. Tryck → visar BARA regeln (ledtråd) utan att avslöja svaret.
function updateHintBtn() {
  const c = session && session.current;
  const ok = activeScreen === "training" && !!(c && c.hint) && session && session.shownDir === "b2f"
    && !card.classList.contains("flipped") && cardFrontHint.classList.contains("hidden");
  hintBtn.classList.toggle("hidden", !ok);
}
hintBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
hintBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const c = session && session.current;
  if (!c || !c.hint) return;
  cardFrontHint.textContent = c.hint;
  cardFrontHint.classList.remove("hidden");
  updateHintBtn(); // regeln syns nu → dölj lampan
});

// Toggle "Automatisk uppläsning" längst ner – styr autoSpeak
const autospeakRow = $("autospeak-row");
const autospeakToggle = $("autospeak-toggle");
autospeakToggle.checked = autoSpeak;
autospeakToggle.addEventListener("change", () => {
  autoSpeak = autospeakToggle.checked;
  saveAutoSpeak();
});
// Visa toggeln bara om ämnet har en röst på enheten
function updateAutospeakRow() {
  autospeakRow.classList.toggle("hidden", !hasVoiceFor(subjectLang(currentSubject)));
}

// Förladda röstlistan (laddas asynkront i vissa webbläsare)
if ("speechSynthesis" in window) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => { speechSynthesis.getVoices(); updateSpeakBtn(); };
}

// ---- Redigera ordet direkt från kortet ----
const editCardBtn = $("edit-card-btn");
editCardBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
editCardBtn.addEventListener("click", (e) => { e.stopPropagation(); editCurrentCard(); });

async function editCurrentCard() {
  if (!session || !session.current) return;
  const c = session.current;
  // hitta lektionen ordet ligger i (i ett "Dags att öva"-pass kan korten komma från flera lektioner)
  let lid = session.lessonId;
  if (!lid) {
    const les = currentSubject.lessons.find((l) => l.cards.some((x) => x.id === c.id));
    lid = les && les.id;
  }
  if (!lid) return;
  const res = await askWord(c.front, c.back, c.hint);
  if (!res) return;
  // bevara inlärningen: flytta SRS-lådorna från gamla ordnyckeln till den nya
  ["f2b", "b2f"].forEach((dir) => {
    const oldK = srsKey(c, dir);
    const newK = `${normPart(res.front)}|${normPart(res.back)}|${dir}`;
    if (oldK !== newK && srs[oldK]) srs[newK] = srs[oldK];
  });
  saveSRS();
  c.front = res.front;
  c.back = res.back;
  c.hint = res.hint || null;
  updateCard(currentSubject.id, lid, c.id, res.front, res.back, res.hint);
  // uppdatera visat kort direkt
  const showFrontFirst = session.shownDir === "f2b";
  cardFrontText.textContent = showFrontFirst ? c.front : c.back;
  cardAnswer.textContent = showFrontFirst ? c.back : c.front;
  cardHint.textContent = !showFrontFirst ? (c.hint || "") : "";
  cardFrontHint.textContent = ""; cardFrontHint.classList.add("hidden");
  updateHintBtn();
}

// =========================================================================
//  Swipe-mekanik (pointer)
// =========================================================================
let startX = 0, startY = 0, dragging = false, didSwipe = false, animating = false;
const THRESH = 80;
const ROT = 0.06;

function setDrag(dx, dy) {
  const deg = dx * ROT;
  card.style.transform = `translateX(${dx}px) translateY(${dy}px) rotate(${deg}deg)`;
}

function snapBack() {
  card.classList.add("snapping");
  card.style.transform = "";
  card.addEventListener("transitionend", () => { card.classList.remove("snapping"); updateSpeakBtn(); editCardBtn.classList.remove("hidden"); updateHintBtn(); }, { once: true });
}

function flyOut(grade) {
  animating = true;
  const cls = grade === "good" ? "fly-right" : grade === "easy" ? "fly-up" : grade === "hard" ? "fly-down" : "fly-left";
  card.classList.add(cls);
  setTimeout(() => {
    card.classList.remove("fly-right", "fly-left", "fly-up", "fly-down");
    card.style.transform = "";
    answer(grade);
    card.classList.add("emerge");
    setTimeout(() => {
      card.classList.remove("emerge");
      animating = false;
    }, 260);
  }, 220);
}

card.addEventListener("click", () => {
  if (didSwipe || animating) return;
  card.classList.toggle("flipped");
  showSpeakSoon(460);
  updateHintBtn(); // dölj lampan när svaret visas, visa igen om man vänder tillbaka
});

card.addEventListener("pointerdown", (e) => {
  if (animating) return;
  startX = e.clientX;
  startY = e.clientY;
  dragging = true;
  didSwipe = false;
  speakBtn.classList.add("hidden"); // dölj direkt när man tar i kortet
  editCardBtn.classList.add("hidden");
  hintBtn.classList.add("hidden");
  card.setPointerCapture(e.pointerId);
});

card.addEventListener("pointermove", (e) => {
  if (!dragging || animating) return;
  setDrag(e.clientX - startX, e.clientY - startY);
});

card.addEventListener("pointerup", (e) => {
  if (!dragging || animating) return;
  dragging = false;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  const adx = Math.abs(dx), ady = Math.abs(dy);

  if (ady > THRESH && ady > adx) {
    didSwipe = true;
    const g = dy < 0 ? "easy" : "hard";
    showFeedback(g);
    flyOut(g);
  } else if (dx > THRESH) {
    didSwipe = true;
    showFeedback("good");
    flyOut("good");
  } else if (dx < -THRESH) {
    didSwipe = true;
    showFeedback("fail");
    flyOut("fail");
  } else {
    snapBack();
  }
});

card.addEventListener("pointercancel", () => {
  if (!dragging) return;
  dragging = false;
  snapBack();
});

// =========================================================================
//  Modaler
// =========================================================================
const modalRoot = $("modal-root");

function closeModal() {
  modalRoot.classList.add("hidden");
  modalRoot.innerHTML = "";
}

function openModal(innerHTML) {
  modalRoot.innerHTML = `<div class="modal-backdrop"></div><div class="modal">${innerHTML}</div>`;
  modalRoot.classList.remove("hidden");
  modalRoot.querySelector(".modal-backdrop").addEventListener("click", closeModal);
  return modalRoot.querySelector(".modal");
}

// Egen dropdown som matchar appens tema (ersätter native <select>).
// items: [{value, label}], selected: value, onChange(value) (valfri).
// Returnerar { el, value (get/set) } där `el` monteras i DOM.
function buildSelect(items, selected, onChange) {
  const el = document.createElement("div");
  el.className = "cs";
  let cur = items.some((i) => i.value === selected) ? selected : (items[0] && items[0].value);
  const labelFor = (v) => (items.find((i) => i.value === v) || {}).label || "";
  el.innerHTML = `
    <button type="button" class="cs-btn"><span class="cs-cur">${esc(labelFor(cur))}</span><span class="cs-car">▾</span></button>
    <div class="cs-list hidden">${items
      .map((i) => `<button type="button" class="cs-opt ${i.value === cur ? "on" : ""}" data-v="${esc(i.value)}">${esc(i.label)}</button>`)
      .join("")}</div>`;
  const btn = el.querySelector(".cs-btn");
  const list = el.querySelector(".cs-list");
  const close = () => list.classList.add("hidden");
  const apply = (v, fire) => {
    cur = v;
    el.querySelector(".cs-cur").textContent = labelFor(cur);
    list.querySelectorAll(".cs-opt").forEach((o) => o.classList.toggle("on", o.dataset.v === cur));
    if (fire && onChange) onChange(cur);
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // stäng ev. andra öppna väljare i samma modal
    el.closest(".modal")?.querySelectorAll(".cs-list").forEach((o) => { if (o !== list) o.classList.add("hidden"); });
    list.classList.toggle("hidden");
  });
  list.querySelectorAll(".cs-opt").forEach((opt) => {
    opt.addEventListener("click", (e) => { e.stopPropagation(); apply(opt.dataset.v, true); close(); });
  });
  // klick utanför stänger
  setTimeout(() => {
    const m = el.closest(".modal");
    m && m.addEventListener("click", (e) => { if (!el.contains(e.target)) close(); });
  }, 0);
  return { el, get value() { return cur; }, set value(v) { apply(v, false); } };
}

function askName(title, value = "", okLabel = "Spara") {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>${esc(title)}</h3>
      <input type="text" id="m-input" value="${esc(value)}" autocomplete="off" />
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-primary" id="m-ok">${esc(okLabel)}</button>
      </div>`);
    const input = m.querySelector("#m-input");
    input.focus();
    input.select();
    const ok = () => { closeModal(); resolve(input.value.trim() || null); };
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(null); };
    m.querySelector("#m-ok").onclick = ok;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
  });
}

function askSubject(title, name = "", lang = "", allowDelete = false, owner = "") {
  return new Promise((resolve) => {
    const delBtn = allowDelete ? `<button class="full-btn danger" id="m-del">🗑 Ta bort ämne</button>` : "";
    const m = openModal(`
      <h3>${esc(title)}</h3>
      <label>Namn</label>
      <input type="text" id="m-name" value="${esc(name)}" autocomplete="off" />
      <label>Språk (för uttal)</label>
      <div id="m-lang-mount"></div>
      <label>Tillhör</label>
      <div id="m-owner-mount"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-primary" id="m-ok">Spara</button>
      </div>${delBtn}`);
    const langSel = buildSelect(LANG_OPTIONS.map((o) => ({ value: o.code, label: o.label })), lang);
    m.querySelector("#m-lang-mount").appendChild(langSel.el);
    const ownerSel = buildSelect(USERS.map((u) => ({ value: u.id, label: u.name })), owner || currentUser || USERS[0].id);
    m.querySelector("#m-owner-mount").appendChild(ownerSel.el);
    const nameI = m.querySelector("#m-name");
    nameI.focus();
    nameI.select();
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(null); };
    m.querySelector("#m-ok").onclick = () => {
      const n = nameI.value.trim();
      const l = langSel.value;
      const o = ownerSel.value;
      closeModal();
      resolve(n ? { name: n, lang: l, owner: o } : null);
    };
    if (allowDelete) m.querySelector("#m-del").onclick = () => { closeModal(); resolve({ delete: true }); };
    nameI.addEventListener("keydown", (e) => { if (e.key === "Enter") m.querySelector("#m-ok").click(); });
  });
}

function askWords() {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>Lägg till ord</h3>
      <p class="modal-hint">Ett ord per rad: <b>utländskt;svenskt</b> — t.ex. <code>grazie;tack</code></p>
      <textarea id="m-text" autocapitalize="none" autocorrect="off" placeholder="ciao;hej&#10;grazie;tack"></textarea>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-primary" id="m-ok">Lägg till</button>
      </div>`);
    const ta = m.querySelector("#m-text");
    ta.focus();
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(null); };
    m.querySelector("#m-ok").onclick = () => { const v = ta.value; closeModal(); resolve(v); };
  });
}

function askWord(front, back, hint) {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>Redigera ord</h3>
      <label>Utländskt (framsida)</label>
      <input type="text" id="m-front" value="${esc(front)}" autocomplete="off" autocapitalize="none" autocorrect="off" />
      <label>Svenska (baksida)</label>
      <input type="text" id="m-back" value="${esc(back)}" autocomplete="off" autocapitalize="none" autocorrect="off" />
      <label>Minnesregel (valfritt)</label>
      <textarea id="m-hint" rows="2" placeholder="t.ex. liknar engelskans …" autocapitalize="sentences">${esc(hint || "")}</textarea>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-primary" id="m-ok">Spara</button>
      </div>`);
    m.querySelector("#m-front").focus();
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(null); };
    m.querySelector("#m-ok").onclick = () => {
      const f = m.querySelector("#m-front").value.trim();
      const b = m.querySelector("#m-back").value.trim();
      const h = m.querySelector("#m-hint").value.trim();
      closeModal();
      resolve(f && b ? { front: f, back: b, hint: h } : null);
    };
  });
}

function confirmPrimary(title, message, okLabel) {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>${esc(title)}</h3>
      <p class="modal-hint">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-primary" id="m-ok">${esc(okLabel)}</button>
      </div>`);
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(false); };
    m.querySelector("#m-ok").onclick = () => { closeModal(); resolve(true); };
  });
}

function confirmDanger(title, message, okLabel = "Ta bort") {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>${esc(title)}</h3>
      <p class="modal-hint">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-danger" id="m-ok">${esc(okLabel)}</button>
      </div>`);
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(false); };
    m.querySelector("#m-ok").onclick = () => { closeModal(); resolve(true); };
  });
}

function actionSheet(title, actions) {
  return new Promise((resolve) => {
    const btns = actions
      .map((a, i) => `<button class="sheet-btn ${a.danger ? "danger" : ""}" data-i="${i}">${esc(a.label)}</button>`)
      .join("");
    const m = openModal(`<h3>${esc(title)}</h3>${btns}
      <div class="modal-actions"><button class="btn-secondary" id="m-cancel">Avbryt</button></div>`);
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(null); };
    m.querySelectorAll(".sheet-btn").forEach((b) => {
      b.onclick = () => { closeModal(); resolve(actions[+b.dataset.i].value); };
    });
  });
}

function parseLines(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(";");
      if (i < 0) return null;
      const front = line.slice(0, i).trim();
      const back = line.slice(i + 1).trim();
      return front && back ? { front, back } : null;
    })
    .filter(Boolean);
}

function flash(msg, ms = 3000) {
  showStatus(msg);
  setTimeout(() => showStatus(null), ms);
}

// Stiliserade ikoner (två omlott-rutor = kopiera; bock = klar)
const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`;
const CHECK_ICON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>`;

// Tydlig, flytande bekräftelse längst ner
function toast(msg, ms = 1700) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 250); }, ms);
}

// Kopiera text till urklipp (med fallback för äldre webbläsare). Visar kvittens.
function copyText(text, btn) {
  const done = () => {
    toast("Kopierat till urklipp ✓");
    if (btn) { btn.innerHTML = CHECK_ICON_SVG; setTimeout(() => { btn.innerHTML = COPY_ICON_SVG; }, 1300); }
  };
  const fail = () => flash("Kunde inte kopiera – markera och kopiera manuellt", 3000);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fail);
    return;
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    ok ? done() : fail();
  } catch (_) { fail(); }
}

// =========================================================================
//  Firebase-skrivningar (CRUD)
// =========================================================================
const TS = firebase.database.ServerValue.TIMESTAMP;

function writeError(err) {
  console.error(err);
  flash("Fel: " + (err.code || err.message), 4000);
}

function addSubject(name, lang, owner) {
  db.ref("content/subjects").push({ name, order: Date.now(), createdAt: TS, lang: lang || null, owner: owner || null }).catch(writeError);
}
function updateSubject(sid, name, lang, owner) {
  db.ref(`content/subjects/${sid}`).update({ name, lang: lang || null, owner: owner || null }).catch(writeError);
}
function removeSubject(sid) {
  db.ref(`content/subjects/${sid}`).remove().catch(writeError);
}
function addLesson(sid, name) {
  db.ref(`content/subjects/${sid}/lessons`).push({ name, order: Date.now(), createdAt: TS }).catch(writeError);
}
// Skapar lektion och returnerar dess nyckel direkt (för att kunna lägga kort i den på en gång)
function createLessonReturning(sid, name) {
  const ref = db.ref(`content/subjects/${sid}/lessons`).push({ name, order: Date.now(), createdAt: TS });
  ref.then(undefined, writeError);
  return ref.key;
}
function renameLesson(sid, lid, name) {
  db.ref(`content/subjects/${sid}/lessons/${lid}/name`).set(name).catch(writeError);
}
function removeLesson(sid, lid) {
  db.ref(`content/subjects/${sid}/lessons/${lid}`).remove().catch(writeError);
}
function addCards(sid, lid, cards) {
  const base = db.ref(`content/subjects/${sid}/lessons/${lid}/cards`);
  const updates = {};
  const order = Date.now();
  cards.forEach((c, i) => {
    updates[base.push().key] = { front: c.front, back: c.back, order: order + i, createdAt: TS };
  });
  return base.update(updates).catch(writeError);
}
function updateCard(sid, lid, cid, front, back, hint) {
  db.ref(`content/subjects/${sid}/lessons/${lid}/cards/${cid}`).update({ front, back, hint: hint || null }).catch(writeError);
}
function removeCard(sid, lid, cid) {
  db.ref(`content/subjects/${sid}/lessons/${lid}/cards/${cid}`).remove().catch(writeError);
}

// =========================================================================
//  CRUD-flöden (UI)
// =========================================================================
async function editSubject(sid) {
  const s = content.find((x) => x.id === sid);
  if (!s) return;
  const res = await askSubject("Redigera ämne", s.name, subjectLang(s), true, s.owner || currentUser || "");
  if (!res) return;
  if (res.delete) {
    const ok = await confirmDanger("Ta bort ämne?", `"${s.name}" och alla dess lektioner tas bort permanent.`);
    if (ok) { removeSubject(sid); renderSubjects(); }
    return;
  }
  updateSubject(sid, res.name, res.lang, res.owner);
}

const editorSearch = $("editor-search");

function setupSearchClear(inputEl, onChange) {
  const btn = inputEl.closest(".search-wrap").querySelector(".search-clear");
  const sync = () => btn.classList.toggle("hidden", !inputEl.value);
  inputEl.addEventListener("input", () => { sync(); onChange(); });
  btn.addEventListener("click", () => { inputEl.value = ""; sync(); onChange(); inputEl.focus(); });
  return sync;
}
const syncEditorClear = setupSearchClear(editorSearch, () => { if (activeScreen === "editor") renderEditor(); });
setupSearchClear($("lessons-search"), () => { if (activeScreen === "lessons") renderLessons(); });

let editorSort = "added"; // added | front-az | back-az | weak-front | weak-back

function openEditor(lessonId) {
  currentLessonId = lessonId;
  editorSearch.value = ($("lessons-search").value || "").trim();
  syncEditorClear();
  editorSort = "added";
  renderEditor();
}

// Språknamn för sorteringsetiketter (gemener), t.ex. "italienska"
function currentForeignLabel() {
  const lang = subjectLang(currentSubject);
  const opt = LANG_OPTIONS.find((o) => o.code === lang);
  return opt && opt.code ? opt.label.toLowerCase() : "utländska";
}

const sortCollator = new Intl.Collator("sv", { sensitivity: "base" });
function weakKey(c, dir) {
  const e = getEntry(c, dir);
  return (e.box || 0) * 1e15 + (e.due || 0); // lägst låda (svagast) först
}
function sortedCards(lesson) {
  const cs = [...lesson.cards];
  switch (editorSort) {
    case "front-az": return cs.sort((a, b) => sortCollator.compare(a.front, b.front));
    case "back-az": return cs.sort((a, b) => sortCollator.compare(a.back, b.back));
    case "weak-front": return cs.sort((a, b) => weakKey(a, "f2b") - weakKey(b, "f2b"));
    case "weak-back": return cs.sort((a, b) => weakKey(a, "b2f") - weakKey(b, "b2f"));
    default: return cs.sort(byOrder);
  }
}

$("sort-btn").onclick = async () => {
  const fl = currentForeignLabel();
  const opts = [
    { label: "Först tillagda", value: "added" },
    { label: `Alfabetiskt ${fl}`, value: "front-az" },
    { label: "Alfabetiskt svenska", value: "back-az" },
    { label: `Svagast från ${fl}`, value: "weak-front" },
    { label: "Svagast från svenska", value: "weak-back" },
  ].map((o) => ({ ...o, label: (o.value === editorSort ? "✓ " : "") + o.label }));
  const choice = await actionSheet("Sortera", opts);
  if (choice) { editorSort = choice; renderEditor(); }
};

function getCurrentLesson() {
  if (!currentSubject) return null;
  const s = content.find((x) => x.id === currentSubject.id) || currentSubject;
  return s.lessons.find((l) => l.id === currentLessonId) || null;
}

function renderEditor() {
  const lesson = getCurrentLesson();
  if (!lesson) return renderLessons();
  activeScreen = "editor";
  show("editor");
  $("editor-title").textContent = lesson.name;
  const list = $("editor-list");
  if (!lesson.cards.length) {
    const lang = currentForeignLabel();
    const aiPrompt = `Kan du ge mig 20 bra ord och fraser som handlar om "${lesson.name}" på ${lang}? Formatet ska vara ord/fras på ${lang};svensk översättning, en per rad`;
    list.innerHTML = `<p class="empty">Inga ord än. Tryck ＋ Lägg till ord.</p>
      <div class="ai-tip">
        <div class="ai-tip-head">
          <span>💬 Tips: be en AI om ord</span>
          <button class="ai-copy" id="ai-copy" type="button" title="Kopiera prompten">${COPY_ICON_SVG}</button>
        </div>
        <p class="ai-tip-prompt">${esc(aiPrompt)}</p>
        <p class="ai-tip-foot">Klistra in svaret via ＋ Lägg till ord.</p>
      </div>`;
    $("ai-copy").onclick = () => copyText(aiPrompt, $("ai-copy"));
    return;
  }
  const sorted = sortedCards(lesson);
  const filter = (editorSearch.value || "").trim().toLowerCase();
  const cards = filter
    ? sorted.filter((c) => c.front.toLowerCase().includes(filter) || c.back.toLowerCase().includes(filter))
    : sorted;
  if (!cards.length) {
    list.innerHTML = `<p class="empty">Inga träffar på "${esc(filter)}".</p>`;
    return;
  }
  list.innerHTML = cards
    .map(
      (c) => `<div class="word-row">
        <div class="word-texts" data-edit="${c.id}">
          <div class="word-front">${esc(c.front)}${c.hint ? ' <span class="word-hint-flag" title="Har minnesregel">💡</span>' : ""}</div>
          <div class="word-back">${esc(c.back)}</div>
        </div>
        <button class="word-del" data-del="${c.id}">🗑</button>
      </div>`
    )
    .join("");
  list.querySelectorAll(".word-texts").forEach((el) => { el.onclick = () => editWord(el.dataset.edit); });
  list.querySelectorAll(".word-del").forEach((el) => { el.onclick = () => deleteWord(el.dataset.del); });
}

async function editWord(cid) {
  const lesson = getCurrentLesson();
  if (!lesson) return;
  const c = lesson.cards.find((x) => x.id === cid);
  if (!c) return;
  const res = await askWord(c.front, c.back, c.hint);
  if (res) { c.hint = res.hint || null; updateCard(currentSubject.id, lesson.id, cid, res.front, res.back, res.hint); }
}

async function deleteWord(cid) {
  const lesson = getCurrentLesson();
  if (!lesson) return;
  const c = lesson.cards.find((x) => x.id === cid);
  if (!c) return;
  const ok = await confirmDanger("Ta bort ord?", `"${c.front}" tas bort.`);
  if (ok) removeCard(currentSubject.id, lesson.id, cid);
}

// Header-knappar
$("user-pill").onclick = pickUser;
$("add-subject").onclick = async () => {
  if (!currentUser) { pickUser(); return; } // välj profil först
  const res = await askSubject("Nytt ämne", "", "", false, currentUser);
  if (res) addSubject(res.name, res.lang, res.owner);
};
$("add-lesson").onclick = async () => {
  if (!currentSubject) return;
  const name = await askName("Ny lektion", "");
  if (name) addLesson(currentSubject.id, name);
};
$("edit-subject").onclick = () => { if (currentSubject) editSubject(currentSubject.id); };
$("rename-lesson").onclick = async () => {
  const lesson = getCurrentLesson();
  if (!lesson) return;
  const name = await askName("Byt namn på lektion", lesson.name);
  if (name) renameLesson(currentSubject.id, lesson.id, name);
};
$("delete-lesson").onclick = async () => {
  const lesson = getCurrentLesson();
  if (!lesson) return;
  const ok = await confirmDanger("Ta bort lektion?", `"${lesson.name}" och alla dess ord tas bort.`);
  if (ok) { removeLesson(currentSubject.id, lesson.id); renderLessons(); }
};
$("add-words").onclick = async () => {
  const lesson = getCurrentLesson();
  if (!lesson) return;
  const text = await askWords();
  if (text == null) return;
  const cards = parseLines(text);
  if (!cards.length) { flash("Inga giltiga rader (format: ord;översättning)"); return; }
  await addCards(currentSubject.id, lesson.id, cards);
  flash(`La till ${cards.length} ord ✓`, 2000);
};

// =========================================================================
//  Översättning (MyMemory) + lägg till
// =========================================================================
async function doTranslate(text, fromCode, toCode) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${fromCode}|${toCode}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  const status = d.responseStatus;
  if (status && String(status) !== "200") throw new Error(d.responseDetails || ("status " + status));
  return (d.responseData && d.responseData.translatedText) || "";
}

// Tvätta översättningens skiftläge så det matchar källtexten man skrev in:
// "blomkål" → gement, "Goddag" → stor första bokstav, "BLOMKÅL" → VERSALT.
function matchCase(src, target) {
  const s = (src || "").trim();
  const t = (target || "").trim();
  if (!s || !t) return t;
  const hasUpper = s !== s.toLowerCase();
  const hasLower = s !== s.toUpperCase();
  if (!hasUpper) return t.toLowerCase();      // allt gement
  if (!hasLower) return t.toUpperCase();      // ALLT VERSALT
  // inledande versal (mening/egennamn) → gement med stor första bokstav
  if (s[0] === s[0].toUpperCase() && s[0] !== s[0].toLowerCase()) {
    const low = t.toLowerCase();
    return low.charAt(0).toUpperCase() + low.slice(1);
  }
  return t; // blandat skiftläge – lämna som tjänsten gav
}

function openTranslate(defaultLessonId, prefill) {
  if (!currentSubject) return;
  const fullLang = subjectLang(currentSubject);
  const foreignCode = fullLang.slice(0, 2);
  if (!foreignCode) {
    flash("Sätt ett språk på ämnet först (redigera ämnet ✎)", 4000);
    return;
  }
  const foreignLabel = (LANG_OPTIONS.find((o) => o.code === fullLang) || {}).label || "Utländska";
  let dir = "sv2for";

  const lessonItems = currentSubject.lessons
    .map((l) => ({ value: l.id, label: l.name }))
    .concat([{ value: "__new__", label: "➕ Ny lektion…" }]);

  const m = openModal(`
    <h3>Slå upp ord</h3>
    <div class="seg" id="t-dir">
      <button data-dir="sv2for" class="seg-on">Svenska → ${esc(foreignLabel)}</button>
      <button data-dir="for2sv">${esc(foreignLabel)} → Svenska</button>
    </div>
    <label id="t-src-label">Svenska</label>
    <div class="t-row">
      <input type="text" id="t-src" autocomplete="off" autocapitalize="none" autocorrect="off" placeholder="t.ex. blomkål" />
      <button class="btn-secondary t-lookup" id="t-lookup">🔎</button>
    </div>
    <label id="t-dst-label">${esc(foreignLabel)}</label>
    <input type="text" id="t-dst" autocomplete="off" autocapitalize="none" autocorrect="off" placeholder="översättning (redigerbar)" />
    <label>Lägg till i</label>
    <div id="t-lesson-mount"></div>
    <input type="text" id="t-newlesson" class="hidden" placeholder="Namn på ny lektion" autocomplete="off" />
    <div class="modal-actions">
      <button class="btn-secondary" id="m-cancel">Stäng</button>
      <button class="btn-primary" id="t-add">Lägg till</button>
    </div>
    <p class="modal-hint">Översättning via MyMemory – kontrollera & justera vid behov.</p>`);

  const srcI = m.querySelector("#t-src");
  const dstI = m.querySelector("#t-dst");
  const newLessonI = m.querySelector("#t-newlesson");
  const lessonSel = buildSelect(lessonItems, defaultLessonId, (v) => {
    newLessonI.classList.toggle("hidden", v !== "__new__");
  });
  m.querySelector("#t-lesson-mount").appendChild(lessonSel.el);
  srcI.focus();

  if (!currentSubject.lessons.length) {
    lessonSel.value = "__new__";
    newLessonI.classList.remove("hidden");
  }

  function applyDir() {
    m.querySelectorAll("#t-dir button").forEach((b) => b.classList.toggle("seg-on", b.dataset.dir === dir));
    const sv = dir === "sv2for";
    m.querySelector("#t-src-label").textContent = sv ? "Svenska" : foreignLabel;
    m.querySelector("#t-dst-label").textContent = sv ? foreignLabel : "Svenska";
    srcI.placeholder = sv ? "t.ex. blomkål" : "t.ex. cavolfiore";
  }
  m.querySelectorAll("#t-dir button").forEach((b) => (b.onclick = () => { dir = b.dataset.dir; applyDir(); srcI.focus(); }));

  async function lookup() {
    const text = srcI.value.trim();
    if (!text) return;
    const [from, to] = dir === "sv2for" ? ["sv", foreignCode] : [foreignCode, "sv"];
    dstI.value = "…";
    try {
      dstI.value = matchCase(text, await doTranslate(text, from, to));
    } catch (e) {
      dstI.value = "";
      flash("Översättning misslyckades: " + e.message, 4000);
    }
  }
  m.querySelector("#t-lookup").onclick = lookup;
  srcI.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookup(); } });

  // Förifyll sökordet (svenska → utländskt) och slå upp direkt – då behöver man bara välja lektion.
  if (prefill) { srcI.value = prefill; lookup(); }

  m.querySelector("#m-cancel").onclick = closeModal;
  m.querySelector("#t-add").onclick = () => {
    const src = srcI.value.trim();
    const dst = dstI.value.trim();
    if (!src || !dst) { flash("Fyll i båda fälten (slå upp eller skriv själv)"); return; }
    const front = dir === "sv2for" ? dst : src; // front = utländskt
    const back = dir === "sv2for" ? src : dst;   // back = svenska
    let lessonId = lessonSel.value;
    if (lessonId === "__new__") {
      const name = newLessonI.value.trim();
      if (!name) { flash("Ange namn på den nya lektionen"); return; }
      lessonId = createLessonReturning(currentSubject.id, name);
    }
    addCards(currentSubject.id, lessonId, [{ front, back }]);
    flash(`La till "${front}" ✓`, 2000);
    closeModal();
  };
}

$("translate-subject").onclick = () => openTranslate(null);
$("translate-words").onclick = () => openTranslate(currentLessonId);

// =========================================================================
//  Backup: exportera / importera SRS-statistik (localStorage)
// =========================================================================
function buildBackup() {
  return JSON.stringify({
    app: "flippa",
    version: 1,
    exportedAt: new Date().toISOString(),
    srs: srs,
    sessionLimit: localStorage.getItem(SESSION_LIMIT_KEY) || "0",
  }, null, 0);
}

function downloadBackup(data) {
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `flippa-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openExport() {
  const data = buildBackup();
  const count = Object.keys(srs).length;
  const m = openModal(`
    <h3>Exportera statistik</h3>
    <p class="modal-hint">Din inlärningsstatistik (${count} poster) ligger lokalt och försvinner om du avinstallerar appen eller rensar webbläsardata. Spara den här som backup. Glosorna i sig ligger redan tryggt i molnet.</p>
    <textarea id="exp-text" readonly>${esc(data)}</textarea>
    <div class="modal-actions">
      <button class="btn-secondary" id="m-cancel">Stäng</button>
      <button class="btn-primary" id="exp-copy">Kopiera</button>
    </div>
    <button class="full-btn" id="exp-download">⬇︎ Ladda ner som fil</button>`);
  m.querySelector("#m-cancel").onclick = closeModal;
  m.querySelector("#exp-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(data);
      flash("Kopierat ✓", 1500);
    } catch {
      m.querySelector("#exp-text").select();
      flash("Markera och kopiera manuellt");
    }
  };
  m.querySelector("#exp-download").onclick = () => downloadBackup(data);
}

function openImport() {
  const m = openModal(`
    <h3>Importera statistik</h3>
    <p class="modal-hint">Välj en backup-fil eller klistra in JSON. Statistiken slås ihop med befintlig (importerad vinner vid krock).</p>
    <input type="file" id="imp-file" accept="application/json,.json" />
    <textarea id="imp-text" placeholder="…eller klistra in backup-JSON här"></textarea>
    <div class="modal-actions">
      <button class="btn-secondary" id="m-cancel">Avbryt</button>
      <button class="btn-primary" id="imp-go">Importera</button>
    </div>`);
  const ta = m.querySelector("#imp-text");
  m.querySelector("#imp-file").onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { ta.value = reader.result; };
    reader.readAsText(f);
  };
  m.querySelector("#m-cancel").onclick = closeModal;
  m.querySelector("#imp-go").onclick = () => {
    const txt = ta.value.trim();
    if (!txt) { flash("Välj en fil eller klistra in JSON först"); return; }
    let obj;
    try { obj = JSON.parse(txt); } catch { flash("Ogiltig JSON"); return; }
    const imported = obj && obj.srs;
    if (!imported || typeof imported !== "object") { flash("Hittar ingen statistik i filen"); return; }
    let n = 0;
    for (const k in imported) { srs[k] = imported[k]; n++; }
    saveSRS();
    migrateSrsKeys(content); // konvertera ev. gammal ID-nycklad backup till ordnyckel
    if (obj.sessionLimit != null) {
      localStorage.setItem(SESSION_LIMIT_KEY, String(obj.sessionLimit));
      sessionLimitSel.value = String(obj.sessionLimit);
    }
    closeModal();
    flash(`Importerade statistik för ${n} kort ✓`, 2500);
    renderCurrentScreen();
  };
}

$("menu-btn").onclick = async () => {
  const a = await actionSheet("Backup av statistik", [
    { label: "⬆︎ Exportera statistik", value: "export" },
    { label: "⬇︎ Importera statistik", value: "import" },
  ]);
  if (a === "export") openExport();
  else if (a === "import") openImport();
};

// =========================================================================
//  Handsfree-läge
// =========================================================================
let handsfreeActive = false;
let hfListening = false;
let hfRecognition = null;
let hfTimeoutId = null;
let hfLoadCardTimer = null;
let hfWakeLock = null;

const hfBtn = $("handsfree-btn");
const hfStatusEl = $("hf-status");

hfBtn.addEventListener("click", () => {
  if (handsfreeActive) stopHandsfree();
  else startHandsfree();
});

let hfMicGranted = false;

async function startHandsfree() {
  if (!session || !session.current) return;
  // Be om mikrofon DIREKT (inom klick-gesten), INNAN något läses upp. Annars dök
  // behörighetsdialogen upp först när vi började lyssna – appen sa "lyssnar…" fast
  // dialogen blockade, och man trodde att den hörde en. Aktivera knappen först när
  // åtkomst är klar, så inget låtsas lyssna under dialogen.
  if (!hfMicGranted && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    // iOS låser talsyntesen tills den körts i en användargest. getUserMedia nedan är
    // async, så EFTER await är vi utanför gesten → första ordet lästes inte upp (men
    // funkade gång 2, då åtkomst redan fanns och ingen await behövdes). Lås därför upp
    // TTS synkront HÄR, i tryck-gesten, med ett tyst uttalande innan vi väntar.
    if ("speechSynthesis" in window) {
      try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch (_) {}
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // behöver inte strömmen – taligenkänningen sköter sin egen
      hfMicGranted = true;
    } catch (_) {
      flash("Mikrofonåtkomst nekades – handsfree behöver mikrofonen.", 4000);
      return;
    }
    if (!session || !session.current) return; // sessionen kan ha hunnit avslutas
  }
  handsfreeActive = true;
  hfBtn.classList.add("active");
  // Snäpp tillbaka till framsidan om kortet råkar vara flippat
  if (card.classList.contains("flipped")) {
    cardInner.style.transition = "none";
    card.classList.remove("flipped");
    void cardInner.offsetWidth;
    cardInner.style.transition = "";
  }
  if ("wakeLock" in navigator) {
    navigator.wakeLock.request("screen").then((lock) => { hfWakeLock = lock; }).catch(() => {});
  }
  hfSpeakFront();
}

function stopHandsfree() {
  if (!handsfreeActive) return;
  handsfreeActive = false;
  hfListening = false;
  hfBtn.classList.remove("active");
  hfStatusEl.textContent = "";
  clearTimeout(hfTimeoutId);
  clearTimeout(hfLoadCardTimer);
  if (hfRecognition) { try { hfRecognition.abort(); } catch (_) {} hfRecognition = null; }
  if (hfWakeLock) { hfWakeLock.release().catch(() => {}); hfWakeLock = null; }
  speechSynthesis.cancel();
}

// Vilket text + språk som visas på fram- resp. baksidan just nu
function hfText(back) {
  const c = session.current;
  const f2b = session.shownDir === "f2b";
  return back ? (f2b ? c.back : c.front) : (f2b ? c.front : c.back);
}
function hfLang(back) {
  const foreign = subjectLang(currentSubject);
  const f2b = session.shownDir === "f2b";
  return back ? (f2b ? "sv-SE" : foreign) : (f2b ? foreign : "sv-SE");
}

function hfStopListening() {
  hfListening = false;
  clearTimeout(hfTimeoutId);
  if (hfRecognition) { try { hfRecognition.abort(); } catch (_) {} hfRecognition = null; }
}

function hfSpeakFront() {
  if (!handsfreeActive || !session || !session.current) return;
  clearTimeout(hfLoadCardTimer);
  hfStopListening();
  hfStatusEl.textContent = "";
  speak(hfText(false), hfLang(false), () => {
    if (handsfreeActive) hfStartListening(true);
  });
}

function hfSpeakBack(thenGrade) {
  if (!handsfreeActive || !session || !session.current) return;
  clearTimeout(hfLoadCardTimer);
  hfStopListening();
  card.classList.add("flipped");
  // "fail"/"hard" får 2 s eftertänkpaus – men om "hard" har en minnesregel ersätts
  // pausen av att regeln läses upp (i hfFinishGrade), så då räcker iOS-bufferten.
  const c = session.current;
  const willReadHint = thenGrade === "hard" && c && c.hint;
  const pause = (thenGrade === "fail" || (thenGrade === "hard" && !willReadHint)) ? 2000 : 400;
  speak(hfText(true), hfLang(true), () => {
    if (!handsfreeActive) return;
    setTimeout(() => {
      if (!handsfreeActive) return;
      if (thenGrade) hfFinishGrade(thenGrade);
      else hfStartListening(true);
    }, pause);
  });
}

// Betygssätt i röstläge. Vid "hopplöst" (hard) läses minnesregeln upp (svenska)
// som extra förstärkning innan nästa kort – om kortet har en sådan.
function hfFinishGrade(grade) {
  showFeedback(grade);
  const c = session && session.current;
  if (grade === "hard" && c && c.hint && handsfreeActive) {
    speak(c.hint, "sv-SE", () => {
      setTimeout(() => { if (handsfreeActive) flyOut(grade); }, 600);
    });
  } else {
    flyOut(grade);
  }
}

// Kommandon i matchningsordning (längsta/specifika fraser först)
const HF_CMDS = [
  { word: "hopplöst", grade: "hard" },
  { word: "flippa",   grade: null   },
  { word: "inte",     grade: "fail" },
  { word: "bra",      grade: "easy" },
  { word: "kan",      grade: "good" },
];

function hfHandleTranscript(transcript) {
  const t = transcript.toLowerCase();
  // "ångra" → ta tillbaka föregående kort. undoLastAnswer() läser upp det
  // återställda kortet och återupptar lyssning via loadCard. Om inget fanns
  // att ångra, återuppta lyssning direkt.
  if (t.includes("ångra") || t.includes("ongra")) {
    hfStatusEl.textContent = "ångra";
    hfStopListening();
    if (!undoLastAnswer()) hfStartListening(true);
    return true;
  }
  for (const cmd of HF_CMDS) {
    if (!t.includes(cmd.word)) continue;
    hfStatusEl.textContent = cmd.word;
    setTimeout(() => { if (hfStatusEl.textContent === cmd.word) hfStatusEl.textContent = "lyssnar…"; }, 1500);
    if (cmd.grade === null) {
      hfSpeakBack(null);
    } else if (card.classList.contains("flipped")) {
      // Redan flippat → svaret är redan uppläst (via "flippa"), läs inte upp igen.
      // hfFinishGrade läser ändå minnesregeln vid "hopplöst" innan nästa kort.
      hfStopListening();
      hfFinishGrade(cmd.grade);
    } else {
      // Inte flippat → läs upp svaret en gång innan betygssättning.
      hfSpeakBack(cmd.grade);
    }
    return true;
  }
  return false;
}

function hfStartListening(resetTimer) {
  if (!handsfreeActive) return;
  hfListening = true;
  hfStatusEl.textContent = "lyssnar…";

  if (resetTimer) {
    clearTimeout(hfTimeoutId);
    hfTimeoutId = setTimeout(() => {
      if (!handsfreeActive || !hfListening) return;
      if (hfRecognition) { try { hfRecognition.abort(); } catch (_) {} }
      hfListening = false;
      // Upprepa aktuell sida efter 15 s tystnad
      if (card.classList.contains("flipped")) hfSpeakBack(null);
      else hfSpeakFront();
    }, 15000);
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { hfStatusEl.textContent = "Taligenkänning stöds ej på den här enheten"; return; }

  const rec = new SR();
  hfRecognition = rec;
  rec.lang = "sv-SE";
  rec.continuous = false;
  rec.interimResults = false;
  rec.maxAlternatives = 3;

  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      for (let j = 0; j < e.results[i].length; j++) {
        if (hfHandleTranscript(e.results[i][j].transcript)) return;
      }
    }
  };

  rec.onerror = (e) => {
    if (e.error === "aborted" || e.error === "no-speech") return;
    if (e.error === "not-allowed") {
      hfStatusEl.textContent = "Mikrofon ej tillåten";
      stopHandsfree();
    }
  };

  rec.onend = () => {
    // iOS stänger av continuous mode — starta om direkt
    if (handsfreeActive && hfListening) {
      setTimeout(() => {
        if (handsfreeActive && hfListening) {
          hfRecognition = null;
          hfStartListening(false); // fortsätt utan att nolla timeout
        }
      }, 250);
    }
  };

  try { rec.start(); } catch (_) {}
}

// =========================================================================
//  PWA + start
// =========================================================================
const APP_VERSION = "v82";
const versionTag = $("version-tag"); // kan saknas om en gammal cachad index.html serveras
if (versionTag) versionTag.textContent = "Flippa " + APP_VERSION;

if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  // När en ny service worker tar över → ladda om en gång så nya versionen syns direkt
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    location.reload();
  });
  navigator.serviceWorker
    .register("sw.js", { updateViaCache: "none" })
    .then((reg) => {
      reg.update();
      // Leta efter ny version när appen kommer i förgrunden + periodiskt
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update();
      });
      setInterval(() => reg.update(), 60000);
    })
    .catch(() => {});
}

boot();
