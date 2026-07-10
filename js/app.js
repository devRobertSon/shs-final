// app.js — 학생/학부모/선생님(열람) 포털 컨트롤러
import {
  loadMeta,
  loginPortal,
  loadMaterial,
  sortWeeks,
  sortQuizzes,
  weekLabelOf,
  currentWeek,
  homeworkShareText,
  formatBytes,
  ATTENDANCE,
} from "./store.js";
import { $, el, clear, toast, copyText, tabBar, setBusy, spinner } from "./ui.js";
import { renderScoreChart, renderHistogram } from "./chart.js";

// 자동 로그인 체크 → localStorage (탭을 닫아도 유지, 로그아웃 전까지)
// 미체크 → sessionStorage (새로고침에는 유지, 탭을 닫으면 자동 해제)
const REMEMBER_KEY = "shs.code";
const app = $("#app");

function savedCode() {
  return localStorage.getItem(REMEMBER_KEY) || sessionStorage.getItem(REMEMBER_KEY);
}
function storeCode(code, remember) {
  if (remember) {
    localStorage.setItem(REMEMBER_KEY, code);
    sessionStorage.removeItem(REMEMBER_KEY);
  } else {
    sessionStorage.setItem(REMEMBER_KEY, code);
    localStorage.removeItem(REMEMBER_KEY);
  }
}
function clearCode() {
  localStorage.removeItem(REMEMBER_KEY);
  sessionStorage.removeItem(REMEMBER_KEY);
}

let session = null; // { student, academy, academyKey }
let meta = null;
const blobURLs = [];

init();

async function init() {
  try {
    meta = await loadMeta();
  } catch {
    clear(app).appendChild(
      el("div", { class: "login-wrap" }, [
        el("div", { class: "login-card" }, [
          el("h1", { text: "과학고 대비 학습 포털" }),
          el("p", {
            class: "login-sub",
            text: "아직 데이터가 없습니다. 선생님이 관리 페이지(admin.html)에서 초기 설정을 완료하면 이용할 수 있습니다.",
          }),
        ]),
      ])
    );
    return;
  }
  document.title = meta.site?.title || document.title;

  const saved = savedCode();
  if (saved) {
    const ok = await tryLogin(saved, true);
    if (ok) return;
    clearCode();
  }
  renderLogin();
}

function renderLogin(errorMsg) {
  const codeInput = el("input", {
    type: "text",
    class: "code-input",
    placeholder: "XXXXX-XXXXX",
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    maxlength: "12",
  });
  // 자동 대문자 + 5자 뒤 하이픈
  codeInput.addEventListener("input", () => {
    let v = codeInput.value.toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (v.length > 5) v = v.slice(0, 5) + "-" + v.slice(5, 10);
    codeInput.value = v;
  });

  const remember = el("input", { type: "checkbox" });
  const errBox = el("p", { class: "error-text", text: errorMsg || "" });
  const submitBtn = el("button", { class: "btn btn-primary btn-block", text: "입장하기" });

  const submit = async () => {
    const code = codeInput.value;
    if (code.replace(/[^0-9A-Z]/g, "").length < 10) {
      errBox.textContent = "코드 10자리를 모두 입력해 주세요.";
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "확인 중…";
    const ok = await tryLogin(code, false, remember.checked);
    if (!ok) {
      submitBtn.disabled = false;
      submitBtn.textContent = "입장하기";
      errBox.textContent = "코드를 다시 확인해 주세요.";
    }
  };
  submitBtn.addEventListener("click", submit);
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  clear(app).appendChild(
    el("div", { class: "login-wrap" }, [
      el("div", { class: "login-card" }, [
        el("h1", { text: meta.site?.title || "과학고 대비 학습 포털" }),
        el("p", { class: "login-sub", text: "안내받은 접속 코드를 입력해 주세요." }),
        el("label", { class: "field" }, [codeInput]),
        el("label", { class: "check" }, [remember, "이 기기에서 자동 로그인"]),
        el("p", {
          class: "hint",
          style: "text-align:left;margin-top:0",
          text: "학원·학교 등 공용 기기에서는 체크하지 마세요. 공용 기기를 쓴 뒤에는 꼭 [로그아웃]을 눌러 주세요.",
        }),
        errBox,
        submitBtn,
      ]),
    ])
  );
  codeInput.focus();
}

async function tryLogin(code, isAuto, remember = false) {
  if (isAuto) {
    clear(app).appendChild(
      el("div", { class: "login-wrap" }, [
        el("div", { class: "login-card" }, [spinner("자동 로그인 중…")]),
      ])
    );
  }
  try {
    session = await loginPortal(code, meta);
    if (!isAuto) storeCode(code, remember);
    if (session.kind === "teacher") renderTeacherDashboard();
    else renderDashboard();
    return true;
  } catch (e) {
    if (e.code !== "BAD_CODE") {
      console.error(e);
      if (!isAuto) toast("데이터를 불러오지 못했습니다. 네트워크를 확인해 주세요.", "error");
    }
    return false;
  }
}

function logout() {
  clearCode();
  for (const u of blobURLs.splice(0)) URL.revokeObjectURL(u);
  session = null;
  renderLogin();
}

// ---------- 대시보드 ----------

function renderDashboard() {
  const { student, academy } = session;
  const weeks = sortWeeks(academy.weeks);
  const cur = currentWeek(weeks);
  let selectedWeekId = cur ? cur.id : weeks.length ? weeks[weeks.length - 1].id : null;

  const root = el("div", { class: "container" });

  root.appendChild(
    el("div", { class: "portal-header" }, [
      el("div", { class: "who" }, [
        el("div", { class: "name", text: `${student.name} 학생` }),
        el("div", { class: "academy", text: academy.name }),
      ]),
      el("button", { class: "btn btn-small", text: "로그아웃", onclick: logout }),
    ])
  );

  // 주차 선택
  const weekSelect = el("select", { "aria-label": "주차 선택" });
  for (const w of weeks) {
    weekSelect.appendChild(
      el("option", { value: w.id, text: w.label, selected: w.id === selectedWeekId })
    );
  }
  weekSelect.addEventListener("change", () => {
    selectedWeekId = weekSelect.value;
    renderTab(activeTab);
  });
  root.appendChild(el("div", { class: "week-select-row" }, [weekSelect]));

  const content = el("div", { id: "tab-content" });
  let activeTab = "hw";
  const renderTab = (id) => {
    activeTab = id;
    const w = weeks.find((x) => x.id === selectedWeekId) || null;
    clear(content);
    if (id === "hw") renderHomework(content, w);
    else if (id === "quiz") renderQuiz(content); // 단원별 — 주차 선택과 무관
    else if (id === "report") renderReport(content); // 단원별 — 주차 선택과 무관
    else if (id === "notice") renderNotices(content);
    else if (id === "material") renderMaterials(content, weeks);
    else if (id === "att") renderAttendance(content, w);
  };

  const tabs = tabBar(
    root,
    [
      { id: "hw", label: "숙제" },
      { id: "quiz", label: "퀴즈" },
      { id: "report", label: "리포트" },
      { id: "notice", label: "공지사항" },
      { id: "material", label: "자료실" },
      { id: "att", label: "출석·진도" },
    ],
    renderTab
  );
  root.appendChild(content);

  clear(app).appendChild(root);
  tabs.select("hw");
}

function weekData(weekId) {
  return (session.student.weeks || {})[weekId] || {};
}

// ---------- ① 숙제 ----------
function renderHomework(container, week) {
  const card = el("div", { class: "card" }, [el("h2", { text: "이번 주 숙제" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "등록된 주차가 없습니다." }));
    container.appendChild(card);
    return;
  }
  const items = week.homework || [];
  const status = weekData(week.id).homework || {};
  if (!items.length) {
    card.appendChild(el("p", { class: "empty", text: "이번 주에 등록된 숙제가 없습니다." }));
  } else {
    const doneCount = items.filter((it) => status[it.id]).length;
    card.appendChild(
      el("p", {
        class: "hw-progress",
        text: `완료 ${doneCount} / ${items.length} (선생님이 수업 시간에 확인 후 체크합니다)`,
      })
    );
    const ul = el("ul", { class: "hw-list" });
    for (const it of items) {
      const done = !!status[it.id];
      ul.appendChild(
        el("li", { class: done ? "hw-done" : "" }, [
          el("span", { class: `hw-mark ${done ? "done" : "todo"}`, text: done ? "✓" : "" }),
          el("span", { class: "hw-text", text: it.text }),
        ])
      );
    }
    card.appendChild(ul);
    card.appendChild(
      el("button", {
        class: "btn btn-block",
        text: "📋 숙제 목록 복사",
        onclick: () => copyText(homeworkShareText(session.academy.name, week)),
      })
    );
  }
  container.appendChild(card);
}

// ---------- ② 퀴즈 (단원별) ----------
function renderQuiz(container) {
  const { student, academy } = session;
  const quizzes = sortQuizzes(academy.quizzes, academy.weeks);
  const myScores = student.quizzes || {};
  const card = el("div", { class: "card" }, [el("h2", { text: "단원별 퀴즈" })]);
  if (!quizzes.length) {
    card.appendChild(el("p", { class: "empty", text: "아직 등록된 퀴즈가 없습니다." }));
    container.appendChild(card);
    return;
  }

  // 최근 응시 퀴즈 요약
  const taken = quizzes.filter((q) => myScores[q.id] != null);
  const latest = taken.length ? taken[taken.length - 1] : null;
  if (latest) {
    card.appendChild(
      el("p", {
        class: "hint",
        text: `최근 퀴즈 · ${latest.unit} (${shortLabel(weekLabelOf(academy.weeks, latest.weekId))})`,
      })
    );
    card.appendChild(
      el("div", { class: "stat-row" }, [
        statTile("내 점수", String(myScores[latest.id]), `만점 ${latest.max || 100}`),
        statTile("전체 평균", latest.stats?.avg != null ? String(latest.stats.avg) : "–", ""),
        statTile("응시 인원", latest.stats?.count != null ? `${latest.stats.count}명` : "–", ""),
      ])
    );
  }

  // 추이 그래프 (단원 응시 순)
  card.appendChild(el("h2", { text: "점수 추이" }));
  const chartBox = el("div");
  card.appendChild(chartBox);
  renderScoreChart(chartBox, {
    weeks: quizzes.map((q) => ({ id: q.id, label: q.unit })),
    mine: quizzes.map((q) => (myScores[q.id] != null ? myScores[q.id] : null)),
    avg: quizzes.map((q) => (q.stats?.avg != null ? q.stats.avg : null)),
    yMax: Math.max(100, ...quizzes.map((q) => q.max || 0)),
  });

  // 전체 목록 (최신 순)
  card.appendChild(el("h2", { text: "퀴즈 목록", style: "margin-top:16px" }));
  const tbl = el("table", { class: "grid" });
  tbl.appendChild(
    el("tr", {}, [
      el("th", { class: "name-cell", text: "단원" }),
      el("th", { text: "주차" }),
      el("th", { text: "내 점수" }),
      el("th", { text: "전체 평균" }),
    ])
  );
  for (const q of [...quizzes].reverse()) {
    tbl.appendChild(
      el("tr", {}, [
        el("td", { class: "name-cell", text: q.unit }),
        el("td", { text: shortLabel(weekLabelOf(academy.weeks, q.weekId)) }),
        el("td", { class: "num", text: myScores[q.id] != null ? `${myScores[q.id]} / ${q.max || 100}` : "–" }),
        el("td", { class: "num", text: q.stats?.avg != null ? String(q.stats.avg) : "–" }),
      ])
    );
  }
  card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  container.appendChild(card);
}

function shortLabel(label) {
  return String(label || "").replace(/\s*\(.*\)\s*/, "");
}

function statTile(label, value, sub) {
  return el("div", { class: "stat-tile" }, [
    el("div", { class: "label", text: label }),
    el("div", { class: "value", text: value }),
    sub ? el("div", { class: "sub", text: sub }) : null,
  ]);
}

// ---------- 암호화 파일 행 (자료실·리포트 PDF 공용) ----------
function fileRow({ title, metaText, entry, key }) {
  const viewBtn = el("button", { class: "btn btn-small", text: "보기" });
  const saveBtn = el("button", { class: "btn btn-small", text: "저장" });
  const busy = (b) => {
    viewBtn.disabled = b;
    saveBtn.disabled = b;
  };
  const open = async (mode) => {
    busy(true);
    toast("파일을 여는 중입니다…");
    try {
      const blob = await loadMaterial(entry, key);
      const url = URL.createObjectURL(blob);
      blobURLs.push(url);
      if (mode === "view") {
        window.open(url, "_blank");
      } else {
        const a = el("a", { href: url, download: entry.origName || title });
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (e) {
      console.error(e);
      toast("파일을 불러오지 못했습니다.", "error");
    }
    busy(false);
  };
  viewBtn.addEventListener("click", () => open("view"));
  saveBtn.addEventListener("click", () => open("save"));
  return el("div", { class: "material" }, [
    el("div", { class: "m-info" }, [
      el("div", { class: "m-title", text: title }),
      el("div", { class: "m-meta", text: metaText }),
    ]),
    el("div", { class: "m-actions" }, [viewBtn, saveBtn]),
  ]);
}

// ---------- ③ 리포트 (단원별) ----------
function renderReport(container) {
  const { student, academy } = session;
  const quizzes = sortQuizzes(academy.quizzes, academy.weeks);
  const reports = student.quizReports || {};
  const card = el("div", { class: "card" }, [el("h2", { text: "단원별 리포트" })]);
  const withReport = [...quizzes]
    .reverse()
    .filter((q) => reports[q.id] && (reports[q.id].pdf || reports[q.id].note));
  if (!withReport.length) {
    card.appendChild(el("p", { class: "empty", text: "아직 작성된 리포트가 없습니다." }));
  } else {
    for (const q of withReport) {
      const rep = reports[q.id];
      const sec = el("div", { class: "unit-report" }, [
        el("div", { class: "unit-title" }, [
          el("span", { text: q.unit }),
          el("span", { class: "unit-week", text: shortLabel(weekLabelOf(academy.weeks, q.weekId)) }),
        ]),
      ]);
      if (rep.pdf) {
        sec.appendChild(
          fileRow({
            title: "📊 퀴즈 분석 리포트",
            metaText: [rep.pdf.origName, formatBytes(rep.pdf.size)].filter(Boolean).join(" · "),
            entry: rep.pdf,
            key: session.studentKey,
          })
        );
      }
      if (rep.note) sec.appendChild(el("div", { class: "report-body", text: rep.note }));
      card.appendChild(sec);
    }
  }
  container.appendChild(card);
}

// ---------- ④ 공지사항 ----------
function renderNotices(container) {
  const card = el("div", { class: "card" }, [el("h2", { text: "공지사항" })]);
  const notices = [...(session.academy.notices || [])].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.date || "").localeCompare(a.date || "");
  });
  if (!notices.length) {
    card.appendChild(el("p", { class: "empty", text: "등록된 공지가 없습니다." }));
  } else {
    for (const n of notices) {
      const body = el("div", { class: "notice-body", text: n.body || "" });
      body.hidden = true;
      const head = el("div", { class: "notice-head" }, [
        n.pinned ? el("span", { class: "pin", text: "📌 고정" }) : null,
        el("span", { class: "notice-title", text: n.title }),
        el("span", { class: "notice-date", text: n.date || "" }),
      ]);
      const wrap = el("div", { class: "notice" }, [head, body]);
      head.style.cursor = "pointer";
      head.addEventListener("click", () => (body.hidden = !body.hidden));
      card.appendChild(wrap);
    }
  }
  container.appendChild(card);
}

// ---------- ⑤ 자료실 ----------
function renderMaterials(container, weeks) {
  const card = el("div", { class: "card" }, [el("h2", { text: "자료실" })]);
  const materials = session.academy.materials || [];
  if (!materials.length) {
    card.appendChild(el("p", { class: "empty", text: "등록된 자료가 없습니다." }));
    container.appendChild(card);
    return;
  }
  const weekLabel = (id) => {
    const w = weeks.find((x) => x.id === id);
    return w ? w.label : "";
  };
  const sorted = [...materials].sort((a, b) => (b.weekId || "").localeCompare(a.weekId || ""));
  for (const m of sorted) {
    card.appendChild(
      fileRow({
        title: m.title,
        metaText: [weekLabel(m.weekId), formatBytes(m.size)].filter(Boolean).join(" · "),
        entry: m,
        key: session.academyKey,
      })
    );
  }
  container.appendChild(card);
}

// ---------- ⑥ 출석·진도 ----------
function renderAttendance(container, week) {
  const attCard = el("div", { class: "card" }, [el("h2", { text: "출석" })]);
  if (!week || !(week.sessions || []).length) {
    attCard.appendChild(el("p", { class: "empty", text: "이번 주 수업 일정이 없습니다." }));
  } else {
    const att = weekData(week.id).attendance || {};
    const row = el("div", { class: "att-row" });
    for (const d of week.sessions) {
      const code = att[d];
      const info = ATTENDANCE[code];
      row.appendChild(
        el("div", { class: `att-chip ${info ? info.cls : ""}` }, [
          el("span", { class: "d", text: d.slice(5).replace("-", "/") }),
          el("span", { class: "s", text: info ? info.label : "–" }),
        ])
      );
    }
    attCard.appendChild(row);
  }
  container.appendChild(attCard);

  const progCard = el("div", { class: "card" }, [el("h2", { text: "수업 진도" })]);
  if (week && week.progress) {
    progCard.appendChild(el("div", { class: "progress-text", text: week.progress }));
  } else {
    progCard.appendChild(el("p", { class: "empty", text: "이번 주 진도가 입력되지 않았습니다." }));
  }
  container.appendChild(progCard);
}

// ==================== 선생님(열람) 대시보드 ====================
// 관리 권한 없음 — 소속 학원의 출석 현황·퀴즈 점수 분포(익명)·공지만 열람.

function renderTeacherDashboard() {
  const { teacher, academy } = session;
  const weeks = sortWeeks(academy.weeks);
  const cur = currentWeek(weeks);
  let selectedWeekId = cur ? cur.id : weeks.length ? weeks[weeks.length - 1].id : null;

  const root = el("div", { class: "container" });
  root.appendChild(
    el("div", { class: "portal-header" }, [
      el("div", { class: "who" }, [
        el("div", { class: "name", text: teacher.name || `${academy.name} 선생님` }),
        el("div", { class: "academy", text: `${academy.name} · 열람 전용` }),
      ]),
      el("button", { class: "btn btn-small", text: "로그아웃", onclick: logout }),
    ])
  );

  const content = el("div", { id: "tab-content" });
  const renderTab = (id) => {
    clear(content);
    if (id === "att") renderTeacherAttendance(content, weeks, selectedWeekId, (wid) => {
      selectedWeekId = wid;
      renderTab("att");
    });
    else if (id === "hw") renderTeacherHomework(content, weeks, selectedWeekId, (wid) => {
      selectedWeekId = wid;
      renderTab("hw");
    });
    else if (id === "scores") renderTeacherScores(content);
    else if (id === "dist") renderTeacherQuizDist(content);
    else if (id === "reports") renderTeacherReports(content);
    else if (id === "notice") renderNotices(content);
  };
  const tabs = tabBar(
    root,
    [
      { id: "att", label: "출석 현황" },
      { id: "hw", label: "숙제" },
      { id: "scores", label: "학생별 성적" },
      { id: "dist", label: "퀴즈 분포" },
      { id: "reports", label: "리포트" },
      { id: "notice", label: "공지사항" },
    ],
    renderTab
  );
  root.appendChild(content);
  clear(app).appendChild(root);
  tabs.select("att");
}

// ---------- 출석 현황 (학생×수업일 표) ----------
function renderTeacherAttendance(container, weeks, selectedWeekId, onWeekChange) {
  const { teacher } = session;
  const card = el("div", { class: "card" }, [el("h2", { text: "출석 현황" })]);
  if (!weeks.length) {
    card.appendChild(el("p", { class: "empty", text: "등록된 주차가 없습니다." }));
    container.appendChild(card);
    return;
  }
  const weekSel = el("select", { "aria-label": "주차 선택" });
  for (const w of weeks) {
    weekSel.appendChild(el("option", { value: w.id, text: w.label, selected: w.id === selectedWeekId }));
  }
  weekSel.addEventListener("change", () => onWeekChange(weekSel.value));
  card.appendChild(el("div", { class: "week-select-row" }, [weekSel]));

  const week = weeks.find((w) => w.id === selectedWeekId) || weeks[weeks.length - 1];
  const rows = teacher.snapshot?.attendance?.[week.id] || [];
  const sessions = week.sessions || [];
  if (!sessions.length || !rows.length) {
    card.appendChild(el("p", { class: "empty", text: "이 주차의 출석 기록이 없습니다." }));
  } else {
    const tbl = el("table", { class: "grid" });
    tbl.appendChild(
      el("tr", {}, [
        el("th", { class: "name-cell", text: "이름" }),
        ...sessions.map((d) => el("th", { text: d.slice(5).replace("-", "/") })),
      ])
    );
    for (const r of rows) {
      tbl.appendChild(
        el("tr", {}, [
          el("td", { class: "name-cell", text: r.name }),
          ...sessions.map((d) => {
            const info = ATTENDANCE[r.byDate?.[d]];
            return el("td", {}, [
              info
                ? el("span", { class: `t-chip ${info.cls}`, text: info.label })
                : el("span", { class: "t-dash", text: "–" }),
            ]);
          }),
        ])
      );
    }
    card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  }
  if (week.progress) {
    card.appendChild(el("p", { class: "hint", text: `진도 · ${week.progress}` }));
  }
  container.appendChild(card);
}

// ---------- 숙제 체크 현황 (학생×항목 표) ----------
function renderTeacherHomework(container, weeks, selectedWeekId, onWeekChange) {
  const { teacher } = session;
  const card = el("div", { class: "card" }, [el("h2", { text: "숙제 체크 현황" })]);
  if (!weeks.length) {
    card.appendChild(el("p", { class: "empty", text: "등록된 주차가 없습니다." }));
    container.appendChild(card);
    return;
  }
  const weekSel = el("select", { "aria-label": "주차 선택" });
  for (const w of weeks) {
    weekSel.appendChild(el("option", { value: w.id, text: w.label, selected: w.id === selectedWeekId }));
  }
  weekSel.addEventListener("change", () => onWeekChange(weekSel.value));
  card.appendChild(el("div", { class: "week-select-row" }, [weekSel]));

  const week = weeks.find((w) => w.id === selectedWeekId) || weeks[weeks.length - 1];
  const items = week.homework || [];
  const rows = teacher.snapshot?.homework?.[week.id] || [];
  if (!items.length || !rows.length) {
    card.appendChild(el("p", { class: "empty", text: "이 주차에 등록된 숙제가 없습니다." }));
  } else {
    card.appendChild(
      el("ol", { class: "rd-list", style: "font-size:14px;padding-left:20px" },
        items.map((it) => el("li", { text: it.text })))
    );
    const tbl = el("table", { class: "grid" });
    tbl.appendChild(
      el("tr", {}, [
        el("th", { class: "name-cell", text: "이름" }),
        ...items.map((_, i) => el("th", { text: `${i + 1}번` })),
        el("th", { text: "완료율" }),
      ])
    );
    for (const r of rows) {
      const done = items.filter((it) => r.byItem?.[it.id]).length;
      tbl.appendChild(
        el("tr", {}, [
          el("td", { class: "name-cell", text: r.name }),
          ...items.map((it) =>
            el("td", {}, [
              r.byItem?.[it.id]
                ? el("span", { class: "hw-yes", text: "✓" })
                : el("span", { class: "t-dash", text: "–" }),
            ])
          ),
          el("td", { class: "num", text: `${Math.round((done / items.length) * 100)}%` }),
        ])
      );
    }
    card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  }
  container.appendChild(card);
}

// ---------- 개별 리포트 열람 (전달사항 + PDF 유무) ----------
function renderTeacherReports(container) {
  const { teacher, academy } = session;
  const quizzes = sortQuizzes(academy.quizzes, academy.weeks);
  const reports = teacher.snapshot?.reports || {};
  const withReports = [...quizzes].reverse().filter((q) => (reports[q.id] || []).length);
  if (!withReports.length) {
    container.appendChild(
      el("div", { class: "card" }, [
        el("h2", { text: "개별 리포트" }),
        el("p", { class: "empty", text: "아직 작성된 리포트가 없습니다." }),
      ])
    );
    return;
  }
  container.appendChild(
    el("p", {
      class: "hint",
      text: "학생별 전달사항 전문과 분석 PDF 첨부 여부입니다. (PDF 원본은 관리 페이지에서 발행한 파일입니다)",
    })
  );
  for (const q of withReports) {
    const card = el("div", { class: "card" }, [
      el("div", { class: "unit-title" }, [
        el("span", { text: q.unit }),
        el("span", { class: "unit-week", text: shortLabel(weekLabelOf(academy.weeks, q.weekId)) }),
      ]),
    ]);
    for (const r of reports[q.id]) {
      card.appendChild(
        el("div", { class: "t-report" }, [
          el("div", { class: "t-report-head" }, [
            el("span", { class: "t-report-name", text: r.name }),
            r.pdfName ? el("span", { class: "t-pdf-chip", text: `📎 ${r.pdfName}` }) : null,
          ]),
          r.note ? el("div", { class: "report-body", style: "font-size:14px", text: r.note }) : null,
        ])
      );
    }
    container.appendChild(card);
  }
}

// ---------- 학생별 성적 (이름×단원 표) ----------
function renderTeacherScores(container) {
  const { teacher, academy } = session;
  const quizzes = sortQuizzes(academy.quizzes, academy.weeks);
  const rows = teacher.snapshot?.scores || [];
  const card = el("div", { class: "card" }, [el("h2", { text: "학생별 성적" })]);
  if (!quizzes.length || !rows.length) {
    card.appendChild(el("p", { class: "empty", text: "아직 등록된 퀴즈가 없습니다." }));
    container.appendChild(card);
    return;
  }
  const tbl = el("table", { class: "grid" });
  tbl.appendChild(
    el("tr", {}, [
      el("th", { class: "name-cell", text: "이름" }),
      ...quizzes.map((q) => el("th", { text: `${q.unit} (${q.max || 100})` })),
    ])
  );
  for (const r of rows) {
    tbl.appendChild(
      el("tr", {}, [
        el("td", { class: "name-cell", text: r.name }),
        ...quizzes.map((q) => {
          const v = r.byQuiz?.[q.id];
          return el("td", { class: "num", text: v != null ? String(v) : "–" });
        }),
      ])
    );
  }
  // 학원 평균 행
  const avgRow = el("tr", { class: "t-avg-row" }, [el("td", { class: "name-cell", text: "학원 평균" })]);
  for (const q of quizzes) {
    const vals = rows.map((r) => r.byQuiz?.[q.id]).filter((v) => v != null);
    avgRow.appendChild(
      el("td", {
        class: "num",
        text: vals.length
          ? String(Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10)
          : "–",
      })
    );
  }
  tbl.appendChild(avgRow);
  card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  container.appendChild(card);
}

// 스냅샷에서 특정 퀴즈의 점수 배열 (분포용)
function quizScoreValues(quizId) {
  return (session.teacher.snapshot?.scores || [])
    .map((r) => r.byQuiz?.[quizId])
    .filter((v) => v != null);
}

// ---------- 퀴즈 점수 분포 (익명 히스토그램) ----------
function renderTeacherQuizDist(container) {
  const { academy } = session;
  const quizzes = sortQuizzes(academy.quizzes, academy.weeks);
  if (!quizzes.length) {
    container.appendChild(
      el("div", { class: "card" }, [
        el("h2", { text: "퀴즈 점수 분포" }),
        el("p", { class: "empty", text: "아직 등록된 퀴즈가 없습니다." }),
      ])
    );
    return;
  }
  for (const q of [...quizzes].reverse()) {
    const scores = quizScoreValues(q.id);
    const card = el("div", { class: "card" }, [
      el("div", { class: "unit-title" }, [
        el("span", { text: q.unit }),
        el("span", { class: "unit-week", text: shortLabel(weekLabelOf(academy.weeks, q.weekId)) }),
      ]),
    ]);
    if (scores.length) {
      const avg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
      card.appendChild(
        el("p", {
          class: "hint",
          text:
            `학원 평균 ${avg}점 · 최고 ${Math.max(...scores)}점 · 최저 ${Math.min(...scores)}점 · 응시 ${scores.length}명 (만점 ${q.max || 100}점)` +
            (q.stats?.avg != null ? ` · 전체 평균 ${q.stats.avg}점` : ""),
        })
      );
      const histBox = el("div");
      card.appendChild(histBox);
      renderHistogram(histBox, { scores, max: q.max || 100 });
    } else {
      card.appendChild(el("p", { class: "empty", text: "입력된 점수가 없습니다." }));
    }
    container.appendChild(card);
  }
}
