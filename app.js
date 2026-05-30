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
let content = loadCachedContent(); // [{id,name,order,lessons:[{id,name,order,cards:[{id,front,back,order}]}]}]
let currentSubject = null;         // valt ämnesobjekt
let currentLessonId = null;        // lektion öppen i editorn
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
];
const LANG_GUESS = {
  italienska: "it-IT", tyska: "de-DE", franska: "fr-FR",
  spanska: "es-ES", engelska: "en-GB", portugisiska: "pt-PT", ukrainska: "uk-UA",
};
// Returnerar ämnets språkkod (explicit fält, annars gissning från namnet)
function subjectLang(s) {
  if (!s) return "";
  return s.lang || LANG_GUESS[(s.name || "").trim().toLowerCase()] || "";
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

function srsKey(cardId, dir) {
  return `${cardId}:${dir}`;
}

function getEntry(cardId, dir) {
  const k = srsKey(cardId, dir);
  if (!srs[k]) srs[k] = { box: 0, due: 0, lastSeen: 0 };
  return srs[k];
}

// "Dags att öva" = introducerade ord (låda ≥ 1) vars datum passerat.
// Nya, aldrig tränade ord (låda 0) räknas inte – dem lär man in i lektionen.
function isDue(cardId, dir, now) {
  const e = getEntry(cardId, dir);
  return e.box >= 1 && e.due <= now;
}

// grade: "fail" | "good" | "easy"
function gradeCard(cardId, dir, grade) {
  const e = getEntry(cardId, dir);
  const now = Date.now();
  if (grade === "fail" || grade === "hard") {
    e.box = 1;
    e.due = now; // dyker upp igen idag
  } else {
    const step = grade === "easy" ? 2 : 1;
    e.box = Math.min(MAX_BOX, Math.max(1, e.box) + step);
    e.due = now + BOX_INTERVALS[e.box] * DAY_MS;
  }
  e.lastSeen = now;
  saveSRS();
}

// =========================================================================
//  Datalager – Firebase + localStorage-cache
// =========================================================================
const CACHE_KEY = "flashcards-content-cache-v1";

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
      lessons: Object.entries(s.lessons || {})
        .map(([lid, l]) => ({
          id: lid,
          name: l.name,
          order: l.order ?? 0,
          cards: Object.entries(l.cards || {})
            .map(([cid, c]) => ({ id: cid, front: c.front, back: c.back, order: c.order ?? 0 }))
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
function show(screenName) {
  Object.entries(screens).forEach(([name, el]) => {
    el.classList.toggle("hidden", name !== screenName);
  });
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
  const list = $("subjects-list");
  if (!content.length) {
    list.innerHTML = `<p class="empty">Inget innehåll än.</p>`;
    return;
  }
  list.innerHTML = content
    .map((s) => {
      const cardCount = s.lessons.reduce((n, l) => n + l.cards.length, 0);
      return `<div class="row" data-subject="${s.id}">
        <span class="row-title">${esc(s.name)}</span>
        <span class="row-meta">${s.lessons.length} lekt · ${cardCount} ord</span>
        <button class="row-edit" data-edit="${s.id}">✎</button>
      </div>`;
    })
    .join("");
  list.querySelectorAll(".row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("row-edit")) return;
      openSubject(row.dataset.subject);
    });
  });
  list.querySelectorAll(".row-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editSubject(btn.dataset.edit);
    });
  });
}

function openSubject(id) {
  currentSubject = content.find((s) => s.id === id);
  renderLessons();
}

function dueCountForLessons(lessons) {
  const now = Date.now();
  let n = 0;
  lessons.forEach((l) =>
    l.cards.forEach((c) => {
      if (isDue(c.id, "f2b", now) || isDue(c.id, "b2f", now)) n++;
    })
  );
  return n;
}

function renderLessons() {
  if (!currentSubject) return renderSubjects();
  // Plocka färsk referens (innehåll kan ha uppdaterats från Firebase)
  currentSubject = content.find((s) => s.id === currentSubject.id) || currentSubject;
  activeScreen = "lessons";
  show("lessons");
  $("lessons-title").textContent = currentSubject.name;

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
  if (!currentSubject.lessons.length) {
    list.innerHTML = `<p class="empty">Inga lektioner än. Tryck ＋ för att skapa en.</p>`;
    return;
  }
  list.innerHTML = currentSubject.lessons
    .map((l) => {
      const d = dueCountForLessons([l]);
      const dueTag = d > 0 ? `<span class="due-tag">${d} dags</span>` : "";
      return `<div class="row" data-lesson="${l.id}">
        <span class="row-title">${esc(l.name)}</span>
        <span class="row-meta">${dueTag}${l.cards.length} ord</span>
        <button class="row-edit" data-edit="${l.id}">✎</button>
      </div>`;
    })
    .join("");
  list.querySelectorAll(".row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("row-edit")) return;
      startLessonSession(row.dataset.lesson);
    });
  });
  list.querySelectorAll(".row-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor(btn.dataset.edit);
    });
  });
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
const cardFront = $("card-front");
const cardBack = $("card-back");
const dirSelect = $("dir-select");
const progressPill = $("progress-pill");
const feedbackEl = $("swipe-feedback");

let session = null; // { queue:[card], dirMode, current, shownDir }

// ---- Antal kort per pass ----
const SESSION_LIMIT_KEY = "flashcards-session-limit";
const sessionLimitSel = $("session-limit");
sessionLimitSel.value = localStorage.getItem(SESSION_LIMIT_KEY) || "0";
sessionLimitSel.addEventListener("change", () => {
  localStorage.setItem(SESSION_LIMIT_KEY, sessionLimitSel.value);
});
function sessionLimit() {
  return parseInt(sessionLimitSel.value, 10) || 0; // 0 = alla
}

function pickDir(dirMode) {
  if (dirMode === "f2b") return "f2b";
  if (dirMode === "b2f") return "b2f";
  return Math.random() < 0.5 ? "f2b" : "b2f";
}

function startLessonSession(lessonId) {
  const lesson = currentSubject.lessons.find((l) => l.id === lessonId);
  if (!lesson || !lesson.cards.length) return;
  const dirMode = dirSelect.value;
  // svagast först (lägsta låda), men slumpad ordning inom samma låda
  const minBox = (c) => Math.min(getEntry(c.id, "f2b").box || 0, getEntry(c.id, "b2f").box || 0);
  const ordered = [...lesson.cards]
    .map((c) => ({ c, box: minBox(c), r: Math.random() }))
    .sort((a, b) => a.box - b.box || a.r - b.r)
    .map((x) => x.c);
  const lim = sessionLimit();
  const queue = lim ? ordered.slice(0, lim) : ordered;
  const note = lim && ordered.length > queue.length
    ? `Pass klart! 🎉 ${queue.length} av ${ordered.length} ord – resten kommer nästa pass.`
    : "";
  beginSession({ queue, dirMode, label: lesson.name, note });
}

function startDueSession() {
  const now = Date.now();
  const dirMode = dirSelect.value;
  const due = [];
  currentSubject.lessons.forEach((l) =>
    l.cards.forEach((c) => {
      if (isDue(c.id, "f2b", now) || isDue(c.id, "b2f", now)) due.push(c);
    })
  );
  if (!due.length) return;
  due.sort((a, b) => Math.min(getEntry(a.id, "f2b").due, getEntry(a.id, "b2f").due) -
    Math.min(getEntry(b.id, "f2b").due, getEntry(b.id, "b2f").due));
  const lim = sessionLimit();
  const queue = lim ? due.slice(0, lim) : due;
  const note = lim && due.length > queue.length
    ? `Pass klart! 🎉 ${queue.length} av ${due.length} förfallna ord – resten kvar.`
    : "";
  beginSession({ queue, dirMode, label: "Dags att öva", note });
}

function beginSession({ queue, dirMode, label, note }) {
  session = { queue: queue.slice(), dirMode, total: queue.length, done: 0, label, note: note || "", graded: new Set() };
  show("training");
  activeScreen = "training";
  updateAutospeakRow();
  loadCard();
}

function updateProgress() {
  if (!session) return;
  progressPill.textContent = `${session.queue.length} kvar`;
}

function loadCard() {
  if (!session || session.queue.length === 0) {
    finishSession();
    return;
  }
  card.classList.remove("flipped");
  const c = session.queue[0];
  const dir = pickDir(session.dirMode);
  session.current = c;
  session.shownDir = dir;
  const showFrontFirst = dir === "f2b";
  cardFront.textContent = showFrontFirst ? c.front : c.back;
  cardBack.textContent = showFrontFirst ? c.back : c.front;
  updateProgress();
  updateStack();
  showSpeakSoon(300);
}

const DONE_LABELS = ["Grymt!", "Nice!", "Hell yeah!", "Snyggt!", "Kanon!", "Toppen!", "Bra jobbat!", "Yes!", "Så ska det se ut!", "Mästerligt!"];

function finishSession() {
  $("congrats-sub").textContent = (session && session.note) || `${session ? session.label : ""} – klar! 🎉`;
  $("congrats-done").textContent = DONE_LABELS[Math.floor(Math.random() * DONE_LABELS.length)];
  session = null;
  show("congrats");
  activeScreen = "congrats";
  launchConfetti();
}

function launchConfetti() {
  const colors = ["#5b8cff", "#5bbf72", "#f4c542", "#e05a4f", "#b06bf0", "#ff8fab"];
  const root = document.createElement("div");
  root.className = "confetti-root";
  for (let i = 0; i < 90; i++) {
    const p = document.createElement("i");
    const size = 6 + Math.random() * 8;
    p.style.cssText =
      `left:${Math.random() * 100}vw;` +
      `width:${size}px; height:${size * 0.6}px;` +
      `background:${colors[i % colors.length]};` +
      `animation-duration:${1.6 + Math.random() * 1.6}s;` +
      `animation-delay:${Math.random() * 0.4}s;` +
      `--drift:${(Math.random() * 2 - 1) * 140}px;` +
      `--spin:${(Math.random() * 4 + 2) * 360}deg;`;
    root.appendChild(p);
  }
  document.body.appendChild(root);
  setTimeout(() => root.remove(), 4000);
}

function answer(grade) {
  const c = session.current;
  const dir = session.shownDir;
  // Endast första svaret per ord+riktning i sessionen räknas mot SRS.
  // Senare möten (efter felsvar) nöter ordet men ändrar inte lådan – så ett ord
  // man först bommade ligger kvar lågt och kommer oftare än ett man kunde direkt.
  const key = c.id + ":" + dir;
  if (!session.graded.has(key)) {
    gradeCard(c.id, dir, grade);
    session.graded.add(key);
    // Ett LYCKAT svar räknas som repetition även för andra riktningen:
    // är den introducerad och förfallen, skjut fram datumet (behåll lådan)
    // så att ett tränat ord försvinner helt från "Dags att öva".
    if (grade === "good" || grade === "easy") {
      const otherDir = dir === "f2b" ? "b2f" : "f2b";
      const oe = getEntry(c.id, otherDir);
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
  feedbackEl.classList.remove("show");
  void feedbackEl.offsetWidth;
  feedbackEl.classList.add("show");
}

// =========================================================================
//  Uttal (Web Speech API)
// =========================================================================
const speakBtn = $("speak-btn");

// Autoläge: läs upp automatiskt varje gång den utländska sidan visas
const AUTO_SPEAK_KEY = "flippa-autospeak";
let autoSpeak = localStorage.getItem(AUTO_SPEAK_KEY) === "1";
function saveAutoSpeak() { localStorage.setItem(AUTO_SPEAK_KEY, autoSpeak ? "1" : "0"); }

function speak(text, lang) {
  if (!text || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  if (lang) {
    u.lang = lang;
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => x.lang === lang) ||
              voices.find((x) => x.lang.replace("_", "-").startsWith(lang.slice(0, 2)));
    if (v) u.voice = v;
  }
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
    if (autoSpeak && session && session.current && foreignVisible() && hasVoiceFor(subjectLang(currentSubject))) {
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
  card.addEventListener("transitionend", () => { card.classList.remove("snapping"); updateSpeakBtn(); }, { once: true });
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
});

card.addEventListener("pointerdown", (e) => {
  if (animating) return;
  startX = e.clientX;
  startY = e.clientY;
  dragging = true;
  didSwipe = false;
  speakBtn.classList.add("hidden"); // dölj direkt när man tar i kortet
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

function askSubject(title, name = "", lang = "") {
  return new Promise((resolve) => {
    const opts = LANG_OPTIONS.map(
      (o) => `<option value="${o.code}" ${o.code === lang ? "selected" : ""}>${esc(o.label)}</option>`
    ).join("");
    const m = openModal(`
      <h3>${esc(title)}</h3>
      <label>Namn</label>
      <input type="text" id="m-name" value="${esc(name)}" autocomplete="off" />
      <label>Språk (för uttal)</label>
      <select id="m-lang">${opts}</select>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-primary" id="m-ok">Spara</button>
      </div>`);
    const nameI = m.querySelector("#m-name");
    nameI.focus();
    nameI.select();
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(null); };
    m.querySelector("#m-ok").onclick = () => {
      const n = nameI.value.trim();
      const l = m.querySelector("#m-lang").value;
      closeModal();
      resolve(n ? { name: n, lang: l } : null);
    };
    nameI.addEventListener("keydown", (e) => { if (e.key === "Enter") m.querySelector("#m-ok").click(); });
  });
}

function askWords() {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>Lägg till ord</h3>
      <p class="modal-hint">Ett ord per rad: <b>utländskt;svenskt</b> — t.ex. <code>grazie;tack</code></p>
      <textarea id="m-text" placeholder="ciao;hej&#10;grazie;tack"></textarea>
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

function askWord(front, back) {
  return new Promise((resolve) => {
    const m = openModal(`
      <h3>Redigera ord</h3>
      <label>Utländskt (framsida)</label>
      <input type="text" id="m-front" value="${esc(front)}" autocomplete="off" />
      <label>Svenska (baksida)</label>
      <input type="text" id="m-back" value="${esc(back)}" autocomplete="off" />
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Avbryt</button>
        <button class="btn-primary" id="m-ok">Spara</button>
      </div>`);
    m.querySelector("#m-front").focus();
    m.querySelector("#m-cancel").onclick = () => { closeModal(); resolve(null); };
    m.querySelector("#m-ok").onclick = () => {
      const f = m.querySelector("#m-front").value.trim();
      const b = m.querySelector("#m-back").value.trim();
      closeModal();
      resolve(f && b ? { front: f, back: b } : null);
    };
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

// =========================================================================
//  Firebase-skrivningar (CRUD)
// =========================================================================
const TS = firebase.database.ServerValue.TIMESTAMP;

function writeError(err) {
  console.error(err);
  flash("Fel: " + (err.code || err.message), 4000);
}

function addSubject(name, lang) {
  db.ref("content/subjects").push({ name, order: Date.now(), createdAt: TS, lang: lang || null }).catch(writeError);
}
function updateSubject(sid, name, lang) {
  db.ref(`content/subjects/${sid}`).update({ name, lang: lang || null }).catch(writeError);
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
function updateCard(sid, lid, cid, front, back) {
  db.ref(`content/subjects/${sid}/lessons/${lid}/cards/${cid}`).update({ front, back }).catch(writeError);
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
  const action = await actionSheet(s.name, [
    { label: "✎ Redigera (namn & språk)", value: "rename" },
    { label: "🗑 Ta bort ämne", value: "delete", danger: true },
  ]);
  if (action === "rename") {
    const res = await askSubject("Redigera ämne", s.name, subjectLang(s));
    if (res) updateSubject(sid, res.name, res.lang);
  } else if (action === "delete") {
    const ok = await confirmDanger("Ta bort ämne?", `"${s.name}" och alla dess lektioner tas bort permanent.`);
    if (ok) { removeSubject(sid); renderSubjects(); }
  }
}

const editorSearch = $("editor-search");
editorSearch.addEventListener("input", () => { if (activeScreen === "editor") renderEditor(); });

let editorSort = "added"; // added | front-az | back-az | weak-front | weak-back

function openEditor(lessonId) {
  currentLessonId = lessonId;
  editorSearch.value = ""; // nollställ filter vid byte av lektion
  editorSort = "added";    // default-sortering
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
  const e = getEntry(c.id, dir);
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
    list.innerHTML = `<p class="empty">Inga ord än. Tryck ＋ Lägg till ord.</p>`;
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
          <div class="word-front">${esc(c.front)}</div>
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
  const res = await askWord(c.front, c.back);
  if (res) updateCard(currentSubject.id, lesson.id, cid, res.front, res.back);
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
$("add-subject").onclick = async () => {
  const res = await askSubject("Nytt ämne", "", "");
  if (res) addSubject(res.name, res.lang);
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

function openTranslate(defaultLessonId) {
  if (!currentSubject) return;
  const fullLang = subjectLang(currentSubject);
  const foreignCode = fullLang.slice(0, 2);
  if (!foreignCode) {
    flash("Sätt ett språk på ämnet först (redigera ämnet ✎)", 4000);
    return;
  }
  const foreignLabel = (LANG_OPTIONS.find((o) => o.code === fullLang) || {}).label || "Utländska";
  let dir = "sv2for";

  const lessonOpts = currentSubject.lessons
    .map((l) => `<option value="${l.id}" ${l.id === defaultLessonId ? "selected" : ""}>${esc(l.name)}</option>`)
    .join("");

  const m = openModal(`
    <h3>Slå upp ord</h3>
    <div class="seg" id="t-dir">
      <button data-dir="sv2for" class="seg-on">Svenska → ${esc(foreignLabel)}</button>
      <button data-dir="for2sv">${esc(foreignLabel)} → Svenska</button>
    </div>
    <label id="t-src-label">Svenska</label>
    <div class="t-row">
      <input type="text" id="t-src" autocomplete="off" placeholder="t.ex. blomkål" />
      <button class="btn-secondary t-lookup" id="t-lookup">🔎</button>
    </div>
    <label id="t-dst-label">${esc(foreignLabel)}</label>
    <input type="text" id="t-dst" autocomplete="off" placeholder="översättning (redigerbar)" />
    <label>Lägg till i</label>
    <select id="t-lesson">${lessonOpts}<option value="__new__">➕ Ny lektion…</option></select>
    <input type="text" id="t-newlesson" class="hidden" placeholder="Namn på ny lektion" autocomplete="off" />
    <div class="modal-actions">
      <button class="btn-secondary" id="m-cancel">Stäng</button>
      <button class="btn-primary" id="t-add">Lägg till</button>
    </div>
    <p class="modal-hint">Översättning via MyMemory – kontrollera & justera vid behov.</p>`);

  const srcI = m.querySelector("#t-src");
  const dstI = m.querySelector("#t-dst");
  const lessonSel = m.querySelector("#t-lesson");
  const newLessonI = m.querySelector("#t-newlesson");
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
  m.querySelectorAll("#t-dir button").forEach((b) => (b.onclick = () => { dir = b.dataset.dir; applyDir(); }));

  lessonSel.onchange = () => newLessonI.classList.toggle("hidden", lessonSel.value !== "__new__");

  async function lookup() {
    const text = srcI.value.trim();
    if (!text) return;
    const [from, to] = dir === "sv2for" ? ["sv", foreignCode] : [foreignCode, "sv"];
    dstI.value = "…";
    try {
      dstI.value = await doTranslate(text, from, to);
    } catch (e) {
      dstI.value = "";
      flash("Översättning misslyckades: " + e.message, 4000);
    }
  }
  m.querySelector("#t-lookup").onclick = lookup;
  srcI.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookup(); } });

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
//  PWA + start
// =========================================================================
const APP_VERSION = "v24";
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
    .register("sw.js")
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
