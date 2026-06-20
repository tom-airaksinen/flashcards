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
  // lock = enkelt lösenordslås vid byte TILL profilen (asså jag fattar att du som snokar här hittar lösenordet enkelt, men det här är lite på skoj, okej?!)
  { id: "tom", name: "Tom", lock: "phl1ppzter" },
  { id: "hedvig", name: "Hedvig", lock: "horselove" },
  { id: "wille", name: "Wille", lock: "full4br0mmapappor" },
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
// Flagga från språkkodens regiondel (t.ex. "ru-RU" → 🇷🇺) via regional indicator-
// symboler, så alla språk med en landskod får flagga – inte bara en handplockad lista.
function flagForLang(code) {
  if (!code) return "";
  if (LANG_FLAG[code]) return LANG_FLAG[code]; // ev. handplockad som säker override
  const region = String(code).split("-").slice(1).find((p) => /^[A-Za-z]{2}$/.test(p));
  if (!region) return "";
  const R = region.toUpperCase();
  return String.fromCodePoint(...[...R].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
function subjectFlag(s) {
  return flagForLang(subjectLang(s));
}

// Svenskt språknamn för en BCP-47-kod (t.ex. "it-IT" → "Italienska") via Intl.
function langLabel(code) {
  if (!code) return "Inget / ej språk";
  const base = String(code).split("-")[0].toLowerCase();
  try {
    const n = new Intl.DisplayNames(["sv"], { type: "language" }).of(base);
    if (n && n.toLowerCase() !== base) return n.charAt(0).toUpperCase() + n.slice(1);
  } catch (_) {}
  return code;
}

// Språkalternativ för väljaren: alla språk enheten faktiskt kan uttala (Web Speech-
// röster), deduppade per språk, svenska namn, alfabetiskt, "Inget / ej språk" överst.
function langOptionsForPicker(selected) {
  const byBase = new Map(); // 'it' -> 'it-IT'
  const voices = ("speechSynthesis" in window) ? (speechSynthesis.getVoices() || []) : [];
  voices.forEach((v) => {
    if (!v.lang) return;
    const code = v.lang.replace("_", "-");
    const base = code.slice(0, 2).toLowerCase();
    if (base && !byBase.has(base)) byBase.set(base, code);
  });
  // Fallback om rösterna inte hunnit laddas än: kuraterad grundlista
  if (!byBase.size) LANG_OPTIONS.forEach((o) => { if (o.code) byBase.set(o.code.slice(0, 2).toLowerCase(), o.code); });
  // Behåll nuvarande val exakt (så koden inte tyst ändras när man sparar)
  if (selected) byBase.set(selected.slice(0, 2).toLowerCase(), selected);
  const items = [...byBase.values()].map((code) => {
    const flag = flagForLang(code);
    return { value: code, label: (flag ? flag + " " : "") + langLabel(code), sortKey: langLabel(code) };
  });
  items.sort((a, b) => a.sortKey.localeCompare(b.sortKey, "sv"));
  return [{ value: "", label: "Inget / ej språk" }, ...items];
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
  const wasNew = isNewCard(card); // mät INNAN mutation: nytt kort = båda lådor i 0
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
  if (wasNew) markFirstStudied(card); // stämpla första studietillfället (en gång per kort)
}

// Ett kort är "nytt" (aldrig tränat) när BÅDA riktningarna ligger i låda 0.
function isNewCard(c) {
  return getEntry(c, "f2b").box === 0 && getEntry(c, "b2f").box === 0;
}

// "Första gången studerat"-datum per kort: sätts EN gång, när ett nytt kort (låda 0)
// graderas första gången. Riktningsoberoende nyckel → räknas en gång per kort. Driver
// statistiken "nya ord" per period. Kort som redan var inlärda när spårningen infördes
// stämplas aldrig (de var inte nya då) och räknas därför inte som nya.
const FIRST_STUDIED_KEY = "flippa-firststudied-v1";
function loadFirstStudied() {
  try { return JSON.parse(localStorage.getItem(FIRST_STUDIED_KEY) || "{}") || {}; } catch { return {}; }
}
function cardKeyOf(c) { return `${normPart(c.front)}|${normPart(c.back)}`; }
function markFirstStudied(card) {
  const k = cardKeyOf(card);
  const m = loadFirstStudied();
  if (!m[k]) { m[k] = todayStr(); localStorage.setItem(FIRST_STUDIED_KEY, JSON.stringify(m)); }
}

// =========================================================================
//  Flipp-mål: distinkta "ord + riktning" per dag (150) och per vecka (1000).
//  Enhet = cardKey|dir. Samma ord åt två håll = två enheter; samma håll upprepat
//  (t.ex. efter felsvar) = en. Räknas PER ÄMNE och per profil.
// =========================================================================
const UNITS_KEY = "flippa-units-v1";          // mängder per vecka: user → subject → datum → [cardKey|dir]
const UNITCOUNT_KEY = "flippa-unitcount-v1";  // långsiktigt: user → subject → datum → antal (för heatmap)
const DAILY_GOAL = 100;
const WEEKLY_GOAL = 1000;
function loadLS(key) { try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { return {}; } }
function unitUser() { return currentUser || "guest"; }
function ymdLocal(d) { return d.toLocaleDateString("sv-SE"); }
// Datumsträngar mån–sön för veckan som innehåller idag
function currentWeekDates() {
  const t = new Date(); t.setHours(12, 0, 0, 0);
  const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return ymdLocal(d); });
}

// Registrera en flipp. Returnerar { dayCount, weekCount, crossedDay, crossedWeek }.
function recordUnitFlip(card, dir) {
  const sid = currentSubject && currentSubject.id;
  if (!sid) return null;
  const user = unitUser();
  const today = todayStr();
  const unit = `${cardKeyOf(card)}|${dir}`;

  // Veckomängder (rensas till innevarande vecka)
  const units = loadLS(UNITS_KEY);
  const us = ((units[user] || (units[user] = {}))[sid] || (units[user][sid] = {}));
  const week = currentWeekDates(), weekSet = new Set(week);
  Object.keys(us).forEach((d) => { if (!weekSet.has(d)) delete us[d]; });
  const dayArr = us[today] || (us[today] = []);
  const isNew = !dayArr.includes(unit);
  if (isNew) dayArr.push(unit);
  const distinctWeek = new Set(); week.forEach((d) => (us[d] || []).forEach((k) => distinctWeek.add(k)));
  localStorage.setItem(UNITS_KEY, JSON.stringify(units));

  const dayCount = dayArr.length, weekCount = distinctWeek.size;

  // Långsiktig dagssiffra (för heatmap), rensad ~140 dagar
  const counts = loadLS(UNITCOUNT_KEY);
  const cs = ((counts[user] || (counts[user] = {}))[sid] || (counts[user][sid] = {}));
  cs[today] = dayCount;
  const cutoff = ymdLocal((() => { const d = new Date(); d.setDate(d.getDate() - 140); return d; })());
  Object.keys(cs).forEach((d) => { if (d < cutoff) delete cs[d]; });
  localStorage.setItem(UNITCOUNT_KEY, JSON.stringify(counts));

  return { dayCount, weekCount, crossedDay: isNew && dayCount === DAILY_GOAL, crossedWeek: isNew && weekCount === WEEKLY_GOAL };
}

// Läs dagens + veckans distinkta för ett ämne (read-only, för Klar-skärmen)
function getUnitProgress(sid) {
  const us = ((loadLS(UNITS_KEY)[unitUser()] || {})[sid]) || {};
  const dayCount = (us[todayStr()] || []).length;
  const wk = new Set(); currentWeekDates().forEach((d) => (us[d] || []).forEach((k) => wk.add(k)));
  return { dayCount, weekCount: wk.size };
}

// Dagar som nått 150 inom en scope (lista av ämnen) – summerar per-ämnessiffror
function goalDaysForScope(subjects) {
  const cu = loadLS(UNITCOUNT_KEY)[unitUser()] || {};
  const perDay = {};
  subjects.forEach((s) => { const cs = cu[s.id] || {}; Object.keys(cs).forEach((d) => { perDay[d] = (perDay[d] || 0) + cs[d]; }); });
  const set = new Set(); Object.keys(perDay).forEach((d) => { if (perDay[d] >= DAILY_GOAL) set.add(d); });
  return set;
}

// =========================================================================
//  Daglig introduktion av nya ord (max 10/dag per ämne, proportionellt)
// =========================================================================
// "Dags att öva" tar in nya ord (låda 0) men släpper in högst 10 nya per dag
// och ämne, slumpat proportionellt över lektionerna. Uppsättningen väljs en
// gång per dag och persisteras (hård gräns – ingen påfyllning samma dag).
const NEW_INTRO_KEY = "flippa-newintro-v1";
const NEW_PER_DAY_KEY = "flippa-new-per-day";
// Antal nya kort per dag (inställbart, default 10). 0 = pausa nya ord. Eftersom dagens
// uppsättning väljs en gång och låses, slår en ändring igenom först nästa dag.
function newPerDay() {
  const n = parseInt(localStorage.getItem(NEW_PER_DAY_KEY), 10);
  return Number.isFinite(n) ? n : 10;
}

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
    const alloc = allocProportional(counts, Math.min(newPerDay(), totalNew));
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
    updateTabbar();
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
  updateTabbar();

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

// ---- Bottenflikar (Flippa / Statistik) ----
let activeTab = "flippa";
let statsScope = null; // ämnes-id eller "all"

function setTab(tab) {
  activeTab = tab;
  closeChoosers(); // stäng ev. öppen väljare vid flikbyte
  $("screens").classList.toggle("hidden", tab !== "flippa");
  $("stats-screen").classList.toggle("hidden", tab !== "stats");
  $("help-screen").classList.toggle("hidden", tab !== "help");
  if (tab === "stats") {
    // Default: ämnet man har aktivt i Flippa-fliken, annars Alla ämnen
    statsScope = currentSubject ? currentSubject.id : "all";
    renderStats();
  }
  updateTabbar();
}

function updateTabbar() {
  document.querySelectorAll("#tabbar .tab-btn").forEach((b) => b.classList.toggle("on", b.dataset.tab === activeTab));
  // Dölj flikfältet under pågående pass / klar-skärm i Flippa-fliken
  const hide = activeTab === "flippa" && (shownScreen === "training" || shownScreen === "congrats");
  $("tabbar").classList.toggle("hidden", hide);
  // Flikfältet är fixed → reservera dess höjd på innehållet bara när det syns
  document.body.classList.toggle("tabbar-on", !hide);
  if (!hide) {
    const h = $("tabbar").offsetHeight; // tvingar reflow → korrekt höjd (inkl. env-padding)
    if (h) document.documentElement.style.setProperty("--tabbar-h", h + "px");
  }
}

// iOS rapporterar safe-area-insetet först EFTER cold launch (när hemindikatorn dyker
// upp), vilket annars får layouten att hoppa. Latcha största sedda värdet i --sab så
// att det bara växer (krymper aldrig vid resume) → ingen återkommande glidning.
function latchSafeArea() {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none;";
  document.body.appendChild(probe);
  const v = probe.getBoundingClientRect().height;
  probe.remove();
  const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sab")) || 0;
  if (v > 0 && v > cur) document.documentElement.style.setProperty("--sab", v + "px");
}
latchSafeArea();
["resize", "orientationchange", "pageshow"].forEach((ev) =>
  window.addEventListener(ev, () => { latchSafeArea(); updateTabbar(); }));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { latchSafeArea(); updateTabbar(); }
});

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
  // Göm ＋/⋯ tills man valt vem man är (inget att lägga till/säkerhetskopiera ännu)
  $("add-subject").classList.toggle("hidden", !currentUser);
  $("menu-btn").classList.toggle("hidden", !currentUser);

  // Ingen profil vald (t.ex. ny enhet) → tomt läge
  if (!currentUser) {
    list.innerHTML = `<p class="empty">Vem är du? Välj här 👆</p>`;
    return;
  }
  // Bara den valda användarens områden
  const mine = content.filter((s) => s.owner === currentUser);
  if (!mine.length) {
    list.innerHTML = `<p class="empty">Inga ämnen för ${esc(userName(currentUser))} än. Tryck ＋ för att skapa ett.</p>`;
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
  const choice = await actionSheet("Vem är du?", USERS.map((u) => ({ label: u.name + (u.lock ? " 🔒" : ""), value: u.id })));
  if (!choice) return;
  const u = USERS.find((x) => x.id === choice);
  if (u && u.lock && choice !== currentUser) {
    const pw = await askPassword(`Lösenord för ${u.name}`);
    if (pw == null) return;                 // avbröt
    if (pw.trim() !== u.lock) { toast("Fel lösenord", 2500); return; }
  }
  setUser(choice);
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
    list.innerHTML = `<p class="empty">Inga lektioner matchar "${esc(raw)}".</p>`
      + (canLookUp ? `<p class="empty"><button type="button" class="link-action" id="lookup-add">🔎 Slå upp &amp; lägg till</button></p>` : "");
    if (canLookUp) $("lookup-add").onclick = () => openTranslate(null, raw);
    return;
  }
  // Dagens introducerade nya ord räknas redan i "dags" – exkludera dem ur "nya"
  // så taggarna delar upp helheten (dags = att göra idag, nya = återstående backlog).
  const introducedToday = new Set(todaysNewCards(currentSubject).map((c) => c.id));
  list.innerHTML = lessonsToShow
    .map((l) => {
      const d = dueCountForLessons([l]);
      const dueTag = d > 0 ? `<span class="due-tag">${d} dags</span>` : "";
      const nNew = l.cards.reduce((n, c) => n + (isNewCard(c) && !introducedToday.has(c.id) ? 1 : 0), 0);
      const newTag = nNew > 0 ? `<span class="new-tag">${nNew} nya</span>` : "";
      return `<div class="row" data-lesson="${l.id}">
        <span class="row-title">${esc(l.name)}</span>
        <span class="row-meta">${newTag}${dueTag}${l.cards.length} ord</span>
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
    closeChoosers(); // stäng ev. öppen väljare när man backar
    if (activeScreen === "training") { commitSessionStats(); session = null; } // logga avbrutet pass
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
function closeChoosers() {
  dirChooser.classList.remove("open");
  limitChooser.classList.remove("open");
  $("opt-backdrop").classList.remove("show");
}
function toggleChooser(which) {
  const open = which === "dir" ? dirChooser : limitChooser;
  const other = which === "dir" ? limitChooser : dirChooser;
  other.classList.remove("open");
  const willOpen = !open.classList.contains("open");
  open.classList.toggle("open", willOpen);
  $("opt-backdrop").classList.toggle("show", willOpen);
}
function syncOptionPills() {
  const dirOpt = dirSelect.options[dirSelect.selectedIndex];
  $("dir-val").textContent = dirOpt ? dirOpt.text : "Från svenska";
  $("limit-val").textContent = limitLabel(sessionLimitSel.value);
  dirChooser.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === dirSelect.value));
  $("limit-segs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === sessionLimitSel.value));
  const npd = String(newPerDay());
  $("newperday-segs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === npd));
}
dirPill.onclick = () => toggleChooser("dir");
limitPill.onclick = () => toggleChooser("limit");
$("opt-backdrop").onclick = closeChoosers;
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
// Nya kort per dag – stäng INTE väljaren så noteringen ("gäller från imorgon") syns
$("newperday-segs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  localStorage.setItem(NEW_PER_DAY_KEY, b.dataset.v);
  syncOptionPills();
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

// Ta bort fokus från textfält (och stäng tangentbordet) – så iOS inte har någon
// pågående "skrivning" att ångra, vilket annars triggar systemets "Skaka för att
// ångra"-ruta samtidigt som vår egen skak-ångra.
function blurActiveInput() {
  const el = document.activeElement;
  if (el && typeof el.blur === "function" && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) el.blur();
}

// =========================================================================
//  Träningsstatistik (localStorage) – grund för streak/kalender/volym senare
// =========================================================================
const STATS_KEY = "flippa-stats-v1";
const STATS_PERIOD_KEY = "flippa-stats-period"; // ihågkommet periodval i statistikvyn
function getStats() {
  try { const a = JSON.parse(localStorage.getItem(STATS_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
// Idempotent upsert per pass (nyckel = startedAt) – kan kallas flera ggr (slut,
// utbackning, app göms) och uppdaterar samma post med senaste värden.
function commitSessionStats() {
  const s = session;
  if (!s || !s.startedAt) return;
  const reviews = s.reviewCount || 0;
  if (reviews < 1) return; // inget övat → logga inte
  const now = Date.now();
  const rec = {
    ts: s.startedAt,
    d: new Date(s.startedAt).toLocaleDateString("sv-SE"), // YYYY-MM-DD (lokal) för kalender/streak
    ms: Math.max(0, now - s.startedAt),
    reviews,                                  // antal svar (svep) i passet
    cards: s.cardSet ? s.cardSet.size : 0,    // unika kort som mötts
    kind: s.kind || null,                     // "lesson" | "due"
    subject: s.statsSubject || null,
    user: s.statsUser || null,
    dir: s.dirMode || null,
  };
  const arr = getStats();
  const i = arr.findIndex((r) => r.ts === s.startedAt);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  if (arr.length > 5000) arr.splice(0, arr.length - 5000); // backstopp mot obegränsad tillväxt
  localStorage.setItem(STATS_KEY, JSON.stringify(arr));
}
// Logga även om appen göms/stängs mitt i ett pass
window.addEventListener("pagehide", commitSessionStats);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") commitSessionStats(); });

// Statistik-fliken (streak + heatmap + Leitner). Scope = ett ämne eller "Alla ämnen".
const STATS_BARS_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="5"/><line x1="18" y1="20" x2="18" y2="9"/></svg>`;

function renderStats() {
  const host = $("stats-screen");
  const mine = content.filter((s) => s.owner === currentUser);
  // Validera/sätt scope: default aktivt ämne, fall tillbaka på Alla ämnen
  if (statsScope == null) statsScope = currentSubject ? currentSubject.id : "all";
  if (statsScope !== "all" && !mine.some((s) => s.id === statsScope)) statsScope = "all";
  const scopeSubject = statsScope === "all" ? null : mine.find((s) => s.id === statsScope);
  const subjName = scopeSubject ? scopeSubject.name : null;

  // Skal: rubrik + ämnesväljare + kropp (alltid synliga, även utan data).
  // Ämnesväljaren är en popover med mörk/blurrad bakgrund – samma som lektionsskärmen.
  host.innerHTML = `
    <div class="cs-backdrop" id="st-cs-backdrop"></div>
    <header class="stats-header">${STATS_BARS_ICON}<h1>Statistik</h1></header>
    <div class="stats-scope cs-overlay" id="st-scope"></div>
    <div id="st-body"></div>`;

  const backdrop = $("st-cs-backdrop");
  const items = [{ value: "all", label: "Alla ämnen" }].concat(
    mine.map((s) => { const f = subjectFlag(s); return { value: s.id, label: (f ? f + " " : "") + s.name }; }));
  const sel = buildSelect(items, statsScope, (v) => { statsScope = v; renderStats(); },
    { onToggle: (open) => backdrop.classList.toggle("show", open) });
  $("st-scope").appendChild(sel.el);
  // Tryck på bakgrunden stänger väljaren
  backdrop.onclick = () => { host.querySelectorAll(".cs-list").forEach((o) => o.classList.remove("open")); backdrop.classList.remove("show"); };

  const body = $("st-body");
  const recs = getStats().filter((r) => r && (!currentUser || r.user === currentUser) && (statsScope === "all" || r.subject === subjName));
  const ymd = (d) => d.toLocaleDateString("sv-SE");
  const addD = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  const byDate = {};
  recs.forEach((r) => { if (!r.d) return; (byDate[r.d] || (byDate[r.d] = { cards: 0 })).cards += (r.cards || 0); });
  const today = new Date(); today.setHours(12, 0, 0, 0);

  if (!Object.keys(byDate).length) {
    body.innerHTML = `<p class="empty" style="padding:24px 0">Ingen statistik än – kör ett pass så börjar det fyllas på! 🚀</p>`;
    return;
  }

  // nuvarande streak (tillåt att dagens inte är klar än → börja på gårdagen) – periodoberoende
  let cur = 0; { let d = new Date(today); if (!byDate[ymd(d)]) d = addD(d, -1); while (byDate[ymd(d)]) { cur++; d = addD(d, -1); } }
  // längsta streak (sök 1 år bakåt) – periodoberoende
  let longest = 0, run = 0; { let d = addD(today, -365); for (let i = 0; i <= 365; i++) { if (byDate[ymd(d)]) { run++; if (run > longest) longest = run; } else run = 0; d = addD(d, 1); } }

  // heatmap: 18 veckor, måndag överst, senaste veckan längst till höger (alltid hela historiken)
  const end = addD(today, 6 - ((today.getDay() + 6) % 7)); // söndag i innevarande vecka
  // Dagar som nått 150 distinkta ord (inom vald scope) – guldmarkeras
  const goalSet = goalDaysForScope(statsScope === "all" ? mine : (scopeSubject ? [scopeSubject] : []));
  let heat = "";
  for (let w = 17; w >= 0; w--) {
    let col = "";
    for (let dow = 0; dow < 7; dow++) {
      const d = addD(end, -(w * 7) - (6 - dow));
      const c = byDate[ymd(d)] ? byDate[ymd(d)].cards : 0;
      let cls = "st-d";
      if (d > today) cls += " fut";
      else if (c) cls += c >= 52 ? " l4" : c >= 32 ? " l3" : c >= 12 ? " l2" : " l1";
      if (ymd(d) === ymd(today)) cls += " today";
      if (goalSet.has(ymd(d)) && d <= today) cls += " goal";
      col += `<div class="${cls}"></div>`;
    }
    heat += `<div class="st-wk">${col}</div>`;
  }

  // Leitner-fördelning: antal kort per låda (i vald riktning; mixed = svagaste lådan)
  const dirMode = dirSelect.value;
  const boxOf = (c) => {
    const fb = (srs[srsKey(c, "f2b")] || {}).box || 0;
    const bb = (srs[srsKey(c, "b2f")] || {}).box || 0;
    return dirMode === "f2b" ? fb : dirMode === "b2f" ? bb : Math.min(fb, bb);
  };
  const ltCounts = [0, 0, 0, 0, 0, 0, 0];
  const ltSubjects = statsScope === "all" ? mine : (scopeSubject ? [scopeSubject] : []);
  ltSubjects.forEach((s) => s.lessons.forEach((l) => l.cards.forEach((c) => { ltCounts[boxOf(c)]++; })));

  // "Nya ord": idag/7/30 bygger på stämplade förstagångsdatum (funkar bara framåt).
  // "Totalt" räknar istället alla kort som lämnat låda 0 (= studerade minst en gång) –
  // det går att läsa direkt ur SRS oavsett historik, så totalsiffran blir korrekt nu.
  const fsMap = loadFirstStudied();
  const seenK = new Set();
  const firstDates = [];
  let studiedEver = 0;
  ltSubjects.forEach((s) => s.lessons.forEach((l) => l.cards.forEach((c) => {
    const k = cardKeyOf(c); if (seenK.has(k)) return; seenK.add(k);
    if (!isNewCard(c)) studiedEver++;
    const d = fsMap[k]; if (d) firstDates.push(d);
  })));
  const ltMax = Math.max(1, ...ltCounts);
  const LT_LABELS = ["Ny", "1d", "2d", "4d", "8d", "16d", "32d"];
  const leitner = ltCounts.map((n, i) =>
    `<div class="lt-col"><div class="lt-num">${n || ""}</div><div class="lt-bar b${i}" style="height:${n ? Math.max(6, Math.round(n / ltMax * 100)) : 0}%"></div><div class="lt-lbl">${LT_LABELS[i]}</div></div>`
  ).join("");

  // Periodvalet kommer ihåg sig tills man byter
  const PERIODS = [{ v: "1", label: "Idag" }, { v: "7", label: "7 dagar" }, { v: "30", label: "30 dagar" }, { v: "all", label: "Totalt" }];
  let period = localStorage.getItem(STATS_PERIOD_KEY) || "30";
  if (!PERIODS.some((p) => p.v === period)) period = "30";

  function periodKpis(p) {
    const cutoff = p === "all" ? "" : ymd(addD(today, -(parseInt(p, 10) - 1))); // YYYY-MM-DD; sträng-jämförelse funkar
    const pRecs = recs.filter((r) => r.d && (p === "all" || r.d >= cutoff));
    const pass = pRecs.length;
    const kort = pRecs.reduce((a, r) => a + (r.cards || 0), 0);
    const min = Math.round(pRecs.reduce((a, r) => a + (r.ms || 0), 0) / 60000);
    // Totalt = alla kort ute ur låda 0 (livstid); fönster = stämplade datum inom perioden
    const nya = p === "all" ? studiedEver : firstDates.filter((d) => d >= cutoff).length;
    return { pass, kort, min, nya };
  }

  body.innerHTML = `
    <div class="st-hero"><div class="st-big">${cur}<span class="st-u"> dagar</span></div><div class="st-cap">🔥 nuvarande streak · längsta ${longest}</div></div>
    <div class="opt-segs st-period" id="st-period">${PERIODS.map((p) => `<button type="button" data-v="${p.v}">${p.label}</button>`).join("")}</div>
    <div class="st-grid" id="st-grid"></div>
    <div class="st-sec">SENASTE 18 VECKORNA</div>
    <div class="st-heatwrap"><div class="st-heat">${heat}</div></div>
    <div class="st-legend"><span>mindre</span><span class="st-d"></span><span class="st-d l1"></span><span class="st-d l2"></span><span class="st-d l3"></span><span class="st-d l4"></span><span>mer</span></div>
    <div class="st-sec">LEITNER</div>
    <div class="st-leitner">${leitner}</div>`;

  const segs = body.querySelector("#st-period");
  const grid = body.querySelector("#st-grid");
  const renderKpis = () => {
    segs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === period));
    const k = periodKpis(period);
    grid.innerHTML = `
      <div class="st-b"><div class="st-v">${k.pass}</div><div class="st-l">PASS</div></div>
      <div class="st-b"><div class="st-v">${k.kort}</div><div class="st-l">KORT</div></div>
      <div class="st-b"><div class="st-v">${k.min}</div><div class="st-l">MINUTER</div></div>
      <div class="st-b"><div class="st-v">${k.nya}</div><div class="st-l">NYA</div></div>`;
  };
  segs.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    period = b.dataset.v; localStorage.setItem(STATS_PERIOD_KEY, period); renderKpis();
  });
  renderKpis();
}

function beginSession({ queue, dirMode, label, note, kind, lessonId, forced, continueLimit }) {
  commitSessionStats(); // logga ev. tidigare (avbrutet) pass innan nytt startar
  closeChoosers(); // stäng ev. öppen riktnings-/kortväljare så popover/bakgrund inte ligger kvar
  blurActiveInput();
  // nollställ ev. kvarvarande svep-feedback så den inte blinkar till vid sessionsstart
  feedbackEl.classList.remove("show");
  feedbackEl.textContent = "";
  session = { queue: queue.slice(), dirMode, total: queue.length, done: 0, label, note: note || "",
              graded: new Set(), kind: kind || null, lessonId: lessonId || null, forced: forced || false, continueLimit: continueLimit || 0,
              // träningsstatistik (loggas lokalt per pass)
              startedAt: Date.now(), reviewCount: 0, cardSet: new Set(),
              statsSubject: currentSubject ? currentSubject.name : null, statsUser: currentUser || null };
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
  commitSessionStats(); // logga passet innan vi släpper session-objektet
  stopHandsfree();
  const cont = session ? { limit: session.continueLimit, kind: session.kind, lessonId: session.lessonId, forced: session.forced } : null;
  $("congrats-sub").textContent = (session && session.note) || `${session ? session.label : ""} – klar! 🎉`;
  $("congrats-done").textContent = DONE_LABELS[Math.floor(Math.random() * DONE_LABELS.length)];

  // Flipp-mål för aktuellt ämne: dagens + veckans distinkta ord
  const goalsEl = $("congrats-goals");
  if (currentSubject) {
    const gp = getUnitProgress(currentSubject.id);
    const dayDone = gp.dayCount >= DAILY_GOAL, weekDone = gp.weekCount >= WEEKLY_GOAL;
    goalsEl.innerHTML =
      `<div class="cg-goal ${dayDone ? "done" : ""}">💪 ${dayDone ? `${DAILY_GOAL} olika kort idag! ✓` : `${gp.dayCount} / ${DAILY_GOAL} olika kort idag`}</div>` +
      `<div class="cg-goal ${weekDone ? "done" : ""}">🏆 ${weekDone ? `${WEEKLY_GOAL} kort denna vecka! ✓` : `${gp.weekCount} / ${WEEKLY_GOAL} kort denna vecka`}</div>`;
  } else {
    goalsEl.innerHTML = "";
  }

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
  // Statistik: räkna svar + unika kort i passet
  session.reviewCount = (session.reviewCount || 0) + 1;
  (session.cardSet || (session.cardSet = new Set())).add(c.id);
  // Flipp-mål: distinkt ord+riktning per dag/vecka → firande vid milstolpe
  const flip = recordUnitFlip(c, dir);
  if (flip) {
    if (flip.crossedWeek) showAchievement("week");
    else if (flip.crossedDay) showAchievement("day");
  }
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
const globeBtn = $("globe-btn");

// Autoläge: läs upp automatiskt varje gång den utländska sidan visas
const AUTO_SPEAK_KEY = "flippa-autospeak";
// Default PÅ på ny enhet (saknad nyckel). Ett uttryckligt val att stänga av ("0") respekteras.
let autoSpeak = localStorage.getItem(AUTO_SPEAK_KEY) !== "0";
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

// Jordgloben visas så fort den UTLÄNDSKA sidan syns (kräver ingen röst, till skillnad
// mot högtalaren) – uppslag fungerar för alla språk.
function updateGlobeBtn() {
  globeBtn.classList.toggle("hidden", !(foreignVisible() && !!subjectLang(currentSubject)));
}

// Dölj knappen direkt och visa den först när animationen (flipp/emerge) är klar
function showSpeakSoon(delay) {
  speakBtn.classList.add("hidden");
  globeBtn.classList.add("hidden");
  setTimeout(() => {
    updateSpeakBtn();
    updateGlobeBtn();
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
globeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
globeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (session && session.current) openExplore(session.current.front);
});

// =========================================================================
//  Utforska ordet – betydelse (Wikipedia → Wiktionary) + bilder (Commons)
//  Allt nyckellöst och CORS-öppet, direkt från klienten. Stör inte passet.
// =========================================================================
const IMG_PER_PAGE = 9;

function wikiLang() {
  return (subjectLang(currentSubject) || "en").slice(0, 2).toLowerCase();
}

// Nivå 1-lemmatisering: ta bort inledande artikel så man söker på grundordet
// ("La tempesta" → "tempesta"). Hanterar även eliderade former ("l'acqua" → "acqua").
const ARTICLES = {
  it: ["il", "lo", "la", "i", "gli", "le", "un", "uno", "una"],
  fr: ["le", "la", "les", "un", "une", "des"],
  es: ["el", "la", "los", "las", "un", "una", "unos", "unas"],
  de: ["der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "eines", "einer"],
  en: ["the", "a", "an"],
  pt: ["o", "a", "os", "as", "um", "uma", "uns", "umas"],
};
const ELISIONS = { it: ["l", "un", "d", "dell", "all", "nell", "sull"], fr: ["l", "d", "j", "qu", "n", "s", "t", "m"], es: [], en: [] };

function stripArticle(term, lang) {
  let t = (term || "").trim();
  // Eliderad artikel först: "l'acqua", "un'amica", "d'arte" → ta bort prefixet före apostrofen
  const elide = ELISIONS[lang] || [];
  t = t.replace(/^([a-zàâäéèêëïîôöùûüçñ]{1,4})['’]\s*/i, (m, p) => elide.includes(p.toLowerCase()) ? "" : m);
  // Hel inledande artikel + mellanslag: "La tempesta" → "tempesta" (men inte om hela ordet ÄR artikeln)
  const arts = ARTICLES[lang] || [];
  const parts = t.split(/\s+/);
  if (parts.length > 1 && arts.includes(parts[0].toLowerCase())) t = parts.slice(1).join(" ");
  return t.trim() || (term || "").trim();
}

// Wikipedia-sammanfattning (ren text); saknas artikel → Wiktionary-definition.
async function fetchMeaning(lang, term) {
  try {
    const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`);
    if (r.ok) {
      const j = await r.json();
      if (j.extract && j.type !== "disambiguation") {
        return { source: "Wikipedia", text: j.extract, url: j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page };
      }
    }
  } catch (_) {}
  try {
    const r = await fetch(`https://${lang}.wiktionary.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(term)}&format=json&origin=*`);
    const j = await r.json();
    const pages = (j.query && j.query.pages) || {};
    const p = Object.values(pages)[0];
    if (p && p.extract) {
      const text = p.extract.replace(/\n{3,}/g, "\n\n").trim().slice(0, 700);
      return { source: "Wiktionary", text, url: `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(term)}` };
    }
  } catch (_) {}
  return null;
}

// Bildsök på Wikimedia Commons (filnamnrymd), thumbnails + offset för "ladda fler".
async function fetchCommonsImages(term, offset) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(term)}&gsrnamespace=6&gsrlimit=${IMG_PER_PAGE}&gsroffset=${offset}&prop=imageinfo&iiprop=url&iiurlwidth=240&format=json&origin=*`;
  const j = await (await fetch(url)).json();
  const pages = (j.query && j.query.pages) ? Object.values(j.query.pages) : [];
  return pages
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((p) => p.imageinfo && p.imageinfo[0])
    .filter((ii) => ii && ii.thumburl)
    .map((ii) => ({ thumb: ii.thumburl, full: ii.url }));
}

function openExplore(term) {
  const lang = wikiLang();
  const initial = stripArticle(term, lang); // sök på grundordet (utan artikel)
  const m = openModal(`
    <div class="modal-head"><h3>Utforska</h3></div>
    <div class="xpl-search">
      <input type="text" id="xpl-q" value="${esc(initial)}" autocomplete="off" autocapitalize="none" autocorrect="off" />
      <button class="xpl-go" id="xpl-go" title="Sök om" aria-label="Sök om">🔄</button>
    </div>
    <div class="xpl-sec">BETYDELSE</div>
    <div class="xpl-meaning" id="xpl-meaning"></div>
    <div class="xpl-sec">BILDER</div>
    <div class="xpl-imgs" id="xpl-imgs"></div>
    <button class="xpl-more hidden" id="xpl-more">Ladda fler bilder</button>
    <button class="xpl-google" id="xpl-google">🔎 Öppna på Google</button>
    <div class="modal-actions"><button class="btn-primary" id="m-ok">Stäng</button></div>`);
  m.querySelector("#m-ok").onclick = closeModal;

  const meaningEl = m.querySelector("#xpl-meaning");
  const imgsEl = m.querySelector("#xpl-imgs");
  const moreBtn = m.querySelector("#xpl-more");
  const qInput = m.querySelector("#xpl-q");
  let imgOffset = 0;

  const loadMeaning = async (q) => {
    meaningEl.innerHTML = `<span class="xpl-muted">Laddar…</span>`;
    const r = await fetchMeaning(lang, q);
    if (!r) { meaningEl.innerHTML = `<span class="xpl-muted">Ingen betydelse hittades. Prova Google nedan.</span>`; return; }
    meaningEl.innerHTML = `<span class="xpl-src">${esc(r.source)}</span><span class="xpl-body">${esc(r.text)}</span>`;
  };

  const loadImages = async (q, append) => {
    if (!append) { imgsEl.innerHTML = `<span class="xpl-muted">Laddar bilder…</span>`; imgOffset = 0; }
    let imgs = [];
    try { imgs = await fetchCommonsImages(q, imgOffset); } catch (_) {}
    if (!append) imgsEl.innerHTML = "";
    if (!append && !imgs.length) { imgsEl.innerHTML = `<span class="xpl-muted">Inga bilder hittades.</span>`; moreBtn.classList.add("hidden"); return; }
    imgs.forEach((im) => {
      const el = document.createElement("img");
      el.src = im.thumb; el.loading = "lazy";
      el.onclick = () => window.open(im.full, "_blank");
      imgsEl.appendChild(el);
    });
    imgOffset += IMG_PER_PAGE;
    moreBtn.classList.toggle("hidden", imgs.length < IMG_PER_PAGE);
  };

  const run = (q) => { const t = (q || "").trim(); if (!t) return; loadMeaning(t); loadImages(t, false); };

  m.querySelector("#xpl-go").onclick = () => run(qInput.value);
  qInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(qInput.value); } });
  moreBtn.onclick = () => loadImages(qInput.value.trim(), true);
  m.querySelector("#xpl-google").onclick = () => window.open(`https://www.google.com/search?q=${encodeURIComponent(qInput.value.trim() + " meaning")}`, "_blank");

  run(initial);
}

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
  const res = await askWord(c.front, c.back, c.hint, true);
  if (!res) return;
  if (res._delete) {
    const ok = await confirmDanger("Ta bort ord?", `"${c.front}" tas bort.`);
    if (!ok) return;
    removeCard(currentSubject.id, lid, c.id);
    session.queue = session.queue.filter((x) => x.id !== c.id); // ut ur passet direkt
    undoStack = []; // det borttagna kortet ska inte gå att ångra tillbaka
    loadCard(); // visa nästa (eller avsluta om kön är tom)
    return;
  }
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
  card.addEventListener("transitionend", () => { card.classList.remove("snapping"); updateSpeakBtn(); updateGlobeBtn(); editCardBtn.classList.remove("hidden"); updateHintBtn(); }, { once: true });
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
  globeBtn.classList.add("hidden");
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
function buildSelect(items, selected, onChange, opts = {}) {
  const onToggle = opts.onToggle; // (isOpen) – för ev. backdrop
  const el = document.createElement("div");
  el.className = "cs";
  let cur = items.some((i) => i.value === selected) ? selected : (items[0] && items[0].value);
  const labelFor = (v) => (items.find((i) => i.value === v) || {}).label || "";
  el.innerHTML = `
    <button type="button" class="cs-btn"><span class="cs-cur">${esc(labelFor(cur))}</span><span class="cs-car">▾</span></button>
    <div class="cs-list">${items
      .map((i) => `<button type="button" class="cs-opt ${i.value === cur ? "on" : ""}" data-v="${esc(i.value)}">${esc(i.label)}</button>`)
      .join("")}</div>`;
  const btn = el.querySelector(".cs-btn");
  const list = el.querySelector(".cs-list");
  const close = () => { list.classList.remove("open"); if (onToggle) onToggle(false); };
  const apply = (v, fire) => {
    cur = v;
    el.querySelector(".cs-cur").textContent = labelFor(cur);
    list.querySelectorAll(".cs-opt").forEach((o) => o.classList.toggle("on", o.dataset.v === cur));
    if (fire && onChange) onChange(cur);
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // stäng ev. andra öppna väljare i samma modal
    el.closest(".modal")?.querySelectorAll(".cs-list").forEach((o) => { if (o !== list) o.classList.remove("open"); });
    list.classList.toggle("open");
    if (onToggle) onToggle(list.classList.contains("open"));
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

function askPassword(title) {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>${esc(title)}</h3>
      <input type="password" id="m-input" autocomplete="off" autocapitalize="none" autocorrect="off" />
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-primary" id="m-ok">Lås upp</button>
      </div>`);
    const input = m.querySelector("#m-input");
    input.focus();
    const ok = () => { const v = input.value; closeModal(); resolve(v); };
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(null); };
    m.querySelector("#m-ok").onclick = ok;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
  });
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

function askSubject(title, name = "", lang = "", allowDelete = false) {
  // Ägaren väljs INTE här – den ges av aktiv profil (nytt) resp. behålls (redigering),
  // så man inte kan skapa eller flytta ett område åt en annan användare.
  return new Promise((resolve) => {
    const delBtn = allowDelete ? `<button class="full-btn danger" id="m-del">${TRASH_ICON_SVG} Ta bort ämne</button>` : "";
    const m = openModal(`
      <h3>${esc(title)}</h3>
      <label>Språk (för uttal)</label>
      <div id="m-lang-mount"></div>
      <label>Namn</label>
      <input type="text" id="m-name" value="${esc(name)}" autocomplete="off" />
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-primary" id="m-ok">Spara</button>
      </div>${delBtn}`);
    const nameI = m.querySelector("#m-name");
    // När man väljer språk föreslås namnet – men bara om namnet är tomt eller är
    // kvar på förra förslaget (så ett eget namn inte skrivs över).
    let suggested = "";
    const langSel = buildSelect(langOptionsForPicker(lang), lang, (code) => {
      if (!code) return;
      const cur = nameI.value.trim();
      if (cur === "" || cur === suggested) { suggested = langLabel(code); nameI.value = suggested; }
    });
    m.querySelector("#m-lang-mount").appendChild(langSel.el);
    if (name) { nameI.focus(); nameI.select(); } // fokusera bara vid redigering (befintligt namn)
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(null); };
    m.querySelector("#m-ok").onclick = () => {
      const n = nameI.value.trim();
      const l = langSel.value;
      closeModal();
      resolve(n ? { name: n, lang: l } : null);
    };
    if (allowDelete) m.querySelector("#m-del").onclick = () => { closeModal(); resolve({ delete: true }); };
    nameI.addEventListener("keydown", (e) => { if (e.key === "Enter") m.querySelector("#m-ok").click(); });
  });
}

// Dubblettkontroll: kollar om de utländska orden (front) redan finns i området
// (case-insensitive). Returnerar korten som ska läggas till, eller null vid avbryt.
function confirmDuplicates(subject, cards) {
  return new Promise((resolve) => {
    const where = new Map(); // normaliserad front -> lektionsnamn (första träffen)
    subject.lessons.forEach((l) => l.cards.forEach((c) => {
      const k = normPart(c.front);
      if (k && !where.has(k)) where.set(k, l.name);
    }));
    const isDup = (c) => where.has(normPart(c.front));
    const dups = cards.filter(isDup);
    if (!dups.length) { resolve(cards); return; }
    const nonDups = cards.filter((c) => !isDup(c));
    let title, body;
    if (dups.length === 1) {
      title = "Dubblett";
      const f = dups[0].front.trim();
      const word = f.charAt(0).toUpperCase() + f.slice(1);
      body = `<p class="modal-hint">${esc(word)} finns redan (i ${esc(where.get(normPart(dups[0].front)))}).</p>`;
    } else {
      title = "Dubbletter";
      const items = dups.map((c) => `<li>${esc(c.front.trim())} <span class="dup-lesson">(${esc(where.get(normPart(c.front)))})</span></li>`).join("");
      body = `<p class="modal-hint">Följande ord finns redan:</p><ul class="dup-list">${items}</ul>`;
    }
    const m = openModal(`<h3>${title}</h3>${body}
      <div class="modal-actions">
        <button class="btn-primary" id="dup-skip">Hoppa över</button>
        <button class="btn-secondary" id="dup-add">Lägg till igen</button>
      </div>`);
    modalRoot.querySelector(".modal-backdrop").addEventListener("click", () => resolve(null));
    m.querySelector("#dup-skip").onclick = () => { closeModal(); resolve(nonDups); };
    m.querySelector("#dup-add").onclick = () => { closeModal(); resolve(cards); };
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

function askWord(front, back, hint, allowDelete) {
  return new Promise((resolve) => {
    const delBtn = allowDelete ? `<button class="modal-del" id="m-del" title="Ta bort ord" aria-label="Ta bort ord">${TRASH_ICON_SVG}</button>` : "";
    const m = openModal(`
      <div class="modal-head"><h3>Redigera ord</h3>${delBtn}</div>
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
    if (allowDelete) m.querySelector("#m-del").onclick = () => { closeModal(); resolve({ _delete: true }); };
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

// Achievement-banner som glider in ovanifrån vid milstolpe. kind: "day" | "week".
let achTimer = null;
function dismissAchievement() {
  const el = $("achievement");
  if (!el) return;
  el.classList.remove("show"); // glider tillbaka upp (transform-transition 0.55s)
  setTimeout(() => el.remove(), 600);
}
function showAchievement(kind) {
  dismissAchievement();
  const old = $("achievement"); if (old) old.remove();
  clearTimeout(achTimer);
  const el = document.createElement("div");
  el.id = "achievement";
  el.className = "ach-banner " + (kind === "week" ? "ach-week" : "ach-day");
  if (kind === "week") {
    el.innerHTML = `<div class="ach-confetti"></div>
      <div class="ach-badge">🏆</div>
      <div class="ach-txt"><b>${WEEKLY_GOAL} olika kort denna vecka</b><span>Smått overkligt!</span></div>`;
  } else {
    el.innerHTML = `<div class="ach-badge">💪</div>
      <div class="ach-txt"><b>${DAILY_GOAL} olika kort idag!</b><span>Bra jobbat!</span></div>`;
  }
  document.body.appendChild(el);
  if (kind === "week") {
    const cf = el.querySelector(".ach-confetti");
    const cols = ["#fff", "#5b8cff", "#8fbf5a", "#ffd24a", "#ff8a3d"];
    for (let i = 0; i < 12; i++) {
      const s = document.createElement("i");
      s.style.left = (8 + i * 7.5) + "%";
      s.style.background = cols[i % cols.length];
      s.style.animationDelay = (0.1 + (i % 4) * 0.05) + "s";
      cf.appendChild(s);
    }
  }
  requestAnimationFrame(() => el.classList.add("show"));
  el.addEventListener("click", dismissAchievement);
  achTimer = setTimeout(dismissAchievement, kind === "week" ? 3000 : 4200);
}

// Stiliserade ikoner (två omlott-rutor = kopiera; bock = klar)
const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`;
// Stiliserad papperskorg (currentColor → vit mot rött, muted/röd i modaler) – används överallt
const TRASH_ICON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2"/><path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
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
function copyText(text, iconEl) {
  const done = () => {
    toast("Kopierat till urklipp ✓");
    if (iconEl) { iconEl.innerHTML = CHECK_ICON_SVG; setTimeout(() => { iconEl.innerHTML = COPY_ICON_SVG; }, 1300); }
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

// Öppna en AI-app. I en hemskärmsinstallerad PWA öppnar iOS vanliga https-länkar
// i en intern webbvy (där man inte är inloggad). Vi försöker därför öppna native-
// appen via dess URL-schema och faller tillbaka på webben i Safari om appen inte
// finns. Om appen öppnas göms sidan (visibilitychange) → då hoppar vi över fallbacken.
function openAiApp(scheme, web) {
  let switched = false;
  const onHide = () => { if (document.visibilityState === "hidden") switched = true; };
  document.addEventListener("visibilitychange", onHide);
  try { window.location.href = scheme; } catch (_) {}
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    if (!switched && document.visibilityState === "visible") window.open(web, "_blank");
  }, 1400);
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
  const res = await askSubject("Redigera ämne", s.name, subjectLang(s), true);
  if (!res) return;
  if (res.delete) {
    const ok = await confirmDanger("Ta bort ämne?", `"${s.name}" och alla dess lektioner tas bort permanent.`);
    if (ok) { removeSubject(sid); renderSubjects(); }
    return;
  }
  updateSubject(sid, res.name, res.lang, s.owner || currentUser); // behåll befintlig ägare
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

// Språknamn för etiketter (gemener), t.ex. "italienska"
function currentForeignLabel() {
  const lang = subjectLang(currentSubject);
  return lang ? langLabel(lang).toLowerCase() : "utländska";
}

const sortCollator = new Intl.Collator("sv", { sensitivity: "base" });
function weakKey(c, dir) {
  const e = getEntry(c, dir);
  return (e.box || 0) * 1e15 + (e.due || 0); // lägst låda (svagast) först
}
// Vilken låda (styrka) som visas på ett kort i editorn. Vid "svagast"-sortering
// speglar den den riktningen; annars den svagaste av de två riktningarna.
function strengthBox(c) {
  const fb = getEntry(c, "f2b").box || 0;
  const bb = getEntry(c, "b2f").box || 0;
  if (editorSort === "weak-front") return fb;
  if (editorSort === "weak-back") return bb;
  return Math.min(fb, bb);
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
    const aiPrompt = `Kan du ge mig 30 bra ord och fraser på temat "${lesson.name}" på ${lang}? Formatet ska vara ord/fras på ${lang};svensk översättning, en per rad`;
    // Renare tomt läge: AI-prompten är dold tills man trycker "ta hjälp av en AI".
    list.innerHTML = `
      <p class="empty">Inga ord än. Lägg till eller slå upp här ovanför, eller <button type="button" class="link-action" id="ai-help">ta hjälp av en AI</button>.</p>
      <div class="ai-tip hidden" id="ai-tip">
        <p class="ai-tip-lead">Ge denna prompt till <button type="button" class="ai-app-link" id="ai-open-gpt">ChatGPT</button>/<button type="button" class="ai-app-link" id="ai-open-claude">Claude</button>, kopiera sedan svaret och klistra in via ＋ Lägg till.</p>
        <div class="ai-prompt-copy" id="ai-copy" role="button" tabindex="0" title="Tryck för att kopiera (eller markera manuellt)">
          <span class="ai-cp-icon" id="ai-cp-icon">${COPY_ICON_SVG}</span>
          <span class="ai-cp-text">${esc(aiPrompt)}</span>
        </div>
      </div>`;
    $("ai-help").onclick = () => $("ai-tip").classList.toggle("hidden");
    // Öppna native-appen (schema) med fallback till webben i Safari
    $("ai-open-gpt").onclick = () => openAiApp("chatgpt://", "https://chatgpt.com");
    $("ai-open-claude").onclick = () => openAiApp("claude://", "https://claude.ai");
    // iOS tillåter clipboard-skrivning bara från ett riktigt tryck (click), inte
    // pointerdown → kopiera vid klick. Texten är även markerbar som manuell reserv.
    $("ai-copy").onclick = () => copyText(aiPrompt, $("ai-cp-icon"));
    return;
  }
  const sorted = sortedCards(lesson);
  const filter = (editorSearch.value || "").trim().toLowerCase();
  const cards = filter
    ? sorted.filter((c) => c.front.toLowerCase().includes(filter) || c.back.toLowerCase().includes(filter))
    : sorted;
  if (!cards.length) {
    const raw = (editorSearch.value || "").trim();
    const canLookUp = !!subjectLang(currentSubject);
    list.innerHTML = `<p class="empty">Inga träffar på "${esc(raw)}".</p>`
      + (canLookUp ? `<p class="empty"><button type="button" class="link-action" id="lookup-add-editor">🔎 Slå upp &amp; lägg till</button></p>` : "");
    if (canLookUp) $("lookup-add-editor").onclick = () => openTranslate(currentLessonId, raw);
    return;
  }
  // Lådbadgen visas bara vid de riktningsbaserade "svagast"-sorteringarna.
  const showBox = editorSort === "weak-front" || editorSort === "weak-back";
  list.innerHTML = cards
    .map((c) => {
      let badge = "";
      if (showBox) {
        const box = strengthBox(c);
        badge = `<span class="box-badge b${box}" title="${box === 0 ? "Aldrig tränat (ny)" : `Låda ${box} av 6 – ju högre desto starkare`}">${box === 0 ? "Ny" : box}</span>`;
      }
      return `<div class="word-row" data-id="${c.id}">
        <button class="word-row-del" data-del="${c.id}" aria-label="Ta bort ord" title="Ta bort ord">${TRASH_ICON_SVG}</button>
        <div class="word-row-main">
          <div class="word-texts">
            <div class="word-front">${esc(c.front)}${c.hint ? ' <span class="word-hint-flag" title="Har minnesregel">💡</span>' : ""}</div>
            <div class="word-back">${esc(c.back)}</div>
          </div>
          ${badge}
        </div>
      </div>`;
    })
    .join("");
  list.querySelectorAll(".word-row").forEach((row) => attachSwipeDelete(row, row.dataset.id));
}

// Swipe-to-delete på ord i editorn: svep vänster på raden → röd papperskorg
// glider fram (genväg till samma borttagning som i redigera-modalen). En liten
// horisontell rörelse räknas som svep; ett tryck utan rörelse öppnar redigering.
function attachSwipeDelete(row, cid) {
  const main = row.querySelector(".word-row-main");
  const OPEN = -72, OPEN_THRESH = 28, MOVE_SLOP = 8;
  let startX = 0, startY = 0, dx = 0, dragging = false, decided = false, horizontal = false;
  const isOpen = () => row.classList.contains("open");
  const setX = (x) => { main.style.transform = `translateX(${x}px)`; };
  // Papperskorgen är dold tills man faktiskt sveper/öppnar – annars flimrar den
  // röda ytan i radernas hörn när man scrollar listan vertikalt.
  const hideDelLater = (r) => setTimeout(() => { if (!r.classList.contains("open")) r.classList.remove("revealing"); }, 230);
  const closeOthers = () => row.parentElement.querySelectorAll(".word-row.open").forEach((r) => {
    if (r !== row) { r.classList.remove("open"); const m = r.querySelector(".word-row-main"); m.style.transition = "transform 0.2s"; m.style.transform = "translateX(0)"; hideDelLater(r); }
  });
  const snap = (open) => {
    main.style.transition = "transform 0.2s";
    row.classList.toggle("open", open);
    setX(open ? OPEN : 0);
    if (open) { row.classList.add("revealing"); closeOthers(); }
    else hideDelLater(row);
  };
  main.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button > 0) return;
    startX = e.clientX; startY = e.clientY; dx = isOpen() ? OPEN : 0;
    dragging = true; decided = false; horizontal = false;
    main.style.transition = "none";
  });
  main.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (!decided) {
      if (Math.abs(mx) < MOVE_SLOP && Math.abs(my) < MOVE_SLOP) return;
      decided = true; horizontal = Math.abs(mx) > Math.abs(my);
      if (horizontal) { row.classList.add("revealing"); try { main.setPointerCapture(e.pointerId); } catch (_) {} }
    }
    if (!horizontal) { dragging = false; return; } // vertikal → låt listan scrolla
    e.preventDefault();
    const base = isOpen() ? OPEN : 0;
    dx = Math.max(-90, Math.min(0, base + mx));
    setX(dx);
  }, { passive: false });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (!decided || !horizontal) { // tryck utan svep → redigera (eller stäng om öppen)
      main.style.transition = "";
      if (isOpen()) snap(false); else editWord(cid);
      return;
    }
    snap(dx < OPEN_THRESH * -1); // tillräckligt långt vänster → öppna
  };
  main.addEventListener("pointerup", end);
  main.addEventListener("pointercancel", () => { dragging = false; snap(isOpen()); });
  row.querySelector(".word-row-del").addEventListener("click", () => deleteWord(cid));
}

async function editWord(cid) {
  const lesson = getCurrentLesson();
  if (!lesson) return;
  const c = lesson.cards.find((x) => x.id === cid);
  if (!c) return;
  const res = await askWord(c.front, c.back, c.hint, true);
  if (!res) return;
  if (res._delete) { deleteWord(cid); return; }
  c.hint = res.hint || null; updateCard(currentSubject.id, lesson.id, cid, res.front, res.back, res.hint);
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
  const res = await askSubject("Nytt ämne", "", "", false);
  if (res) addSubject(res.name, res.lang, currentUser); // ägare = aktiv profil
};
$("add-lesson").onclick = async () => {
  if (!currentSubject) return;
  const name = await askName("Ny lektion", "");
  if (!name) return;
  const id = createLessonReturning(currentSubject.id, name);
  if (!id) return;
  // Lägg till lokalt direkt så vi kan hoppa in i den nya lektionen utan att vänta
  // på att Firebase ekar tillbaka (samma nyckel → ingen dubblett när echo kommer).
  if (!currentSubject.lessons.some((l) => l.id === id)) {
    currentSubject.lessons.push({ id, name, order: Date.now(), cards: [] });
  }
  openEditor(id); // hamna direkt inne i lektionen för att fylla på
};
$("edit-subject").onclick = () => { if (currentSubject) editSubject(currentSubject.id); };
document.querySelectorAll("#tabbar .tab-btn").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
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
  const parsed = parseLines(text);
  if (!parsed.length) { flash("Inga giltiga rader (format: ord;översättning)"); return; }
  const cards = await confirmDuplicates(currentSubject, parsed);
  if (!cards) return;                                          // avbröt
  if (!cards.length) { flash("Inget nytt – alla fanns redan", 2500); return; }
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
  const foreignLabel = fullLang ? langLabel(fullLang) : "Utländska";
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
      <input type="text" id="t-src" autocomplete="off" autocapitalize="none" autocorrect="off" placeholder="t.ex. nord;syd;väst" />
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
    <p class="modal-hint">Flera ord? Separera med <b>;</b> (t.ex. <code>nord;syd;väst</code>) så blir det en glosa var. Översättning via MyMemory – kontrollera & justera vid behov.</p>`);

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
    srcI.placeholder = sv ? "t.ex. nord;syd;väst" : "t.ex. nord;sud;ovest";
  }
  m.querySelectorAll("#t-dir button").forEach((b) => (b.onclick = () => { dir = b.dataset.dir; applyDir(); srcI.focus(); }));

  const splitTerms = (s) => (s || "").split(";").map((x) => x.trim()).filter(Boolean);

  async function lookup() {
    const parts = splitTerms(srcI.value);
    if (!parts.length) return;
    const [from, to] = dir === "sv2for" ? ["sv", foreignCode] : [foreignCode, "sv"];
    dstI.value = "…";
    try {
      const out = [];
      for (const p of parts) out.push(matchCase(p, await doTranslate(p, from, to))); // ett ord i taget
      dstI.value = out.join("; "); // flera → samma ordning, separerade med ;
    } catch (e) {
      dstI.value = "";
      toast("Översättning misslyckades: " + e.message, 4000); // toast syns ovanför modalen
    }
  }
  m.querySelector("#t-lookup").onclick = lookup;
  srcI.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookup(); } });

  // Förifyll sökordet (svenska → utländskt) och slå upp direkt – då behöver man bara välja lektion.
  if (prefill) { srcI.value = prefill; lookup(); }

  m.querySelector("#m-cancel").onclick = closeModal;
  m.querySelector("#t-add").onclick = async () => {
    const srcParts = splitTerms(srcI.value);
    const dstParts = splitTerms(dstI.value);
    if (!srcParts.length || !dstParts.length) { toast("Fyll i båda fälten (slå upp eller skriv själv)", 3000); return; }
    if (srcParts.length !== dstParts.length) {
      toast(`Olika antal ord: ${srcParts.length} mot ${dstParts.length}. Lika många på båda sidor (separera med ;).`, 4500);
      return;
    }
    // para ihop term för term → en glosa per par (front = utländskt, back = svenska)
    const cards = srcParts.map((sp, i) => {
      const dp = dstParts[i];
      return dir === "sv2for" ? { front: dp, back: sp } : { front: sp, back: dp };
    });
    // läs lektionsval INNAN dubblettdialogen (som ersätter denna modal)
    const newName = lessonSel.value === "__new__" ? newLessonI.value.trim() : null;
    if (lessonSel.value === "__new__" && !newName) { toast("Ange namn på den nya lektionen", 3000); return; }
    const finalCards = await confirmDuplicates(currentSubject, cards);
    if (!finalCards) return;                                   // avbröt
    if (!finalCards.length) { toast("Inget nytt – alla fanns redan", 3000); return; }
    const lessonId = newName ? createLessonReturning(currentSubject.id, newName) : lessonSel.value;
    addCards(currentSubject.id, lessonId, finalCards);
    flash(finalCards.length === 1 ? `La till "${finalCards[0].front}" ✓` : `La till ${finalCards.length} ord ✓`, 2000);
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
    newPerDay: localStorage.getItem(NEW_PER_DAY_KEY) || "10",
    stats: getStats(),
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
    if (obj.newPerDay != null) localStorage.setItem(NEW_PER_DAY_KEY, String(obj.newPerDay));
    if (Array.isArray(obj.stats)) { // slå ihop träningsstatistik (unik på ts), behåll båda
      const merged = new Map(getStats().map((r) => [r.ts, r]));
      obj.stats.forEach((r) => { if (r && r.ts != null) merged.set(r.ts, r); });
      const arr = [...merged.values()].sort((a, b) => a.ts - b.ts);
      localStorage.setItem(STATS_KEY, JSON.stringify(arr));
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
const APP_VERSION = "v143";
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
