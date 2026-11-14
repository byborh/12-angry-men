// Every value from the report can come from a file on disk, so the page builds nodes with textContent, never innerHTML.

const SVG_NS = "http://www.w3.org/2000/svg";
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("en");
const dateFmt = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function tile(value, label) {
  return h("div", { class: "tile" }, h("b", { text: value }), h("span", { text: label }));
}

function relative(t) {
  if (t === null) return "never";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days === 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const box = h("div", { class: "bars" });
  for (const r of rows) {
    const fill = h("div", { class: "fill" });
    fill.style.width = `${(r.value / max) * 100}%`;
    box.append(h("div", { class: "label", title: r.label, text: r.label }), h("div", { class: "track" }, fill), h("div", { class: "val", text: plain.format(r.value) }));
  }
  return h("div", { class: "card" }, box);
}

function table(headers, rows) {
  const head = h("tr", {}, ...headers.map(([label, cls]) => h("th", { class: cls ?? "", text: label })));
  return h("div", { class: "card" }, h("table", {}, h("thead", {}, head), h("tbody", {}, ...rows)));
}

// ---------- Skills tab ----------

function skillRow(s) {
  const desc = s.description.length > 140 ? `${s.description.slice(0, 140)}…` : s.description;
  return h(
    "tr",
    {},
    h("td", { class: "name", text: s.kind === "command" ? `/${s.id}` : s.id }),
    h("td", { text: s.source }),
    h("td", {}, h("span", { class: `pill ${s.status}`, text: s.status })),
    h("td", { class: "num", text: String(s.slash) }),
    h("td", { class: "num", text: String(s.auto) }),
    h("td", { class: "num", text: relative(s.lastUsed) }),
    h("td", { class: "num", title: "Prompts that match a trigger phrase without the skill running / all matching prompts", text: s.triggers ? `${s.triggers.missed} / ${s.triggers.matched}` : "—" }),
    h("td", { class: "num", text: `≈${s.listingTokens}` }),
    h("td", { class: "desc", text: desc }),
  );
}

function renderSkills(report) {
  const root = document.getElementById("skills");
  const skills = report.skills;
  const used = skills.filter((s) => s.status !== "unused");
  const unused = skills.filter((s) => s.status === "unused");
  // Project skills load only inside their repo, so they do not cost tokens in every session.
  const idleTokens = unused.filter((s) => s.source !== "project").reduce((n, s) => n + s.listingTokens, 0);

  root.append(
    h(
      "div",
      { class: "tiles" },
      tile(String(skills.length), "skills and commands installed"),
      tile(String(used.length), "used in this window"),
      tile(String(unused.length), "never used in this window"),
      tile(`≈${plain.format(idleTokens)}`, "tokens of unused listings, in every session"),
    ),
  );
  if (report.window) {
    const history = report.historyFrom ? ` Typed commands also come from history.jsonl since ${dateFmt.format(report.historyFrom)} (CLI prompts only).` : "";
    root.append(
      h("p", { class: "note", text: `Your transcripts cover ${report.window.days} days. Claude Code deletes old transcripts (setting cleanupPeriodDays), so "unused" means unused in this window only.${history}` }),
    );
  }

  const body = h("tbody");
  const filters = h("div", { class: "filters" });
  const sources = [...new Set(skills.map((s) => s.source))];
  const state = { status: "all", source: "all" };
  const draw = () => {
    body.replaceChildren(
      ...skills
        .filter((s) => state.status === "all" || (state.status === "used" ? s.status !== "unused" : s.status === "unused"))
        .filter((s) => state.source === "all" || s.source === state.source)
        .map(skillRow),
    );
    for (const b of filters.children) b.classList.toggle("on", state[b.dataset.key] === b.dataset.value);
  };
  const chip = (key, value, label) => h("button", { "data-key": key, "data-value": value, text: label, onclick: () => ((state[key] = value), draw()) });
  filters.append(
    chip("status", "all", "All"),
    chip("status", "used", `Used (${used.length})`),
    chip("status", "unused", `Unused (${unused.length})`),
    ...sources.map((src) => chip("source", src, src)),
    chip("source", "all", "All sources"),
  );

  const head = h(
    "tr",
    {},
    ...[["Skill"], ["Source"], ["Status"], ["Typed", "num"], ["Auto", "num"], ["Last used", "num"], ["Missed", "num"], ["Listing", "num"], ["Description"]].map(([l, c]) => h("th", { class: c ?? "", text: l })),
  );
  root.append(h("h2", { text: "Your skills" }), filters, h("div", { class: "card" }, h("table", {}, h("thead", {}, head), body)));
  draw();

  renderMisses(root, skills);

  if (report.otherInvocations.length > 0) {
    root.append(
      h("h2", { text: "Invoked, but not found on disk" }),
      h("p", { class: "muted", text: "Built-in commands, deleted skills, or skills that live in the cloud." }),
      table(
        [["Name"], ["Typed", "num"], ["Auto", "num"]],
        report.otherInvocations.map((o) => h("tr", {}, h("td", { class: "name", text: o.name }), h("td", { class: "num", text: String(o.slash) }), h("td", { class: "num", text: String(o.auto) }))),
      ),
    );
  }
}

function missCard(s) {
  const examples = s.triggers.examples.map((m) =>
    h("li", {}, h("span", { class: "muted", text: `${dateFmt.format(m.at)} · ${m.project} — ` }), document.createTextNode(m.excerpt)),
  );
  return h(
    "div",
    { class: "card miss" },
    h("p", {}, h("b", { class: "mono", text: s.id }), document.createTextNode(` — ${s.triggers.missed} of ${s.triggers.matched} matching prompts ran without it.`)),
    h("p", { class: "muted", text: `Trigger phrases: ${s.triggers.phrases.map((p) => `"${p}"`).join(", ")}` }),
    h("ul", {}, ...examples),
  );
}

function renderMisses(root, skills) {
  const withPhrases = skills.filter((s) => s.triggers);
  const missed = withPhrases.filter((s) => s.triggers.missed > 0).sort((a, b) => b.triggers.missed - a.triggers.missed);
  const silent = withPhrases.filter((s) => s.triggers.matched === 0 && s.status === "unused");
  root.append(
    h("h2", { text: "Missed triggers" }),
    h("p", { class: "muted", text: "The page reads the quoted phrases in each skill description. A prompt that matches one, without the skill running before your next prompt, is a miss." }),
  );
  if (missed.length === 0) root.append(h("p", { text: "No miss found." }));
  for (const s of missed) root.append(missCard(s));
  if (silent.length === 0) return;
  root.append(
    h("p", { class: "note", text: `${silent.length} unused skills have trigger phrases that never appear in your prompts: ${silent.map((s) => s.id).join(", ")}. You do not ask for this work, so you may not need these skills.` }),
  );
}

// ---------- Activity tab ----------

function dailyChart(daily) {
  const W = 1000;
  const H = 160;
  const pad = 22;
  const max = Math.max(1, ...daily.map((d) => d.prompts));
  const step = W / Math.max(1, daily.length);
  const chart = svg("svg", { class: "daily", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": "Prompts per day" });
  daily.forEach((d, i) => {
    const bh = ((H - pad) * d.prompts) / max;
    const rect = svg("rect", { x: i * step + step * 0.15, y: H - pad - bh, width: step * 0.7, height: Math.max(bh, d.prompts > 0 ? 1 : 0), rx: 2 });
    const tip = svg("title");
    tip.textContent = `${d.day}: ${d.prompts} prompts`;
    rect.append(tip);
    chart.append(rect);
  });
  const labelEvery = Math.ceil(daily.length / 8);
  daily.forEach((d, i) => {
    if (i % labelEvery !== 0) return;
    const t = svg("text", { x: i * step + step / 2, y: H - 6, "text-anchor": "middle" });
    t.textContent = d.day.slice(5);
    chart.append(t);
  });
  return h("div", { class: "card" }, chart);
}

function heatmap(grid) {
  const max = Math.max(1, ...grid.flat());
  const box = h("div", { class: "heat" }, h("div", { class: "lbl" }));
  for (let hr = 0; hr < 24; hr++) box.append(h("div", { class: "hr", text: hr % 3 === 0 ? String(hr) : "" }));
  grid.forEach((row, d) => {
    box.append(h("div", { class: "lbl", text: DAYS[d] }));
    for (let hr = 0; hr < 24; hr++) {
      const cell = h("div", { title: `${DAYS[d]} ${hr}:00 — ${row[hr]} prompts` });
      const a = row[hr] === 0 ? 0.06 : 0.15 + 0.85 * (row[hr] / max);
      cell.style.background = `rgba(var(--heat), ${a})`;
      box.append(cell);
    }
  });
  return h("div", { class: "card" }, box);
}

function renderActivity(report) {
  const root = document.getElementById("activity");
  const t = report.totals;
  const correctionRate = t.humanPrompts === 0 ? 0 : Math.round((t.corrections / t.humanPrompts) * 100);
  root.append(
    h(
      "div",
      { class: "tiles" },
      tile(plain.format(t.humanPrompts), "prompts you typed"),
      tile(plain.format(t.sessions), `sessions (+${t.automatedSessions} automated, ${t.subagentRuns} subagent runs)`),
      tile(`${t.activeHours} h`, "active time (gaps over 15 min excluded)"),
      tile(`${correctionRate}%`, `prompts that correct Claude (${t.corrections})`),
      tile(compact.format(t.output), "output tokens"),
      tile(compact.format(t.cacheRead + t.cacheWrite + t.input), "input tokens, cache included"),
    ),
    h("h2", { text: "Prompts per day" }),
    dailyChart(report.daily),
    h("h2", { text: "When you work" }),
    heatmap(report.heatmap),
    h(
      "div",
      { class: "grid2" },
      h("div", {}, h("h2", { text: "Projects (by prompts)" }), bars(report.projects.map((p) => ({ label: p.name, value: p.prompts })))),
      h("div", {}, h("h2", { text: "Tools Claude called" }), bars(report.tools.map((x) => ({ label: x.name, value: x.count })))),
    ),
    h("h2", { text: "Models" }),
    table(
      [["Model"], ["Messages", "num"], ["Output", "num"], ["Cache read", "num"], ["Cache write", "num"]],
      report.models.map((m) =>
        h(
          "tr",
          {},
          h("td", { class: "name", text: m.name }),
          h("td", { class: "num", text: plain.format(m.messages) }),
          h("td", { class: "num", text: compact.format(m.output) }),
          h("td", { class: "num", text: compact.format(m.cacheRead) }),
          h("td", { class: "num", text: compact.format(m.cacheWrite) }),
        ),
      ),
    ),
  );
}

// ---------- Shell ----------

function renderWarnings(warnings) {
  if (warnings.length === 0) return;
  const root = document.getElementById("warnings");
  root.hidden = false;
  root.append(h("h2", { text: `${warnings.length} problem(s) while reading` }), h("ul", {}, ...warnings.map((w) => h("li", { text: w }))));
}

function showTab(name) {
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const tab of document.querySelectorAll(".tab")) tab.hidden = tab.id !== name;
}

// The tab lives in the URL hash, so a link or a reload keeps it.
function setupTabs() {
  for (const b of document.querySelectorAll("nav button")) b.addEventListener("click", () => (location.hash = b.dataset.tab));
  const fromHash = () => showTab(location.hash === "#activity" ? "activity" : "skills");
  window.addEventListener("hashchange", fromHash);
  fromHash();
}

async function main() {
  setupTabs();
  const info = document.getElementById("window");
  const res = await fetch("/api/report");
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const report = await res.json();
  info.textContent = report.window
    ? `${report.claudeDir} · ${dateFmt.format(report.window.from)} → ${dateFmt.format(report.window.to)} · ${report.window.days} days`
    : `${report.claudeDir} · no transcripts found`;
  renderSkills(report);
  renderActivity(report);
  renderWarnings(report.warnings);
}

main().catch((e) => {
  const info = document.getElementById("window");
  info.textContent = `Could not build the report: ${e.message}`;
  info.style.color = "var(--unused)";
});
