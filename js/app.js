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
  isNoShow,
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

  // 주차 선택 없음 — 숙제·출석·퀴즈 모두 전체 기록을 한 탭에서 보여준다 (최신 주차부터)
  // 새 소식 배지: 마지막으로 열어본 이후 새로 발행된 공지/퀴즈/리포트가 있으면 탭에 ● 표시
  const ids = newsIdSets();
  let seen = loadSeen();
  if (!seen) {
    seen = ids; // 이 기기 첫 사용 — 배지 없이 시작
    saveSeen(seen);
  }
  const hasNew = (tab) => (ids[tab] || []).some((id) => !(seen[tab] || []).includes(id));

  const content = el("div", { id: "tab-content" });
  const renderTab = (id) => {
    clear(content);
    if (id === "hw") renderHomework(content, weeks);
    else if (id === "quiz") renderQuiz(content);
    else if (id === "report") renderReport(content);
    else if (id === "notice") renderNotices(content);
    else if (id === "material") renderMaterials(content, weeks);
    else if (id === "att") renderAttendance(content, weeks);
    if (ids[id]) {
      seen = { ...seen, [id]: ids[id] };
      saveSeen(seen);
      tabs.setBadge(id, false);
    }
  };

  // 우선순위 순서: 해야 할 것(숙제) → 놓치면 안 되는 것(공지) → 확인할 것(퀴즈·리포트) → 기록 → 참고
  const tabs = tabBar(
    root,
    [
      { id: "hw", label: "숙제" },
      { id: "notice", label: "공지사항" },
      { id: "quiz", label: "퀴즈" },
      { id: "report", label: "리포트" },
      { id: "att", label: "출석·진도" },
      { id: "material", label: "자료실" },
    ],
    renderTab
  );
  root.appendChild(content);

  clear(app).appendChild(root);
  tabs.select("hw");
  for (const t of ["notice", "quiz", "report"]) tabs.setBadge(t, hasNew(t));
}

// ---------- 새 소식(배지) 상태 — 기기별 localStorage, 무작위 ID만 저장 ----------
function seenStoreKey() {
  return `shs.seen.${session.studentFileId}`;
}
function newsIdSets() {
  const { student, academy } = session;
  return {
    notice: (academy.notices || []).map((n) => String(n.id)),
    quiz: Object.keys(student.quizzes || {}),
    report: Object.entries(student.quizReports || {})
      .filter(([, r]) => r && (r.pdf || r.note))
      .map(([id]) => id),
  };
}
function loadSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(seenStoreKey()));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}
function saveSeen(seen) {
  try {
    localStorage.setItem(seenStoreKey(), JSON.stringify(seen));
  } catch {
    /* 저장 불가(시크릿 모드 등)면 배지만 매번 다시 계산됨 */
  }
}

function weekData(weekId) {
  return (session.student.weeks || {})[weekId] || {};
}

// ---------- ① 숙제 (전체 주차, 최신순) ----------
function renderHomework(container, weeks) {
  const card = el("div", { class: "card" }, [el("h2", { text: "숙제" })]);
  const withHw = [...weeks].reverse().filter((w) => (w.homework || []).length);
  if (!withHw.length) {
    card.appendChild(el("p", { class: "empty", text: "아직 등록된 숙제가 없습니다." }));
    container.appendChild(card);
    return;
  }
  card.appendChild(
    el("p", { class: "hint", text: "선생님이 수업 시간에 확인 후 체크합니다. (최신 주차부터)" })
  );
  let anyHold = false;
  for (const week of withHw) {
    const items = week.homework;
    const status = weekData(week.id).homework || {};
    const doneCount = items.filter((it) => status[it.id] === true).length;
    const holdCount = items.filter((it) => isNoShow(status, it.id)).length;
    if (holdCount) anyHold = true;
    const block = el("div", { class: "week-block" }, [
      el("div", { class: "wb-head" }, [
        el("span", { class: "wb-label", text: week.label }),
        el("button", {
          class: "btn btn-small",
          text: "📋 복사",
          "aria-label": `${week.label} 숙제 목록 복사`,
          onclick: () => copyText(homeworkShareText(session.academy.name, week)),
        }),
      ]),
      el("p", {
        class: "hw-progress",
        text:
          `완료 ${doneCount} / ${items.length - holdCount}` +
          (holdCount ? ` · 확인 전 ${holdCount}` : ""),
      }),
    ]);
    const ul = el("ul", { class: "hw-list" });
    for (const it of items) {
      const done = status[it.id] === true;
      const hold = isNoShow(status, it.id);
      ul.appendChild(
        el("li", { class: done ? "hw-done" : "" }, [
          el("span", {
            class: `hw-mark ${done ? "done" : hold ? "hold" : "todo"}`,
            text: done ? "✓" : hold ? "◌" : "",
          }),
          el("span", { class: "hw-text", text: it.text }),
        ])
      );
    }
    block.appendChild(ul);
    card.appendChild(block);
  }
  if (anyHold) {
    card.appendChild(
      el("p", { class: "hint", text: "◌ 결석 등으로 아직 확인하지 못한 숙제입니다. 다음 수업에서 확인합니다." })
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

  // 요약: 지금까지 본 모든 퀴즈 기준 — 내 점수 평균 vs 전체 평균(전 퀴즈 평균의 평균)
  const taken = quizzes.filter((q) => myScores[q.id] != null);
  if (taken.length) {
    const myAvg = round1(taken.reduce((a, q) => a + myScores[q.id], 0) / taken.length);
    const withStats = quizzes.filter((q) => q.stats?.avg != null);
    const allAvg = withStats.length
      ? round1(withStats.reduce((a, q) => a + q.stats.avg, 0) / withStats.length)
      : null;
    card.appendChild(
      el("p", { class: "hint", text: `지금까지 응시한 단원 퀴즈 ${taken.length}개 기준` })
    );
    card.appendChild(
      el("div", { class: "stat-row two" }, [
        statTile("내 평균", String(myAvg), ""),
        statTile("전체 평균", allAvg != null ? String(allAvg) : "–", ""),
      ])
    );
  }

  // 추이 그래프 (단원 응시 순, 만점 = 실제 퀴즈 만점 기준)
  card.appendChild(el("h2", { text: "점수 추이" }));
  const chartBox = el("div");
  card.appendChild(chartBox);
  renderScoreChart(chartBox, {
    weeks: quizzes.map((q) => ({ id: q.id, label: q.unit })),
    mine: quizzes.map((q) => (myScores[q.id] != null ? myScores[q.id] : null)),
    avg: quizzes.map((q) => (q.stats?.avg != null ? q.stats.avg : null)),
    yMax: Math.max(...quizzes.map((q) => q.max || 100)),
  });

  // 단원명에서 "-" 앞부분(과목 접두어) 제거: "물리 - 여러 가지 힘" → "여러 가지 힘"
  const unitShort = (unit) => {
    const m = String(unit || "").match(/[-–—]\s*(.+)$/);
    return m ? m[1].trim() : unit;
  };
  // 주차 대신 날짜: 라벨의 괄호 안 날짜 → 수업일 범위 → 라벨 순으로 사용
  const quizDateText = (q) => {
    const w = (academy.weeks || []).find((x) => x.id === q.weekId);
    if (!w) return "미정";
    const m = (w.label || "").match(/\(([^)]+)\)/);
    if (m) return m[1];
    const ss = w.sessions || [];
    const f = (d) => `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8, 10), 10)}`;
    if (ss.length) return ss.length > 1 ? `${f(ss[0])}~${f(ss[ss.length - 1])}` : f(ss[0]);
    return shortLabel(w.label) || "미정";
  };

  // 전체 목록 (최신 순): 단원 | 내 점수 | 전체 평균 | 날짜
  card.appendChild(el("h2", { text: "퀴즈 목록", style: "margin-top:16px" }));
  const tbl = el("table", { class: "grid" });
  tbl.appendChild(
    el("tr", {}, [
      el("th", { class: "name-cell", text: "단원" }),
      el("th", { text: "내 점수" }),
      el("th", { text: "전체 평균" }),
      el("th", { text: "날짜" }),
    ])
  );
  for (const q of [...quizzes].reverse()) {
    tbl.appendChild(
      el("tr", {}, [
        el("td", { class: "name-cell", text: unitShort(q.unit) }),
        el("td", {
          class: "num",
          text:
            myScores[q.id] != null
              ? `${myScores[q.id]} / ${q.max || 100}`
              : isNoShow(myScores, q.id)
                ? "미응시"
                : "–",
        }),
        el("td", { class: "num", text: q.stats?.avg != null ? String(q.stats.avg) : "–" }),
        el("td", { text: quizDateText(q) }),
      ])
    );
  }
  card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  container.appendChild(card);
}

function round1(v) {
  return Math.round(v * 10) / 10;
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
          el("span", { class: "unit-week", text: shortLabel(weekLabelOf(academy.weeks, q.weekId)) || "주차 미정" }),
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

// ---------- ⑥ 출석·진도 (전체 주차, 최신순) ----------
function renderAttendance(container, weeks) {
  const card = el("div", { class: "card" }, [el("h2", { text: "출석·진도" })]);
  const shown = [...weeks]
    .reverse()
    .filter((w) => (w.sessions || []).length || (w.progress || "").trim());
  if (!shown.length) {
    card.appendChild(el("p", { class: "empty", text: "아직 수업 기록이 없습니다." }));
    container.appendChild(card);
    return;
  }
  card.appendChild(el("p", { class: "hint", text: "주차별 출석과 수업 진도입니다. (최신 주차부터)" }));
  for (const week of shown) {
    const block = el("div", { class: "week-block" }, [
      el("div", { class: "wb-head" }, [el("span", { class: "wb-label", text: week.label })]),
    ]);
    if ((week.sessions || []).length) {
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
      block.appendChild(row);
    }
    if ((week.progress || "").trim()) {
      block.appendChild(
        el("div", { class: "progress-text wb-progress", text: `진도 · ${week.progress}` })
      );
    }
    card.appendChild(block);
  }
  container.appendChild(card);
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

  let selectedQuizWeek = null; // 학생별 성적 탭의 주차 선택 (null = 기본값)
  const content = el("div", { id: "tab-content" });
  const renderTab = (id) => {
    clear(content);
    if (id === "att") renderTeacherAttendance(content, weeks, selectedWeekId, (wid) => {
      selectedWeekId = wid;
      renderTab("att");
    });
    else if (id === "hw") renderTeacherHomework(content, weeks);
    else if (id === "scores") renderTeacherScores(content, weeks, selectedQuizWeek, (v) => {
      selectedQuizWeek = v;
      renderTab("scores");
    });
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

// ---------- 숙제 체크 현황 (학생×주차 완료율 매트릭스 — 좌우 스크롤) ----------
function renderTeacherHomework(container, weeks) {
  const { teacher } = session;
  const card = el("div", { class: "card" }, [el("h2", { text: "숙제 체크 현황" })]);
  const hwWeeks = [...weeks].reverse().filter((w) => (w.homework || []).length);
  if (!hwWeeks.length) {
    card.appendChild(el("p", { class: "empty", text: "등록된 숙제가 없습니다." }));
    container.appendChild(card);
    return;
  }
  card.appendChild(
    el("p", { class: "hint", text: "주차(수업)별 숙제 완료율입니다. 최신 주차부터 — 옆으로 밀어서 지난 주차를 보세요." })
  );

  // 주차별 이름→체크상태 맵 (스냅샷은 주차 단위 배열)
  const byWeek = new Map(); // weekId -> Map(name -> byItem)
  const names = [];
  for (const w of hwWeeks) {
    const m = new Map();
    for (const r of teacher.snapshot?.homework?.[w.id] || []) {
      m.set(r.name, r.byItem || {});
      if (!names.includes(r.name)) names.push(r.name);
    }
    byWeek.set(w.id, m);
  }

  // 학생·주차별 완료율 (◌ 확인 전은 분모에서 제외)
  const rateOf = (byItem, items) => {
    const done = items.filter((it) => byItem?.[it.id] === true).length;
    const holds = items.filter((it) => isNoShow(byItem, it.id)).length;
    const denom = items.length - holds;
    return { done, holds, denom };
  };
  const shortWeek = (w) => shortLabel(w.label) || w.id;

  const tbl = el("table", { class: "grid" });
  tbl.appendChild(
    el("tr", {}, [
      el("th", { class: "name-cell", text: "이름" }),
      ...hwWeeks.map((w) => el("th", { text: shortWeek(w) })),
    ])
  );
  let anyHold = false;
  for (const name of names) {
    tbl.appendChild(
      el("tr", {}, [
        el("td", { class: "name-cell", text: name }),
        ...hwWeeks.map((w) => {
          const { done, holds, denom } = rateOf(byWeek.get(w.id).get(name), w.homework);
          if (holds) anyHold = true;
          if (!denom) return el("td", { class: "num" }, [el("span", { class: "hw-hold", text: "◌" })]);
          return el("td", { class: "num", text: `${Math.round((done / denom) * 100)}%${holds ? " ◌" : ""}` });
        }),
      ])
    );
  }
  // 학원 평균 행 (주차별 전체 완료율)
  const avgRow = el("tr", { class: "t-avg-row" }, [el("td", { class: "name-cell", text: "학원 평균" })]);
  for (const w of hwWeeks) {
    let doneAll = 0;
    let denomAll = 0;
    for (const name of names) {
      const { done, denom } = rateOf(byWeek.get(w.id).get(name), w.homework);
      doneAll += done;
      denomAll += denom;
    }
    avgRow.appendChild(
      el("td", { class: "num", text: denomAll ? `${Math.round((doneAll / denomAll) * 100)}%` : "–" })
    );
  }
  tbl.appendChild(avgRow);
  card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  if (anyHold) {
    card.appendChild(
      el("p", { class: "hint", text: "◌ = 결석 등으로 확인 전인 숙제 포함 (완료율 계산에서 제외)" })
    );
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

// ---------- 학생별 성적 (주차 선택 → 그 수업에 본 단원들만 표시) ----------
function renderTeacherScores(container, weeks, selectedQuizWeek, onWeekChange) {
  const { teacher, academy } = session;
  const allQuizzes = sortQuizzes(academy.quizzes, academy.weeks);
  const rows = teacher.snapshot?.scores || [];
  const card = el("div", { class: "card" }, [el("h2", { text: "학생별 성적" })]);
  if (!allQuizzes.length || !rows.length) {
    card.appendChild(el("p", { class: "empty", text: "아직 등록된 퀴즈가 없습니다." }));
    container.appendChild(card);
    return;
  }

  // 퀴즈가 있는 주차만 선택지로 (주차 미정 퀴즈는 '주차 미정' 그룹)
  const groups = [];
  for (const w of weeks) {
    const qs = allQuizzes.filter((q) => q.weekId === w.id);
    if (qs.length) groups.push({ key: w.id, label: w.label, quizzes: qs });
  }
  const tbd = allQuizzes.filter((q) => !q.weekId || !weeks.some((w) => w.id === q.weekId));
  if (tbd.length) groups.push({ key: "", label: "주차 미정", quizzes: tbd });

  const selected =
    groups.find((g) => g.key === selectedQuizWeek) ||
    groups.filter((g) => g.key !== "").pop() ||
    groups[groups.length - 1];

  const weekSel = el("select", { "aria-label": "퀴즈 주차 선택" });
  for (const g of groups) {
    weekSel.appendChild(el("option", { value: g.key, text: g.label, selected: g.key === selected.key }));
  }
  weekSel.addEventListener("change", () => onWeekChange(weekSel.value));
  card.appendChild(el("div", { class: "week-select-row" }, [weekSel]));
  card.appendChild(
    el("p", { class: "hint", text: "선택한 주차(수업)에 본 단원 퀴즈의 점수만 표시됩니다." })
  );

  const quizzes = selected.quizzes;
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
          if (v != null) return el("td", { class: "num", text: String(v) });
          return el("td", { class: "num" }, [
            isNoShow(r.byQuiz, q.id)
              ? el("span", { class: "t-noshow", text: "미응시" })
              : el("span", { class: "t-dash", text: "–" }),
          ]);
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
