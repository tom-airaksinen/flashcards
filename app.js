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

function isDue(cardId, dir, now) {
  return getEntry(cardId, dir).due <= now;
}

// grade: "fail" | "good" | "easy"
function gradeCard(cardId, dir, grade) {
  const e = getEntry(cardId, dir);
  const now = Date.now();
  if (grade === "fail") {
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
  const queue = [...lesson.cards]
    .map((c) => ({ c, box: minBox(c), r: Math.random() }))
    .sort((a, b) => a.box - b.box || a.r - b.r)
    .map((x) => x.c);
  beginSession({ queue, dirMode, label: lesson.name });
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
  beginSession({ queue: due, dirMode, label: "Dags att öva" });
}

function beginSession({ queue, dirMode, label }) {
  session = { queue: queue.slice(), dirMode, total: queue.length, done: 0, label };
  show("training");
  activeScreen = "training";
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
}

function finishSession() {
  $("congrats-sub").textContent = `${session ? session.label : ""} – klar! 🎉`;
  session = null;
  show("congrats");
  activeScreen = "congrats";
}

function answer(grade) {
  const c = session.current;
  const dir = session.shownDir;
  gradeCard(c.id, dir, grade);
  // ta bort från kön; vid fel läggs det tillbaka sist
  session.queue.shift();
  if (grade === "fail") session.queue.push(c);
  loadCard();
}

// ---- Feedback ----
function showFeedback(grade) {
  const map = { fail: ["✗", "#e05a4f"], good: ["✓", "#5bbf72"], easy: ["★", "#f4c542"] };
  const [sym, color] = map[grade];
  feedbackEl.textContent = sym;
  feedbackEl.style.color = color;
  feedbackEl.classList.remove("show");
  void feedbackEl.offsetWidth;
  feedbackEl.classList.add("show");
}

// =========================================================================
//  Swipe-mekanik (pointer)
// =========================================================================
let startX = 0, startY = 0, dragging = false, didSwipe = false, animating = false;
const THRESH = 80;
const ROT = 0.06;

function setDrag(dx, dy) {
  const deg = dx * ROT;
  const ty = Math.min(0, dy);
  card.style.transform = `translateX(${dx}px) translateY(${ty}px) rotate(${deg}deg)`;
}

function snapBack() {
  card.classList.add("snapping");
  card.style.transform = "";
  card.addEventListener("transitionend", () => card.classList.remove("snapping"), { once: true });
}

function flyOut(grade) {
  animating = true;
  const cls = grade === "good" ? "fly-right" : grade === "easy" ? "fly-up" : "fly-left";
  card.classList.add(cls);
  setTimeout(() => {
    card.classList.remove("fly-right", "fly-left", "fly-up");
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
});

card.addEventListener("pointerdown", (e) => {
  if (animating) return;
  startX = e.clientX;
  startY = e.clientY;
  dragging = true;
  didSwipe = false;
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

  if (ady > THRESH && ady > adx && dy < 0) {
    didSwipe = true;
    showFeedback("easy");
    flyOut("easy");
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

function addSubject(name) {
  db.ref("content/subjects").push({ name, order: Date.now(), createdAt: TS }).catch(writeError);
}
function renameSubject(sid, name) {
  db.ref(`content/subjects/${sid}/name`).set(name).catch(writeError);
}
function removeSubject(sid) {
  db.ref(`content/subjects/${sid}`).remove().catch(writeError);
}
function addLesson(sid, name) {
  db.ref(`content/subjects/${sid}/lessons`).push({ name, order: Date.now(), createdAt: TS }).catch(writeError);
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
    { label: "✎ Byt namn", value: "rename" },
    { label: "🗑 Ta bort ämne", value: "delete", danger: true },
  ]);
  if (action === "rename") {
    const name = await askName("Byt namn på ämne", s.name);
    if (name) renameSubject(sid, name);
  } else if (action === "delete") {
    const ok = await confirmDanger("Ta bort ämne?", `"${s.name}" och alla dess lektioner tas bort permanent.`);
    if (ok) { removeSubject(sid); renderSubjects(); }
  }
}

function openEditor(lessonId) {
  currentLessonId = lessonId;
  renderEditor();
}

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
  list.innerHTML = lesson.cards
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
  const name = await askName("Nytt ämne", "");
  if (name) addSubject(name);
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
//  PWA + start
// =========================================================================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

boot();
