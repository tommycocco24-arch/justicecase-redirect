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

  // Practice mode: write the holding and rule first, then reveal and compare. Answers stay in this browser.
  const key = (field) => `jc-practice-${caseId}-${field}`;
  $("my-holding").value = store.get(key("holding")) || "";
  $("my-rule").value = store.get(key("rule")) || "";
  $("my-holding").addEventListener("input", () => store.set(key("holding"), $("my-holding").value));
  $("my-rule").addEventListener("input", () => store.set(key("rule"), $("my-rule").value));
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

  // Opinion viewer: loads on first use; quotes highlight by their exact position in the checked text.
  let opinion = null;
  const box = $("source-text");
  async function loadOpinion() {
    if (opinion !== null) return opinion;
    try {
      const res = await fetch(box.dataset.src);
      if (!res.ok) throw new Error();
      opinion = await res.text();
      box.replaceChildren(opinion);
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
      const mark = document.createElement("mark");
      mark.textContent = text.slice(start, end);
      box.replaceChildren(text.slice(0, start), mark, text.slice(end));
      requestAnimationFrame(() => mark.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
    });
  }
})();
