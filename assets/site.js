"use strict";
// Justice Case site script: theme, library search, quiz mode, practice mode, fact-check filters, opinion viewer.
// Everything runs in the browser; nothing is sent anywhere. Saved state (theme, quiz, practice answers) stays in localStorage.

(function () {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked: fine */ } },
  };
  const COPY_RESET_MS = 1600;

  /* ---------- theme ---------- */
  const theme = store.get("jc-theme");
  if (theme) document.documentElement.dataset.theme = theme;
  $("theme").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    const dark = current ? current === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("jc-theme", next);
  });

  async function copyText(text, button, label) {
    try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
    catch { button.textContent = "Couldn't copy"; }
    setTimeout(() => { button.textContent = label; }, COPY_RESET_MS);
  }


  /* ---------- casebook store: saved cases, notes, practice answers ---------- */
  // Kept in this browser; when signed in, also synced to the student's account (see account.js).
  const CASEBOOK_KEY = "jc-casebook";
  const EMPTY = () => ({ saved: false, note: "", holding: "", rule: "", marks: [], updated: 0 });
  let book = {};
  try { book = JSON.parse(store.get(CASEBOOK_KEY) || "{}") || {}; } catch { book = {}; }
  // One-time move of practice answers saved before the casebook existed.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i), m = /^jc-practice-(.+)-(holding|rule)$/.exec(k || "");
      if (!m) continue;
      book[m[1]] = { ...EMPTY(), ...book[m[1]], [m[2]]: localStorage.getItem(k) || "", updated: Date.now() };
      localStorage.removeItem(k);
    }
  } catch { /* storage blocked */ }
  const persist = () => store.set(CASEBOOK_KEY, JSON.stringify(book));
  persist();
  let account = null;
  const pending = {};
  const casebook = {
    get: (id) => { const rec = { ...EMPTY(), ...book[id] }; rec.marks = Array.isArray(rec.marks) ? rec.marks.map((m) => ({ ...m })) : []; return rec; },
    all: () => JSON.parse(JSON.stringify(book)),
    set(id, patch) {
      book[id] = { ...EMPTY(), ...book[id], ...patch, updated: Date.now() };
      persist();
      if (account) {  // debounce typing; one write per pause
        clearTimeout(pending[id]);
        pending[id] = setTimeout(() => account.push(id, casebook.get(id)), 1200);
      }
    },
    applyRemote(id, rec) { book[id] = { ...EMPTY(), ...rec }; persist(); document.dispatchEvent(new CustomEvent("jc-remote", { detail: id })); },
    clear() { book = {}; persist(); },
  };

  /* ---------- accounts (optional): loaded only when used ---------- */
  const scriptUrl = document.currentScript && document.currentScript.src;
  let firebaseConfig = null;
  try { firebaseConfig = JSON.parse(document.body.dataset.firebase || "null"); } catch { firebaseConfig = null; }
  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  const accountHooks = {
    user(u) {
      store.set("jc-signed-in", u ? "1" : "");
      document.body.classList.toggle("signed-in", Boolean(u));
      setText("account-email", u ? (u.email || u.name) : "");
      setText("nav-account", u ? "My casebook" : "Sign in");
      document.dispatchEvent(new CustomEvent("jc-user", { detail: u }));
    },
    status: (text) => setText("sync-status", text),
    error: (text) => { setText("account-error", text); const el = $("account-error"); if (el) el.hidden = !text; },
    localAll: () => casebook.all(),
    applyRemote: (id, rec) => casebook.applyRemote(id, rec),
  };
  let loading = null;
  function loadAccount() {
    if (!firebaseConfig || !scriptUrl) return Promise.resolve(null);
    loading = loading || import(new URL("account.js", scriptUrl).href)
      .then((mod) => mod.start(firebaseConfig, accountHooks))
      .then((a) => (account = a))
      .catch(() => { accountHooks.error("Sign-in couldn't load. Check your connection and reload."); return null; });
    return loading;
  }
  if (firebaseConfig) {
    document.body.classList.add("accounts-on");
    // Returning students (or an email sign-in link) load the account code right away; everyone else only on demand.
    if (store.get("jc-signed-in") === "1" || /[?&]oobCode=/.test(location.search)) loadAccount();
  }

  /* ---------- home: search and course filter ---------- */
  const search = $("search");
  if (search) {
    let course = "";
    const apply = () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const block of document.querySelectorAll(".course-block")) {
        let inBlock = 0;
        for (const row of block.querySelectorAll(".case-row")) {
          const ok = (!course || row.dataset.course === course) && (!q || row.dataset.name.includes(q));
          row.hidden = !ok;
          if (ok) inBlock++;
        }
        block.hidden = inBlock === 0;
        shown += inBlock;
      }
      $("empty-search").hidden = shown > 0;
    };
    search.addEventListener("input", apply);
    for (const chip of document.querySelectorAll(".course-chip")) {
      chip.addEventListener("click", () => {
        course = chip.dataset.course;
        for (const c of document.querySelectorAll(".course-chip")) c.setAttribute("aria-pressed", String(c === chip));
        apply();
      });
    }
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); search.focus(); }
    });
  }


  /* ---------- account controls (casebook page) ---------- */
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  on("signin-google", async () => { const a = await loadAccount(); if (a) await a.google(); });
  const emailForm = $("signin-email-form");
  if (emailForm) emailForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("signin-email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { accountHooks.error("Enter a valid email address."); return; }
    const a = await loadAccount();
    if (!a) return;
    try { await a.emailLink(email); accountHooks.error(""); setText("signin-sent", `Check ${email} for a sign-in link. It works once, on this device or another.`); $("signin-sent").hidden = false; }
    catch { accountHooks.error("Couldn't send the link. Check the address and try again."); }
  });
  on("signout", async () => {
    const a = await loadAccount();
    if (!a) return;
    await a.signOut();
    casebook.clear();  // a shared or library computer shouldn't keep the last student's notes
    location.reload();
  });
  const download = (name, type, text) => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  on("download-data", async () => {
    const a = await loadAccount();
    const data = { exported: new Date().toISOString(), this_device: casebook.all(), account: a ? await a.exportAll() : {} };
    download("justice-case-my-data.json", "application/json", JSON.stringify(data, null, 2));
  });
  let deleteArmed = 0;
  on("delete-account", async () => {
    const btn = $("delete-account");
    if (Date.now() - deleteArmed > 4000) { deleteArmed = Date.now(); btn.textContent = "Click again to permanently delete"; return; }
    btn.disabled = true; btn.textContent = "Deleting…";
    try {
      const a = await loadAccount();
      await a.deleteAccount();
      casebook.clear();
      store.set("jc-signed-in", "");
      location.reload();
    } catch (err) {
      accountHooks.error(err.message || "Couldn't delete the account. Try again.");
      btn.disabled = false; btn.textContent = "Delete my account and data";
    }
  });

  /* ---------- casebook page ---------- */
  const list = $("casebook-list");
  if (list) {
    let cases = [];
    const plain = (s) => (s || "").trim();
    const inBook = (c) => { const r = casebook.get(c.id); return r.saved || r.note || r.marks.length > 0; };
    const LABELS = { facts: "Facts", issue: "Issue", rule: "Rule", holding: "Holding", reasoning: "Reasoning", dissent: "Dissent / concurrence", note: "Notes" };
    const render = () => {
      const saved = cases.filter(inBook);
      $("casebook-empty").hidden = saved.length > 0;
      $("export-md").disabled = saved.length === 0;
      const courses = [...new Set(saved.map((c) => c.course))].sort();
      list.replaceChildren(...courses.map((course) => {
        const block = document.createElement("section"); block.className = "course-block";
        const h = document.createElement("h2"); h.textContent = course;
        const ul = document.createElement("ul"); ul.className = "case-list";
        for (const c of saved.filter((x) => x.course === course).sort((a, b) => a.case_name.localeCompare(b.case_name))) {
          const rec = casebook.get(c.id);
          const li = document.createElement("li");
          const a = document.createElement("a"); a.href = `../cases/${c.id}/`;
          const name = document.createElement("span"); name.className = "r-name"; name.textContent = c.case_name;
          const meta = document.createElement("span"); meta.className = "r-meta"; meta.textContent = [c.citation, rec.marks.length ? `${rec.marks.length} highlight${rec.marks.length === 1 ? "" : "s"}` : "", rec.saved ? "" : "not starred"].filter(Boolean).join(" · ");
          a.append(name, meta);
          if (rec.note) { const n = document.createElement("span"); n.className = "r-note"; n.textContent = rec.note.length > 160 ? rec.note.slice(0, 160) + "…" : rec.note; a.append(n); }
          li.append(a); ul.append(li);
        }
        block.append(h, ul); return block;
      }));
    };
    on("export-md", () => {
      const saved = cases.filter(inBook);
      const parts = ["# My casebook", "", `Exported from justicecase.ai on ${new Date().toLocaleDateString()}. Study aid, not legal advice.`, ""];
      for (const course of [...new Set(saved.map((c) => c.course))].sort()) {
        parts.push(`## ${course}`, "");
        for (const c of saved.filter((x) => x.course === course).sort((a, b) => a.case_name.localeCompare(b.case_name))) {
          const rec = casebook.get(c.id);
          parts.push(`### *${c.case_name}*, ${c.citation}`, "");
          if (c.rule) parts.push(`**Rule:** ${c.rule}`, "");
          if (c.holding) parts.push(`**Holding:** ${c.holding}`, "");
          if (plain(rec.rule)) parts.push(`**My rule:** ${plain(rec.rule)}`, "");
          if (plain(rec.holding)) parts.push(`**My holding:** ${plain(rec.holding)}`, "");
          if (plain(rec.note)) parts.push(`**My notes:**`, "", plain(rec.note), "");
          if (rec.marks.length) {
            parts.push("**My highlights (book brief):**", "");
            for (const color of Object.keys(LABELS)) {
              const marks = rec.marks.filter((m) => m.color === color).sort((a, b) => a.start - b.start);
              if (!marks.length) continue;
              parts.push(`*${LABELS[color]}*`, "");
              for (const m of marks) parts.push(`> ${plain(m.text).replace(/\s+/g, " ")}`, ...(plain(m.note) ? ["", `  - ${plain(m.note)}`] : []), "");
            }
          }
          parts.push(`Brief: ${location.origin}/cases/${c.id}/`, "");
        }
      }
      download("my-casebook.md", "text/markdown", parts.join("\n"));
    });
    fetch(list.dataset.src).then((r) => r.json()).then((data) => { cases = data; render(); })
      .catch(() => { $("casebook-empty").textContent = "Couldn't load the case list. Reload the page to try again."; $("casebook-empty").hidden = false; });
    document.addEventListener("jc-remote", render);
  }

  /* ---------- case page ---------- */
  const casePage = document.querySelector(".case");
  if (!casePage) return;
  const caseId = casePage.dataset.case;
  const cards = $("cards");

  // Quiz mode
  let quiz = store.get("jc-quiz") === "on";
  const applyQuiz = () => {
    $("quiz").setAttribute("aria-checked", String(quiz));
    cards.classList.toggle("quiz-on", quiz);
    document.body.classList.toggle("quizzing", quiz);
    if (quiz) for (const card of cards.querySelectorAll(".quizzable")) card.classList.remove("revealed");
  };
  $("quiz").addEventListener("click", () => { quiz = !quiz; store.set("jc-quiz", quiz ? "on" : "off"); applyQuiz(); });
  for (const button of cards.querySelectorAll(".reveal")) button.addEventListener("click", () => button.closest(".card").classList.add("revealed"));
  applyQuiz();

  // Copy
  const cardText = (card) => card.querySelector(".card-title").textContent.toUpperCase() + "\n" + card.querySelector(".card-body").innerText.trim();
  $("copy-brief").addEventListener("click", () => {
    const text = document.querySelector(".doc-title").textContent + "\n" + document.querySelector(".doc-meta .mono").textContent + "\n\n"
      + [...cards.querySelectorAll(".card")].map(cardText).join("\n\n");
    copyText(text, $("copy-brief"), "Copy brief");
  });
  for (const button of cards.querySelectorAll(".copy-rule")) {
    button.addEventListener("click", () => copyText(button.closest(".card").querySelector(".card-body").innerText.trim(), button, "Copy rule"));
  }

  // Practice mode: write the holding and rule first, then reveal and compare. Answers are kept in the casebook store.
  $("my-holding").value = casebook.get(caseId).holding;
  $("my-rule").value = casebook.get(caseId).rule;
  $("my-holding").addEventListener("input", () => casebook.set(caseId, { holding: $("my-holding").value }));
  $("my-rule").addEventListener("input", () => casebook.set(caseId, { rule: $("my-rule").value }));

  // Save to casebook, and private notes.
  const saveBtn = $("save-case");
  const showSaved = () => {
    const saved = casebook.get(caseId).saved;
    saveBtn.setAttribute("aria-pressed", String(saved));
    saveBtn.textContent = saved ? "★ In your casebook" : "☆ Save to casebook";
  };
  saveBtn.addEventListener("click", () => { casebook.set(caseId, { saved: !casebook.get(caseId).saved }); showSaved(); });
  $("my-notes").value = casebook.get(caseId).note;
  $("my-notes").addEventListener("input", () => casebook.set(caseId, { note: $("my-notes").value }));
  document.addEventListener("jc-remote", (ev) => {
    if (ev.detail !== caseId) return;
    const rec = casebook.get(caseId);
    for (const [field, box] of [["holding", "my-holding"], ["rule", "my-rule"], ["note", "my-notes"]]) if (document.activeElement !== $(box)) $(box).value = rec[field];
    showSaved();
  });
  showSaved();
  $("practice-start").addEventListener("click", () => {
    $("practice").hidden = false;
    document.body.classList.add("practicing");
    $("mine").hidden = true;
    $("my-holding").focus();
  });
  const endPractice = () => { $("practice").hidden = true; document.body.classList.remove("practicing"); };
  $("practice-cancel").addEventListener("click", endPractice);
  $("practice-reveal").addEventListener("click", () => {
    const entries = [["Your holding", $("my-holding").value.trim()], ["Your rule", $("my-rule").value.trim()]].filter(([, v]) => v);
    const body = $("mine-body");
    body.replaceChildren(...entries.flatMap(([label, value]) => {
      const l = document.createElement("div"); l.className = "mine-label"; l.textContent = label;
      const p = document.createElement("p"); p.className = "mine-entry"; p.textContent = value;
      return [l, p];
    }));
    $("mine").hidden = entries.length === 0;
    endPractice();
    quiz = false; applyQuiz();
    const rule = cards.querySelector(".card-rule");
    (rule || cards).scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });

  // Tabs
  const showTab = (name) => {
    for (const t of ["check", "source"]) { $("tab-" + t).setAttribute("aria-selected", String(t === name)); $("panel-" + t).hidden = t !== name; }
    if (name === "source") loadOpinion();
  };
  $("tab-check").addEventListener("click", () => showTab("check"));
  $("tab-source").addEventListener("click", () => showTab("source"));

  // Fact-check filters
  const filters = $("filters");
  const applyFilter = (filter) => {
    for (const b of filters.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.filter === filter));
    for (const li of document.querySelectorAll("#claims .claim")) {
      const supported = li.dataset.outcome === "supported";
      li.hidden = filter === "review" ? supported : filter === "supported" ? !supported : false;
    }
  };
  for (const b of filters.querySelectorAll("button")) b.addEventListener("click", () => applyFilter(b.dataset.filter));
  applyFilter("all");
  const showChecks = $("show-checks");
  if (showChecks) showChecks.addEventListener("click", () => { showTab("check"); $("panel-check").scrollIntoView({ block: "start" }); });

  // Opinion viewer and book-brief highlighting. Highlights are character positions in the exact opinion text
  // (plus the passage itself, to re-anchor if the text ever shifts), kept in the casebook record.
  let opinion = null;
  let jump = null;  // a fact-check quote being shown
  const box = $("source-text");
  const MAX_MARKS = 400, MAX_NOTE = 1000, MAX_TEXT = 2000;
  const marks = () => casebook.get(caseId).marks;
  const saveMarks = (list) => { casebook.set(caseId, { marks: list }); renderOpinion(); };

  function anchored(list) {
    // Keep each highlight on its passage; move it if the text shifted; drop it from view if the passage is gone.
    return list.map((m) => {
      if (opinion.slice(m.start, m.end) === m.text) return m;
      const at = m.text ? opinion.indexOf(m.text) : -1;
      return at >= 0 ? { ...m, start: at, end: at + m.text.length } : null;
    }).filter(Boolean);
  }
  function renderOpinion() {
    if (!opinion) return;
    const list = anchored(marks());
    const cuts = new Set([0, opinion.length]);
    for (const m of list) { cuts.add(m.start); cuts.add(m.end); }
    if (jump) { cuts.add(jump[0]); cuts.add(jump[1]); }
    const points = [...cuts].sort((a, b) => a - b);
    const nodes = [];
    for (let i = 0; i < points.length - 1; i++) {
      const s = points[i], e = points[i + 1], text = opinion.slice(s, e);
      const top = list.filter((m) => m.start <= s && m.end >= e).pop();  // latest highlight wins where they overlap
      const isJump = jump && jump[0] <= s && jump[1] >= e;
      if (!top && !isJump) { nodes.push(text); continue; }
      const mark = document.createElement("mark");
      mark.textContent = text;
      if (top) { mark.className = `hl hl-${top.color}${top.note ? " has-note" : ""}`; mark.dataset.id = top.id; if (top.note) mark.title = top.note; }
      if (isJump) mark.classList.add("jump");
      nodes.push(mark);
    }
    box.replaceChildren(...nodes);
    const n = list.length;
    $("hl-count").textContent = n ? `${n} highlight${n === 1 ? "" : "s"}` : "";
  }
  async function loadOpinion() {
    if (opinion !== null) return opinion;
    try {
      const res = await fetch(box.dataset.src);
      if (!res.ok) throw new Error();
      opinion = await res.text();
      renderOpinion();
    } catch {
      opinion = "";
      box.replaceChildren(Object.assign(document.createElement("p"), { className: "panel-empty", textContent: "The opinion couldn't be loaded. Reload the page to try again." }));
    }
    return opinion;
  }
  for (const button of document.querySelectorAll(".quote-btn[data-start]")) {
    button.addEventListener("click", async () => {
      showTab("source");
      const text = await loadOpinion();
      const start = Number(button.dataset.start), end = Number(button.dataset.end);
      if (!text || !(end > start) || end > text.length) return;
      jump = [start, end];
      renderOpinion();
      const mark = box.querySelector("mark.jump");
      if (mark) requestAnimationFrame(() => mark.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
    });
  }

  // Full-width reading mode.
  const setReading = (on) => {
    document.body.classList.toggle("reading", on);
    $("read-toggle").textContent = on ? "← Back to the brief" : "Read full width";
    if (on) { showTab("source"); window.scrollTo({ top: 0 }); }
  };
  $("read-start").addEventListener("click", () => setReading(true));
  $("read-toggle").addEventListener("click", () => setReading(!document.body.classList.contains("reading")));
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { hidePalette(); closePop(); } });

  // Selecting text shows the palette; picking a color saves the highlight.
  const palette = $("hl-palette"), pop = $("hl-pop");
  function offsetIn(node, offset) {
    // Character offset of a DOM position within the opinion box (its text is exactly the opinion).
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let total = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n === node) return total + offset;
      total += n.textContent.length;
    }
    if (node === box) return [...box.childNodes].slice(0, offset).reduce((sum, c) => sum + c.textContent.length, 0);
    return -1;
  }
  let pendingRange = null;
  function hidePalette() { palette.hidden = true; pendingRange = null; }
  function placeNear(el, rect) {
    el.hidden = false;
    if (matchMedia("(max-width: 640px)").matches) { el.style.left = ""; el.style.top = ""; el.classList.add("docked"); return; }
    el.classList.remove("docked");
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2))}px`;
    el.style.top = `${rect.top - h - 10 < 8 ? rect.bottom + 10 : rect.top - h - 10}px`;
  }
  function checkSelection() {
    const sel = getSelection();
    if (!opinion || !sel.rangeCount || sel.isCollapsed) { hidePalette(); return; }
    const range = sel.getRangeAt(0);
    if (!box.contains(range.commonAncestorContainer)) { hidePalette(); return; }
    let start = offsetIn(range.startContainer, range.startOffset), end = offsetIn(range.endContainer, range.endOffset);
    if (start < 0 || end < 0) { hidePalette(); return; }
    if (start > end) [start, end] = [end, start];
    while (start < end && /\s/.test(opinion[start])) start++;  // trim whitespace the drag picked up
    while (end > start && /\s/.test(opinion[end - 1])) end--;
    const word = /[\p{L}\p{N}'’-]/u;  // snap to whole words, like an e-reader
    while (start > 0 && word.test(opinion[start - 1]) && word.test(opinion[start])) start--;
    while (end < opinion.length && word.test(opinion[end]) && word.test(opinion[end - 1])) end++;
    if (end - start < 2) { hidePalette(); return; }
    pendingRange = [start, end];
    closePop();
    placeNear(palette, range.getBoundingClientRect());
  }
  let selTimer = 0;
  document.addEventListener("selectionchange", () => { clearTimeout(selTimer); selTimer = setTimeout(checkSelection, 250); });
  palette.addEventListener("mousedown", (ev) => ev.preventDefault());  // keep the selection while clicking a color
  palette.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-color]");
    if (!btn || !pendingRange) return;
    const list = marks();
    if (list.length >= MAX_MARKS) { $("hl-count").textContent = `Limit of ${MAX_MARKS} highlights on one case reached`; hidePalette(); return; }
    const [start, end] = pendingRange;
    const mark = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), start, end, color: btn.dataset.color, text: opinion.slice(start, end).slice(0, MAX_TEXT), note: "" };
    if (mark.text.length < end - start) mark.end = start + mark.text.length;
    getSelection().removeAllRanges();
    hidePalette();
    saveMarks([...list, mark]);
    if (mark.color === "note") openPop(mark.id);
  });

  // Clicking a highlight opens its editor: recolor, add a note, or remove it.
  let editing = null;
  function closePop() {
    if (!editing) { pop.hidden = true; return; }
    const note = $("hl-note").value.trim().slice(0, MAX_NOTE);
    const list = marks(), m = list.find((x) => x.id === editing);
    editing = null;
    pop.hidden = true;
    if (m && m.note !== note) { m.note = note; saveMarks(list); }
  }
  function openPop(id) {
    const m = marks().find((x) => x.id === id);
    const el = box.querySelector(`mark[data-id="${CSS.escape(id)}"]`);
    if (!m || !el) return;
    closePop();
    editing = id;
    $("hl-note").value = m.note || "";
    for (const b of pop.querySelectorAll("[data-color]")) b.setAttribute("aria-pressed", String(b.dataset.color === m.color));
    placeNear(pop, el.getBoundingClientRect());
    $("hl-note").focus({ preventScroll: true });
  }
  box.addEventListener("click", (ev) => {
    const el = ev.target.closest("mark.hl");
    if (el && getSelection().isCollapsed) openPop(el.dataset.id);
  });
  pop.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-color]");
    if (!btn || !editing) return;
    const list = marks(), m = list.find((x) => x.id === editing);
    if (m) { m.color = btn.dataset.color; m.note = $("hl-note").value.trim().slice(0, MAX_NOTE); saveMarks(list); }
    const id = editing; editing = null; openPop(id);
  });
  $("hl-done").addEventListener("click", closePop);
  $("hl-remove").addEventListener("click", () => {
    const id = editing; editing = null; pop.hidden = true;
    saveMarks(marks().filter((x) => x.id !== id));
  });
  document.addEventListener("mousedown", (ev) => { if (!pop.hidden && !pop.contains(ev.target) && !ev.target.closest("mark.hl")) closePop(); });
  document.addEventListener("jc-remote", (ev) => { if (ev.detail === caseId && !editing) renderOpinion(); });
})();
