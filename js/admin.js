// admin.js — 선생님 관리 페이지 컨트롤러
// 구조: 마스터 비밀번호 로그인 → 전체 데이터 복호화(인메모리 모델) → 편집 → 발행(재암호화)
import {
  deriveMasterKey,
  deriveStudentKeys,
  decryptJSON,
  encryptJSON,
  encryptBytes,
  decryptBytes,
  importAesKeyB64,
  exportAesKeyB64,
  generateCode,
  randomHexId,
  randomKeyB64,
  randomSaltB64,
  normalizePassword,
  b64encode,
} from "./crypto.js";
import { fetchJSON, fetchBytes, metaExists, sortWeeks, isoWeekId, toYMD, homeworkShareText, formatBytes, ATTENDANCE, ATTENDANCE_ORDER } from "./store.js";
import { $, el, clear, toast, confirmModal, copyText, setBusy } from "./ui.js";
import { runWizard, createStudent, emptyStudentBlob, emptyAcademyBlob, printCodeCards } from "./setup.js";
import { buildDirectorReport } from "./report.js";
import { publishToGitHub, guessRepoFromLocation } from "./github.js";
import { buildZip, downloadBlob } from "./zip.js";

const mount = $("#admin");

// ---------- 인메모리 모델 ----------
const S = {
  meta: null,
  roster: null,
  academies: new Map(), // fileId -> blob
  students: new Map(), // fileId -> blob
  masterKey: null,
  dirtyStudents: new Set(),
  dirtyAcademies: new Set(),
  rosterDirty: false,
  pendingUploads: new Map(), // path -> {bytes: Uint8Array, academyFileId}
  pendingDeletes: new Set(), // path
  // UI 상태
  selAcademy: null,
  selWeek: new Map(), // academyFileId -> weekId
  zipDownloaded: false,
};

const dirtyCount = () =>
  S.dirtyStudents.size +
  S.dirtyAcademies.size +
  (S.rosterDirty ? 1 : 0) +
  S.pendingUploads.size +
  S.pendingDeletes.size;

function markStudent(fileId) {
  S.dirtyStudents.add(fileId);
  updateBadge();
}
function markAcademy(fileId) {
  S.dirtyAcademies.add(fileId);
  updateBadge();
}
function markRoster() {
  S.rosterDirty = true;
  updateBadge();
}

window.addEventListener("beforeunload", (e) => {
  if (dirtyCount() > 0 && !S.zipDownloaded) {
    e.preventDefault();
    e.returnValue = "";
  }
});

init();

async function init() {
  if (!globalThis.crypto?.subtle) {
    clear(mount).appendChild(
      el("div", { class: "admin-container" }, [
        el("div", { class: "card" }, [
          el("h2", { text: "보안 컨텍스트가 아닙니다" }),
          el("p", {
            text: "암호화 기능은 https 또는 localhost에서만 동작합니다. file:// 로 열지 말고 로컬 서버(python3 -m http.server)나 GitHub Pages에서 열어 주세요.",
          }),
        ]),
      ])
    );
    return;
  }
  const exists = await metaExists();
  if (!exists) {
    renderWizardIntro();
  } else {
    renderLogin();
  }
}

// ---------- 초기 설정 ----------
function renderWizardIntro() {
  const container = el("div", { class: "admin-container" });
  container.appendChild(
    el("div", { class: "card" }, [
      el("h2", { text: "처음 오셨네요! 초기 설정을 시작합니다" }),
      el("p", {
        class: "hint",
        text: "마스터 비밀번호, 학원, 학생 명단을 등록하면 학생별 접속 코드와 암호화된 데이터 파일이 만들어집니다. 마지막에 '발행'하면 사이트가 열립니다.",
      }),
      el("button", { class: "btn btn-primary", text: "초기 설정 시작", onclick: startWizard }),
    ])
  );
  clear(mount).appendChild(container);
}

function startWizard() {
  const container = el("div", { class: "admin-container" });
  clear(mount).appendChild(container);
  runWizard(container, {
    siteURL: location.origin + location.pathname.replace(/admin\.html.*$/, ""),
    onComplete: (model) => {
      S.meta = model.meta;
      S.roster = model.roster;
      S.academies = model.academies;
      S.students = model.students;
      S.masterKey = model.masterKey;
      // 이전 상태(재설정 경로 포함) 정리 후 전부 새 데이터 → 전부 dirty
      clearDirty();
      for (const id of S.students.keys()) S.dirtyStudents.add(id);
      for (const id of S.academies.keys()) S.dirtyAcademies.add(id);
      S.rosterDirty = true;
      renderMain();
      toast("생성 완료! '학생 관리'에서 코드 카드를 인쇄하고, '발행' 탭에서 사이트에 올려 주세요.", "ok");
    },
  });
}

// ---------- 로그인 ----------
function renderLogin(errorMsg) {
  const pw = el("input", { type: "password", autocomplete: "current-password" });
  const err = el("p", { class: "error-text", text: errorMsg || "" });
  const btn = el("button", { class: "btn btn-primary btn-block", text: "잠금 해제" });

  const submit = async () => {
    btn.disabled = true;
    btn.textContent = "확인 중… (몇 초 걸립니다)";
    try {
      await loadAll(pw.value);
      renderMain();
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      btn.textContent = "잠금 해제";
      err.textContent =
        e.name === "OperationError"
          ? "비밀번호가 올바르지 않습니다."
          : "불러오기 실패: " + e.message;
    }
  };
  btn.addEventListener("click", submit);
  pw.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  const container = el("div", { class: "admin-container" }, [
    el("div", { class: "card", style: "max-width:420px;margin:48px auto" }, [
      el("h2", { text: "관리 페이지" }),
      el("p", { class: "hint", text: "마스터 비밀번호를 입력해 주세요." }),
      el("label", { class: "field" }, [pw]),
      err,
      btn,
      el("hr", { style: "border:none;border-top:1px solid var(--hairline);margin:16px 0" }),
      el("button", { class: "btn btn-small", text: "백업 파일로 복원 (비밀번호 분실 시)", onclick: renderRestore }),
      el("div", { style: "height:8px" }),
      el("button", {
        class: "btn btn-small",
        text: "🧹 처음부터 다시 설정 (초기 설정 마법사)",
        onclick: async () => {
          const ok = await confirmModal({
            title: "초기 설정 다시 실행",
            body: "기존 데이터(샘플 포함)를 새 데이터로 교체합니다. 발행하면 기존 학생 코드는 모두 무효가 되고 코드 카드를 다시 배부해야 합니다. 계속할까요?",
            okText: "다시 설정",
            danger: true,
          });
          if (ok) startWizard();
        },
      }),
    ]),
  ]);
  clear(mount).appendChild(container);
  pw.focus();
}

async function loadAll(password) {
  S.meta = await fetchJSON("data/meta.json");
  S.masterKey = await deriveMasterKey(password, S.meta.saltMaster, S.meta.kdf.iterMaster);
  const rosterEnv = await fetchJSON("data/roster.json");
  S.roster = await decryptJSON(S.masterKey, rosterEnv); // 실패 시 OperationError = 비밀번호 오류

  S.academies = new Map();
  for (const a of S.roster.academies) {
    const key = await importAesKeyB64(a.key);
    try {
      const env = await fetchJSON(`data/a/${a.fileId}.json`);
      S.academies.set(a.fileId, await decryptJSON(key, env));
    } catch {
      // 아직 발행 전인 학원 → 빈 blob
      S.academies.set(a.fileId, emptyAcademyBlob(a.name));
      S.dirtyAcademies.add(a.fileId);
    }
  }
  S.students = new Map();
  for (const st of S.roster.students) {
    const key = await importAesKeyB64(st.encKey);
    const aEntry = S.roster.academies.find((a) => a.fileId === st.academyFileId);
    try {
      const env = await fetchJSON(`data/s/${st.fileId}.json`);
      S.students.set(st.fileId, await decryptJSON(key, env));
    } catch {
      S.students.set(st.fileId, emptyStudentBlob(st.name, aEntry));
      S.dirtyStudents.add(st.fileId);
    }
  }
}

// ---------- 백업 복원 ----------
function renderRestore() {
  const file = el("input", { type: "file", accept: "application/json" });
  const pw1 = el("input", { type: "password", autocomplete: "new-password" });
  const pw2 = el("input", { type: "password", autocomplete: "new-password" });
  const err = el("p", { class: "error-text" });
  const container = el("div", { class: "admin-container" }, [
    el("div", { class: "card", style: "max-width:480px;margin:48px auto" }, [
      el("h2", { text: "백업에서 복원" }),
      el("p", {
        class: "hint",
        text: "'발행' 탭에서 내려받은 백업 JSON 파일과 새 마스터 비밀번호를 입력하세요. 학생 코드는 그대로 유지됩니다. 복원 후 반드시 '발행'해야 적용됩니다.",
      }),
      el("label", { class: "field" }, [el("span", { text: "백업 파일" }), file]),
      el("label", { class: "field" }, [el("span", { text: "새 마스터 비밀번호 (12자 이상)" }), pw1]),
      el("label", { class: "field" }, [el("span", { text: "비밀번호 확인" }), pw2]),
      err,
      el("button", {
        class: "btn btn-primary btn-block",
        text: "복원하기",
        onclick: async () => {
          try {
            const p = normalizePassword(pw1.value);
            if (p.length < 12) throw new Error("비밀번호는 12자 이상이어야 합니다.");
            if (p !== normalizePassword(pw2.value)) throw new Error("두 비밀번호가 일치하지 않습니다.");
            if (!file.files[0]) throw new Error("백업 파일을 선택해 주세요.");
            const backup = JSON.parse(await file.files[0].text());
            if (!backup.meta || !backup.roster) throw new Error("올바른 백업 파일이 아닙니다.");
            S.meta = backup.meta;
            S.roster = backup.roster;
            S.academies = new Map(Object.entries(backup.academies || {}));
            S.students = new Map(Object.entries(backup.students || {}));
            // 새 마스터 비밀번호로 교체
            S.meta.saltMaster = randomSaltB64();
            S.masterKey = await deriveMasterKey(p, S.meta.saltMaster, S.meta.kdf.iterMaster);
            for (const id of S.students.keys()) S.dirtyStudents.add(id);
            for (const id of S.academies.keys()) S.dirtyAcademies.add(id);
            S.rosterDirty = true;
            renderMain();
            toast("복원되었습니다. '발행' 탭에서 발행해야 사이트에 반영됩니다.", "ok");
          } catch (e) {
            err.textContent = e.message;
          }
        },
      }),
      el("button", { class: "btn btn-small", text: "← 돌아가기", onclick: () => renderLogin() }),
    ]),
  ]);
  clear(mount).appendChild(container);
}

// ---------- 메인 UI ----------
let badgeEl = null;
let contentEl = null;
let activeTab = "students";

function updateBadge() {
  if (!badgeEl) return;
  const n = dirtyCount();
  badgeEl.textContent = n > 0 ? `발행하지 않은 변경 ${n}건` : "모든 변경 발행됨";
  badgeEl.className = n > 0 ? "dirty-badge" : "dirty-badge clean";
}

function renderMain() {
  if (!S.selAcademy || !S.roster.academies.some((a) => a.fileId === S.selAcademy)) {
    S.selAcademy = S.roster.academies[0]?.fileId || null;
  }
  const container = el("div", { class: "admin-container" });
  badgeEl = el("span", { class: "dirty-badge" });
  container.appendChild(
    el("div", { class: "admin-header" }, [
      el("h1", { text: `🗝️ 관리 페이지` }),
      el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [
        badgeEl,
        el("button", { class: "btn btn-small", text: "잠금", onclick: () => location.reload() }),
      ]),
    ])
  );

  const tabs = [
    ["students", "학생 관리"],
    ["scores", "점수 입력"],
    ["homework", "숙제 체크"],
    ["attendance", "출석"],
    ["reports", "리포트"],
    ["notices", "공지"],
    ["materials", "자료실"],
    ["progress", "진도"],
    ["director", "보고서"],
    ["publish", "발행"],
  ];
  const bar = el("div", { class: "tabbar" });
  const btns = new Map();
  for (const [id, label] of tabs) {
    const b = el("button", { class: "tab", text: label, onclick: () => selectTab(id) });
    btns.set(id, b);
    bar.appendChild(b);
  }
  container.appendChild(bar);
  contentEl = el("div");
  container.appendChild(contentEl);
  clear(mount).appendChild(container);

  function selectTab(id) {
    activeTab = id;
    for (const [tid, b] of btns) b.classList.toggle("active", tid === id);
    renderTab();
  }
  selectTab(activeTab);
  updateBadge();
}

function renderTab() {
  clear(contentEl);
  const render = {
    students: renderStudentsTab,
    scores: renderScoresTab,
    homework: renderHomeworkTab,
    attendance: renderAttendanceTab,
    reports: renderReportsTab,
    notices: renderNoticesTab,
    materials: renderMaterialsTab,
    progress: renderProgressTab,
    director: renderDirectorTab,
    publish: renderPublishTab,
  }[activeTab];
  render(contentEl);
}

// ---------- 공용: 학원/주차 선택 툴바 ----------
function academyEntry(fileId = S.selAcademy) {
  return S.roster.academies.find((a) => a.fileId === fileId);
}
function academyBlob(fileId = S.selAcademy) {
  return S.academies.get(fileId);
}
function activeStudentsOf(academyFileId) {
  return S.roster.students.filter((s) => s.academyFileId === academyFileId && s.active !== false);
}
function selectedWeek() {
  const blob = academyBlob();
  if (!blob) return null;
  const weeks = sortWeeks(blob.weeks);
  if (!weeks.length) return null;
  const wid = S.selWeek.get(S.selAcademy);
  return weeks.find((w) => w.id === wid) || weeks[weeks.length - 1];
}

function toolbar(container, { withWeek = true } = {}) {
  const bar = el("div", { class: "toolbar" });
  const aSel = el("select", { "aria-label": "학원 선택" });
  for (const a of S.roster.academies) {
    aSel.appendChild(el("option", { value: a.fileId, text: a.name, selected: a.fileId === S.selAcademy }));
  }
  aSel.addEventListener("change", () => {
    S.selAcademy = aSel.value;
    renderTab();
  });
  bar.appendChild(aSel);

  if (withWeek) {
    const wSel = el("select", { "aria-label": "주차 선택" });
    const weeks = sortWeeks(academyBlob()?.weeks || []);
    const cur = selectedWeek();
    for (const w of weeks) {
      wSel.appendChild(el("option", { value: w.id, text: w.label, selected: cur && w.id === cur.id }));
    }
    if (!weeks.length) wSel.appendChild(el("option", { text: "주차 없음", value: "" }));
    wSel.addEventListener("change", () => {
      S.selWeek.set(S.selAcademy, wSel.value);
      renderTab();
    });
    bar.appendChild(wSel);
    bar.appendChild(el("button", { class: "btn btn-small", text: "주차 관리", onclick: manageWeeks }));
  }
  container.appendChild(bar);
}

// ---------- 주차 관리 ----------
function manageWeeks() {
  const blob = academyBlob();
  const overlay = el("div", { class: "modal-overlay" });
  const body = el("div");

  const renderList = () => {
    clear(body);
    const weeks = sortWeeks(blob.weeks);
    if (!weeks.length) body.appendChild(el("p", { class: "empty", text: "아직 주차가 없습니다." }));
    for (const w of weeks) {
      const labelIn = el("input", { type: "text", value: w.label });
      const sessIn = el("input", {
        type: "text",
        value: (w.sessions || []).join(", "),
        placeholder: "수업일: 2026-07-07, 2026-07-10",
      });
      const save = () => {
        w.label = labelIn.value.trim() || w.label;
        const dates = sessIn.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
          .sort();
        w.sessions = dates;
        markAcademy(S.selAcademy);
        toast("저장되었습니다.", "ok");
      };
      body.appendChild(
        el("div", { class: "card", style: "padding:10px" }, [
          el("div", { class: "hint", text: `ID: ${w.id}` }),
          el("div", { class: "item-row" }, [labelIn]),
          el("div", { class: "item-row" }, [sessIn]),
          el("div", { class: "item-row" }, [
            el("button", { class: "btn btn-small", text: "저장", onclick: save }),
            el("button", {
              class: "btn btn-small btn-danger",
              text: "삭제",
              onclick: async () => {
                const ok = await confirmModal({
                  title: "주차 삭제",
                  body: `'${w.label}'을(를) 삭제할까요? 이 주차의 숙제·점수 표시가 사라집니다. (학생 데이터 자체는 남아 있습니다)`,
                  okText: "삭제",
                  danger: true,
                });
                if (!ok) return;
                blob.weeks = blob.weeks.filter((x) => x.id !== w.id);
                markAcademy(S.selAcademy);
                renderList();
              },
            }),
          ]),
        ])
      );
    }
  };

  const addWeek = () => {
    const today = new Date();
    let id = isoWeekId(today);
    // 중복 시 뒤로 밀기
    const ids = new Set(blob.weeks.map((w) => w.id));
    let bump = 0;
    while (ids.has(id)) {
      bump += 7;
      const d = new Date(today);
      d.setDate(d.getDate() + bump);
      id = isoWeekId(d);
    }
    const month = today.getMonth() + 1;
    const nth = Math.ceil(today.getDate() / 7);
    blob.weeks.push({
      id,
      label: `${month}월 ${nth}주차`,
      sessions: [],
      homework: [],
      progress: "",
      quizStats: null,
    });
    S.selWeek.set(S.selAcademy, id);
    markAcademy(S.selAcademy);
    renderList();
  };

  overlay.appendChild(
    el("div", { class: "modal", style: "max-width:560px;max-height:85dvh;overflow-y:auto" }, [
      el("h3", { text: `주차 관리 — ${academyEntry().name}` }),
      body,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn", text: "+ 새 주차", onclick: addWeek }),
        el("button", {
          class: "btn btn-primary",
          text: "닫기",
          onclick: () => {
            overlay.remove();
            renderTab();
          },
        }),
      ]),
    ])
  );
  renderList();
  document.body.appendChild(overlay);
}

// ---------- ① 학생 관리 ----------
function renderStudentsTab(container) {
  const card = el("div", { class: "card" }, [el("h2", { text: "학생 관리" })]);

  for (const a of S.roster.academies) {
    card.appendChild(el("h3", { text: a.name, style: "font-size:15px;margin-top:14px" }));
    const students = S.roster.students.filter((s) => s.academyFileId === a.fileId);
    if (!students.length) card.appendChild(el("p", { class: "empty", text: "학생이 없습니다." }));
    for (const st of students) {
      card.appendChild(
        el("div", { class: `student-row ${st.active === false ? "inactive" : ""}` }, [
          el("span", { class: "s-name", text: st.name }),
          el("span", { class: "code-pill", text: st.code }),
          el("span", { class: "s-actions" }, [
            el("button", {
              class: "btn btn-small",
              text: "카드 인쇄",
              onclick: () => printCodeCards([{ name: st.name, code: st.code, academyName: a.name }], S.meta.site.title, S.roster.siteURL),
            }),
            el("button", { class: "btn btn-small", text: "코드 재발급", onclick: () => reissueCode(st) }),
            el("button", {
              class: "btn btn-small",
              text: st.active === false ? "활성화" : "비활성",
              onclick: () => {
                st.active = st.active === false;
                markRoster();
                renderTab();
              },
            }),
            el("button", { class: "btn btn-small btn-danger", text: "삭제", onclick: () => deleteStudent(st) }),
          ]),
        ])
      );
    }
  }

  // 학생 추가
  const nameIn = el("input", { type: "text", placeholder: "학생 이름" });
  const aSel = el("select");
  for (const a of S.roster.academies) aSel.appendChild(el("option", { value: a.fileId, text: a.name }));
  card.appendChild(el("h3", { text: "학생 추가", style: "font-size:15px;margin-top:18px" }));
  card.appendChild(
    el("div", { class: "toolbar" }, [
      nameIn,
      aSel,
      el("button", {
        class: "btn btn-primary btn-small",
        text: "추가",
        onclick: async () => {
          const name = nameIn.value.trim();
          if (!name) return toast("이름을 입력해 주세요.", "error");
          const aEntry = academyEntry(aSel.value);
          const { rosterEntry, blob } = await createStudent(name, aEntry, S.meta.saltStudent);
          S.roster.students.push(rosterEntry);
          S.students.set(rosterEntry.fileId, blob);
          markStudent(rosterEntry.fileId);
          markRoster();
          toast(`${name} 학생이 추가되었습니다. 코드: ${rosterEntry.code}`, "ok");
          renderTab();
        },
      }),
    ])
  );

  card.appendChild(
    el("div", { class: "toolbar", style: "margin-top:14px" }, [
      el("button", {
        class: "btn",
        text: "🖨️ 전체 코드 카드 인쇄",
        onclick: () => {
          const entries = S.roster.students
            .filter((s) => s.active !== false)
            .map((s) => ({
              name: s.name,
              code: s.code,
              academyName: academyEntry(s.academyFileId)?.name || "",
            }));
          printCodeCards(entries, S.meta.site.title, S.roster.siteURL);
        },
      }),
    ])
  );

  container.appendChild(card);
}

async function reissueCode(st) {
  const ok = await confirmModal({
    title: "코드 재발급",
    body:
      `${st.name} 학생의 접속 코드를 새로 만듭니다. 기존 코드는 더 이상 사용할 수 없습니다. ` +
      `(데이터와 분석 PDF는 새 코드로 다시 암호화되어 유지됩니다)\n\n` +
      `주의: 재발급 후에는 ZIP 수동 업로드가 아닌 'GitHub에 발행(자동 커밋)'을 사용해야 ` +
      `이전 파일이 서버에서 삭제되어 유출된 코드로 접근할 수 없게 됩니다.`,
    okText: "재발급",
  });
  if (!ok) return;
  setBusy(contentEl, "분석 PDF를 새 코드로 다시 암호화하는 중…");
  try {
    const blob = S.students.get(st.fileId);
    const oldFileId = st.fileId;
    const oldKey = await importAesKeyB64(st.encKey);

    // 1) gather: 이 학생의 모든 분석 PDF 평문을 먼저 확보 —
    //    하나라도 실패하면 아무것도 바꾸지 않는다 (구 키 유실 방지)
    const gathered = [];
    for (const wd of Object.values(blob.weeks || {})) {
      const pdf = wd.reportPdf;
      if (!pdf) continue;
      const pending = S.pendingUploads.get(pdf.path);
      const bytes = pending
        ? pending.bytes
        : new Uint8Array(await decryptBytes(oldKey, await fetchBytes(pdf.path)));
      gathered.push({ pdf, wasPending: !!pending, bytes });
    }

    // 2) commit: 새 키 유도 후 일괄 반영
    const code = generateCode();
    const { fileId, aesKey } = await deriveStudentKeys(code, S.meta.saltStudent, S.meta.kdf.iterStudent);
    st.code = code;
    st.fileId = fileId;
    st.encKey = await exportAesKeyB64(aesKey);
    S.students.delete(oldFileId);
    S.students.set(fileId, blob);
    S.dirtyStudents.delete(oldFileId);
    S.pendingDeletes.add(`data/s/${oldFileId}.json`);
    for (const g of gathered) {
      if (g.wasPending) S.pendingUploads.delete(g.pdf.path);
      else S.pendingDeletes.add(g.pdf.path);
      g.pdf.path = `data/m/${randomHexId(16)}.bin`;
      S.pendingUploads.set(g.pdf.path, { bytes: g.bytes, studentFileId: fileId });
    }
    markStudent(fileId);
    markRoster();
    toast(`새 코드: ${code} — 카드를 다시 인쇄해 전달하세요.`, "ok");
  } catch (e) {
    console.error(e);
    toast("재발급 실패: " + e.message + " (변경된 것은 없습니다)", "error");
  }
  renderTab();
}

async function deleteStudent(st) {
  const ok = await confirmModal({
    title: "학생 삭제",
    body:
      `${st.name} 학생을 완전히 삭제합니다. 이 학생의 모든 기록과 분석 PDF가 삭제되고, ` +
      `보안을 위해 소속 학원의 암호화 키가 교체됩니다(공지·자료 재암호화).\n\n` +
      `발행해야 적용되며, ZIP 수동 업로드가 아닌 'GitHub에 발행(자동 커밋)'을 사용해야 ` +
      `이전 파일이 서버에서 삭제됩니다.`,
    okText: "삭제",
    danger: true,
  });
  if (!ok) return;
  setBusy(contentEl, "학원 키를 교체하고 자료를 재암호화하는 중…");
  try {
    const academyFileId = st.academyFileId;
    // 이 학생의 분석 PDF 정리 (blob 제거 전에 경로를 확보해야 함)
    const blob = S.students.get(st.fileId);
    for (const wd of Object.values(blob?.weeks || {})) {
      const pdf = wd.reportPdf;
      if (!pdf) continue;
      if (S.pendingUploads.has(pdf.path)) S.pendingUploads.delete(pdf.path);
      else S.pendingDeletes.add(pdf.path);
    }
    S.roster.students = S.roster.students.filter((x) => x.fileId !== st.fileId);
    S.students.delete(st.fileId);
    S.dirtyStudents.delete(st.fileId);
    S.pendingDeletes.add(`data/s/${st.fileId}.json`);
    await rotateAcademyKey(academyFileId);
    markRoster();
    toast(`${st.name} 학생이 삭제되었습니다. '발행'해야 사이트에 반영됩니다.`, "ok");
  } catch (e) {
    console.error(e);
    toast("삭제 처리 중 오류: " + e.message, "error");
  }
  renderTab();
}

// 학원 키 교체: 새 키/파일ID 생성, 자료 재암호화, 소속 학생 blob 갱신
// 주의: 학생 개인 키로 암호화된 분석 PDF(studentFileId 대상)는 절대 건드리지 않는다.
async function rotateAcademyKey(oldFileId) {
  const entry = S.roster.academies.find((a) => a.fileId === oldFileId);
  const blob = S.academies.get(oldFileId);
  const oldKey = await importAesKeyB64(entry.key);
  const newFileId = randomHexId(16);
  const newKey = randomKeyB64();

  // 기존 자료를 평문으로 확보해 새 키 대상으로 재스테이징
  // (미발행 업로드는 이미 평문으로 메모리에 있음)
  for (const m of blob.materials || []) {
    const pending = S.pendingUploads.get(m.path);
    let plain;
    if (pending) {
      plain = pending.bytes;
      S.pendingUploads.delete(m.path);
    } else {
      const encBuf = await fetchBytes(m.path);
      plain = new Uint8Array(await decryptBytes(oldKey, encBuf));
      S.pendingDeletes.add(m.path);
    }
    m.path = `data/m/${randomHexId(16)}.bin`;
    S.pendingUploads.set(m.path, { bytes: plain, academyFileId: newFileId });
  }

  S.pendingDeletes.add(`data/a/${oldFileId}.json`);
  S.academies.delete(oldFileId);
  S.academies.set(newFileId, blob);
  S.dirtyAcademies.delete(oldFileId);
  entry.fileId = newFileId;
  entry.key = newKey;

  // 이 학원 대상으로 대기 중이던 자료실 업로드만 새 키 대상으로 이전
  for (const [, up] of S.pendingUploads) {
    if (up.academyFileId === oldFileId) up.academyFileId = newFileId;
  }
  // 소속 학생 전원 재암호화 대상 (blob.academy는 발행 시 roster 기준으로 동기화)
  for (const st of S.roster.students) {
    if (st.academyFileId === oldFileId) {
      st.academyFileId = newFileId;
      S.dirtyStudents.add(st.fileId);
    }
  }
  if (S.selAcademy === oldFileId) S.selAcademy = newFileId;
  if (S.selWeek.has(oldFileId)) {
    S.selWeek.set(newFileId, S.selWeek.get(oldFileId));
    S.selWeek.delete(oldFileId);
  }
  S.dirtyAcademies.add(newFileId);
  markRoster();
}

// ---------- ② 점수 입력 ----------
function renderScoresTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "퀴즈 점수 입력" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }

  const students = activeStudentsOf(S.selAcademy);
  const maxIn = el("input", { type: "number", value: String(weekQuizMax(week)), min: "1", class: "cell-input", style: "width:90px" });

  // TSV 붙여넣기
  const tsv = el("textarea", {
    class: "tsv-area",
    placeholder: "엑셀에서 [이름] [점수] 두 열을 복사해 붙여넣으세요.\n예)\n김철수\t85\n이영희\t92",
  });
  const warn = el("p", { class: "error-text" });

  // 점수 입력 표
  const inputs = new Map(); // fileId -> input
  const avgLine = el("p", { class: "hint" });
  const tbl = el("table", { class: "grid" });
  tbl.appendChild(
    el("tr", {}, [el("th", { class: "name-cell", text: "이름" }), el("th", { text: "점수" })])
  );
  for (const st of students) {
    const cur = S.students.get(st.fileId)?.weeks?.[week.id]?.quiz;
    const input = el("input", {
      type: "number",
      class: "cell-input",
      value: cur ? String(cur.score) : "",
      min: "0",
      oninput: updateAvg,
    });
    inputs.set(st.fileId, input);
    tbl.appendChild(
      el("tr", {}, [el("td", { class: "name-cell", text: st.name }), el("td", {}, [input])])
    );
  }

  function updateAvg() {
    const vals = [...inputs.values()].map((i) => parseFloat(i.value)).filter((v) => !isNaN(v));
    avgLine.textContent = vals.length
      ? `응시 ${vals.length}명 · 평균 ${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)}점`
      : "입력된 점수가 없습니다.";
  }
  updateAvg();

  tsv.addEventListener("input", () => {
    warn.textContent = "";
    const unmatched = [];
    const lines = tsv.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      let [name, score] = line.includes("\t") ? line.split("\t") : line.split(/\s+/);
      name = (name || "").trim();
      const num = parseFloat(score);
      if (!name || isNaN(num)) continue;
      const matches = students.filter((s) => s.name === name);
      if (matches.length === 1) {
        inputs.get(matches[0].fileId).value = String(num);
      } else {
        unmatched.push(name + (matches.length > 1 ? " (동명이인)" : ""));
      }
    }
    if (unmatched.length) {
      warn.textContent = `자동 매칭 안 됨 → 아래 표에서 직접 입력하세요: ${[...new Set(unmatched)].join(", ")}`;
    }
    updateAvg();
  });

  card.appendChild(el("label", { class: "field" }, [el("span", { text: "엑셀에서 붙여넣기 (이름 ⇥ 점수)" }), tsv]));
  card.appendChild(warn);
  card.appendChild(
    el("div", { class: "toolbar" }, [el("span", { text: "만점:" }), maxIn, avgLine])
  );
  card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  card.appendChild(
    el("button", {
      class: "btn btn-primary btn-block",
      style: "margin-top:12px",
      text: "이 주차 점수 저장",
      onclick: () => {
        const max = parseFloat(maxIn.value) || 100;
        let changed = 0;
        for (const st of students) {
          const raw = inputs.get(st.fileId).value.trim();
          const blob = S.students.get(st.fileId);
          blob.weeks[week.id] = blob.weeks[week.id] || {};
          if (raw === "") {
            if (blob.weeks[week.id].quiz) {
              delete blob.weeks[week.id].quiz;
              markStudent(st.fileId);
              changed++;
            }
          } else {
            const score = parseFloat(raw);
            const prev = blob.weeks[week.id].quiz;
            if (!prev || prev.score !== score || prev.max !== max) {
              blob.weeks[week.id].quiz = { score, max };
              markStudent(st.fileId);
              changed++;
            }
          }
        }
        recomputeStats(S.selAcademy);
        toast(`저장되었습니다 (${changed}명 변경). '발행'해야 사이트에 반영됩니다.`, "ok");
      },
    })
  );
  container.appendChild(card);
}

function weekQuizMax(week) {
  // 이 주차에 이미 입력된 점수의 만점(없으면 100)
  for (const st of S.roster.students) {
    const q = S.students.get(st.fileId)?.weeks?.[week.id]?.quiz;
    if (q?.max) return q.max;
  }
  return 100;
}

function recomputeStats(academyFileId) {
  const blob = S.academies.get(academyFileId);
  if (!blob) return;
  for (const w of blob.weeks) {
    const scores = activeStudentsOf(academyFileId)
      .map((st) => S.students.get(st.fileId)?.weeks?.[w.id]?.quiz)
      .filter(Boolean);
    const prev = JSON.stringify(w.quizStats || null);
    w.quizStats = scores.length
      ? {
          avg: Math.round((scores.reduce((a, q) => a + q.score, 0) / scores.length) * 10) / 10,
          count: scores.length,
          max: scores[0].max,
        }
      : null;
    if (JSON.stringify(w.quizStats) !== prev) markAcademy(academyFileId);
  }
}

// ---------- ③ 숙제 체크 ----------
function renderHomeworkTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "숙제 체크" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  week.homework = week.homework || [];

  // 숙제 항목 편집
  const itemsBox = el("div");
  const renderItems = () => {
    clear(itemsBox);
    for (const item of week.homework) {
      const input = el("input", {
        type: "text",
        value: item.text,
        onchange: (e) => {
          item.text = e.target.value.trim();
          markAcademy(S.selAcademy);
        },
      });
      itemsBox.appendChild(
        el("div", { class: "item-row" }, [
          input,
          el("button", {
            class: "btn btn-small btn-danger",
            text: "✕",
            "aria-label": "항목 삭제",
            onclick: async () => {
              const ok = await confirmModal({
                title: "숙제 항목 삭제",
                body: `'${item.text}' 항목을 삭제할까요? 학생들의 체크 기록도 함께 지워집니다.`,
                okText: "삭제",
                danger: true,
              });
              if (!ok) return;
              week.homework = week.homework.filter((x) => x.id !== item.id);
              for (const st of activeStudentsOf(S.selAcademy)) {
                const wd = S.students.get(st.fileId)?.weeks?.[week.id];
                if (wd?.homework && item.id in wd.homework) {
                  delete wd.homework[item.id];
                  markStudent(st.fileId);
                }
              }
              markAcademy(S.selAcademy);
              renderTab();
            },
          }),
        ])
      );
    }
    itemsBox.appendChild(
      el("button", {
        class: "btn btn-small",
        text: "+ 숙제 항목 추가",
        onclick: () => {
          const n = week.homework.reduce((m, i) => Math.max(m, parseInt(i.id.slice(2)) || 0), 0) + 1;
          week.homework.push({ id: `hw${n}`, text: "" });
          markAcademy(S.selAcademy);
          renderTab();
        },
      })
    );
  };
  renderItems();
  card.appendChild(itemsBox);

  // 체크 그리드
  if (week.homework.length) {
    const students = activeStudentsOf(S.selAcademy);
    const tbl = el("table", { class: "grid", style: "margin-top:12px" });
    const header = el("tr", {}, [el("th", { class: "name-cell", text: "이름" })]);
    week.homework.forEach((item, idx) => {
      const th = el("th", {}, [
        el("div", { text: `${idx + 1}번` }),
        el("button", {
          class: "btn btn-small",
          text: "전체 ✓",
          onclick: () => {
            for (const st of students) {
              const blob = S.students.get(st.fileId);
              blob.weeks[week.id] = blob.weeks[week.id] || {};
              blob.weeks[week.id].homework = blob.weeks[week.id].homework || {};
              if (!blob.weeks[week.id].homework[item.id]) {
                blob.weeks[week.id].homework[item.id] = true;
                markStudent(st.fileId);
              }
            }
            renderTab();
          },
        }),
      ]);
      header.appendChild(th);
    });
    tbl.appendChild(header);

    for (const st of students) {
      const row = el("tr", {}, [el("td", { class: "name-cell", text: st.name })]);
      for (const item of week.homework) {
        const blob = S.students.get(st.fileId);
        const checked = !!blob.weeks?.[week.id]?.homework?.[item.id];
        const btn = el("button", {
          class: `cell-toggle ${checked ? "on" : ""}`,
          text: checked ? "✓" : "",
          onclick: () => {
            blob.weeks[week.id] = blob.weeks[week.id] || {};
            blob.weeks[week.id].homework = blob.weeks[week.id].homework || {};
            const now = !blob.weeks[week.id].homework[item.id];
            blob.weeks[week.id].homework[item.id] = now;
            btn.classList.toggle("on", now);
            btn.textContent = now ? "✓" : "";
            markStudent(st.fileId);
          },
        });
        row.appendChild(el("td", {}, [btn]));
      }
      tbl.appendChild(row);
    }
    card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  }

  card.appendChild(
    el("button", {
      class: "btn btn-block",
      style: "margin-top:12px",
      text: "📋 카톡용 숙제 목록 복사",
      onclick: () => copyText(homeworkShareText(academyEntry().name, week)),
    })
  );
  container.appendChild(card);
}

// ---------- ④ 출석 ----------
function renderAttendanceTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "출석 체크" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  if (!(week.sessions || []).length) {
    card.appendChild(
      el("p", { class: "empty", text: "'주차 관리'에서 이 주차의 수업일을 먼저 입력해 주세요." })
    );
    container.appendChild(card);
    return;
  }
  card.appendChild(
    el("p", {
      class: "hint",
      text: "원하는 상태 버튼을 바로 누르세요. 선택된 칸을 다시 누르면 변경하거나 지울 수 있습니다.",
    })
  );
  const students = activeStudentsOf(S.selAcademy);
  const tbl = el("table", { class: "grid" });
  tbl.appendChild(
    el("tr", {}, [
      el("th", { class: "name-cell", text: "이름" }),
      ...week.sessions.map((d) => el("th", { text: d.slice(5).replace("-", "/") })),
    ])
  );
  for (const st of students) {
    const blob = S.students.get(st.fileId);
    const row = el("tr", {}, [el("td", { class: "name-cell", text: st.name })]);
    for (const d of week.sessions) {
      const td = el("td");
      let open = false; // 선택된 칸을 다시 눌러 선택기를 연 상태
      const get = () => blob.weeks?.[week.id]?.attendance?.[d] || "";
      const set = (code) => {
        blob.weeks[week.id] = blob.weeks[week.id] || {};
        blob.weeks[week.id].attendance = blob.weeks[week.id].attendance || {};
        if (code) blob.weeks[week.id].attendance[d] = code;
        else delete blob.weeks[week.id].attendance[d];
        markStudent(st.fileId);
      };
      const paint = () => {
        clear(td);
        const code = get();
        const info = ATTENDANCE[code]; // 알 수 없는 코드는 선택기로 처리
        if (code && info && !open) {
          // 선택됨: 큰 칩 하나 (클릭 → 선택기 재오픈)
          td.appendChild(
            el("button", {
              class: `cell-toggle att-cell ${info.cls}`,
              text: info.label,
              title: "누르면 변경할 수 있습니다",
              onclick: () => {
                open = true;
                paint();
              },
            })
          );
        } else {
          // 미선택/변경 중: 모든 상태를 작은 버튼으로 나열
          const chooser = el("div", { class: "att-chooser" });
          for (const c of ATTENDANCE_ORDER) {
            const o = ATTENDANCE[c];
            chooser.appendChild(
              el("button", {
                class: `att-opt att-cell ${o.cls}`,
                text: o.label,
                title: o.label,
                "aria-label": `${st.name} ${d} ${o.label}`,
                onclick: () => {
                  set(c);
                  open = false;
                  paint();
                },
              })
            );
          }
          if (code) {
            chooser.appendChild(
              el("button", {
                class: "att-opt",
                text: "–",
                title: "지우기",
                "aria-label": `${st.name} ${d} 지우기`,
                onclick: () => {
                  set("");
                  open = false;
                  paint();
                },
              })
            );
          }
          td.appendChild(chooser);
        }
      };
      paint();
      row.appendChild(td);
    }
    tbl.appendChild(row);
  }
  card.appendChild(el("div", { class: "table-wrap" }, [tbl]));
  container.appendChild(card);
}

// ---------- ⑤ 리포트 ----------
function renderReportsTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "주간 리포트 작성" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  const students = activeStudentsOf(S.selAcademy);
  if (!students.length) {
    card.appendChild(el("p", { class: "empty", text: "학생이 없습니다." }));
    container.appendChild(card);
    return;
  }
  let idx = 0;
  const who = el("div", { class: "who" });
  const count = el("div", { class: "char-count" });
  const ta = el("textarea", {
    rows: "6",
    placeholder: "학생/학부모에게 전달할 사항을 간단히 적어 주세요. 그대로 보입니다.",
  });

  // ---- 퀴즈 분석 PDF (학생 본인 키로 암호화 — 그 학생 코드로만 열림) ----
  const pdfBox = el("div");

  const removePdf = (st) => {
    const wd = S.students.get(st.fileId).weeks?.[week.id];
    const pdf = wd?.reportPdf;
    if (!pdf) return;
    if (S.pendingUploads.has(pdf.path)) S.pendingUploads.delete(pdf.path);
    else S.pendingDeletes.add(pdf.path);
    delete wd.reportPdf;
    markStudent(st.fileId);
  };

  const renderPdf = () => {
    clear(pdfBox);
    const st = students[idx];
    const wd = S.students.get(st.fileId).weeks?.[week.id] || {};
    const pdf = wd.reportPdf;
    if (pdf) {
      pdfBox.appendChild(
        el("div", { class: "material" }, [
          el("div", { class: "m-info" }, [
            el("div", {
              class: "m-title",
              text: `📊 ${pdf.origName}${S.pendingUploads.has(pdf.path) ? " (발행 대기)" : ""}`,
            }),
            el("div", { class: "m-meta", text: formatBytes(pdf.size) }),
          ]),
          el("div", { class: "m-actions" }, [
            el("button", {
              class: "btn btn-small btn-danger",
              text: "삭제",
              onclick: async () => {
                const ok = await confirmModal({
                  title: "분석 PDF 삭제",
                  body: `${st.name} 학생의 '${pdf.origName}'을(를) 삭제할까요?`,
                  okText: "삭제",
                  danger: true,
                });
                if (!ok) return;
                removePdf(st);
                renderPdf();
              },
            }),
          ]),
        ])
      );
    }
    const fileIn = el("input", { type: "file", accept: "application/pdf,.pdf" });
    const addBtn = el("button", {
      class: "btn btn-small btn-primary",
      text: pdf ? "PDF 교체" : "PDF 추가",
      onclick: async () => {
        const f = fileIn.files[0];
        if (!f) return toast("파일을 선택해 주세요.", "error");
        if (f.size > 90 * 1024 * 1024)
          return toast("90MB를 넘는 파일은 올릴 수 없습니다 (GitHub 제한).", "error");
        if (f.size > 25 * 1024 * 1024)
          toast("파일이 큽니다 — 업로드와 열람이 느릴 수 있습니다.", "error");
        const bytes = new Uint8Array(await f.arrayBuffer());
        removePdf(st); // 교체 시 기존 것 정리 (대기 중 → 맵 제거 / 발행됨 → 삭제 예약)
        const blob = S.students.get(st.fileId);
        blob.weeks[week.id] = blob.weeks[week.id] || {};
        const path = `data/m/${randomHexId(16)}.bin`;
        blob.weeks[week.id].reportPdf = {
          path,
          origName: f.name,
          size: f.size,
          mime: f.type || "application/pdf",
        };
        S.pendingUploads.set(path, { bytes, studentFileId: st.fileId });
        markStudent(st.fileId);
        toast("추가되었습니다. '발행'해야 학생이 볼 수 있습니다.", "ok");
        renderPdf();
      },
    });
    pdfBox.appendChild(el("div", { class: "toolbar" }, [fileIn, addBtn]));
  };

  const load = () => {
    const st = students[idx];
    who.textContent = `${st.name} (${idx + 1}/${students.length})`;
    ta.value = S.students.get(st.fileId)?.weeks?.[week.id]?.report || "";
    count.textContent = `${ta.value.length}자`;
    renderPdf();
  };
  const save = () => {
    const st = students[idx];
    const blob = S.students.get(st.fileId);
    const cur = blob.weeks?.[week.id]?.report || "";
    const next = ta.value;
    if (cur !== next) {
      blob.weeks[week.id] = blob.weeks[week.id] || {};
      if (next) blob.weeks[week.id].report = next;
      else delete blob.weeks[week.id].report;
      markStudent(st.fileId);
    }
  };
  ta.addEventListener("input", () => {
    count.textContent = `${ta.value.length}자`;
    save();
  });

  card.appendChild(
    el("div", { class: "report-nav" }, [
      el("button", {
        class: "btn btn-small",
        text: "← 이전",
        onclick: () => {
          save();
          idx = (idx - 1 + students.length) % students.length;
          load();
        },
      }),
      who,
      el("button", {
        class: "btn btn-small",
        text: "다음 →",
        onclick: () => {
          save();
          idx = (idx + 1) % students.length;
          load();
        },
      }),
    ])
  );
  card.appendChild(el("h3", { text: "퀴즈 분석 PDF", style: "font-size:15px;margin-top:8px" }));
  card.appendChild(
    el("p", { class: "hint", text: "이 학생의 접속 코드로만 열리도록 개별 암호화되어 올라갑니다." })
  );
  card.appendChild(pdfBox);
  card.appendChild(el("h3", { text: "전달 사항", style: "font-size:15px;margin-top:14px" }));
  card.appendChild(ta);
  card.appendChild(count);
  card.appendChild(el("p", { class: "hint", text: "입력하는 즉시 임시 저장됩니다. '발행'해야 사이트에 반영됩니다." }));
  load();
  container.appendChild(card);
}

// ---------- ⑥ 공지 ----------
function renderNoticesTab(container) {
  toolbar(container, { withWeek: false });
  const blob = academyBlob();
  const card = el("div", { class: "card" }, [el("h2", { text: `공지사항 — ${academyEntry().name}` })]);
  blob.notices = blob.notices || [];

  const form = (notice, onDone) => {
    const title = el("input", { type: "text", value: notice?.title || "", placeholder: "제목" });
    const date = el("input", { type: "date", value: notice?.date || toYMD(new Date()) });
    const body = el("textarea", { rows: "4", placeholder: "내용" });
    body.value = notice?.body || "";
    const pinned = el("input", { type: "checkbox", checked: !!notice?.pinned });
    return el("div", { class: "card", style: "padding:12px" }, [
      el("label", { class: "field" }, [el("span", { text: "제목" }), title]),
      el("label", { class: "field" }, [el("span", { text: "날짜" }), date]),
      el("label", { class: "field" }, [el("span", { text: "내용" }), body]),
      el("label", { class: "check" }, [pinned, "상단 고정"]),
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn btn-small", text: "취소", onclick: () => onDone(null) }),
        el("button", {
          class: "btn btn-primary btn-small",
          text: "저장",
          onclick: () => {
            if (!title.value.trim()) return toast("제목을 입력해 주세요.", "error");
            onDone({
              id: notice?.id || randomHexId(6),
              title: title.value.trim(),
              date: date.value,
              body: body.value,
              pinned: pinned.checked,
            });
          },
        }),
      ]),
    ]);
  };

  const list = el("div");
  const renderList = () => {
    clear(list);
    const sorted = [...blob.notices].sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.date || "").localeCompare(a.date || "");
    });
    if (!sorted.length) list.appendChild(el("p", { class: "empty", text: "등록된 공지가 없습니다." }));
    for (const n of sorted) {
      const row = el("div", { class: "notice" }, [
        el("div", { class: "notice-head" }, [
          n.pinned ? el("span", { class: "pin", text: "📌" }) : null,
          el("span", { class: "notice-title", text: n.title }),
          el("span", { class: "notice-date", text: n.date || "" }),
        ]),
        el("div", { class: "notice-body", text: n.body || "" }),
        el("div", { class: "toolbar" }, [
          el("button", {
            class: "btn btn-small",
            text: "수정",
            onclick: () => {
              const f = form(n, (result) => {
                if (result) {
                  Object.assign(n, result);
                  markAcademy(S.selAcademy);
                }
                renderList();
              });
              clear(list).appendChild(f);
            },
          }),
          el("button", {
            class: "btn btn-small btn-danger",
            text: "삭제",
            onclick: async () => {
              const ok = await confirmModal({
                title: "공지 삭제",
                body: `'${n.title}' 공지를 삭제할까요?`,
                okText: "삭제",
                danger: true,
              });
              if (!ok) return;
              blob.notices = blob.notices.filter((x) => x.id !== n.id);
              markAcademy(S.selAcademy);
              renderTab();
            },
          }),
        ]),
      ]);
      list.appendChild(row);
    }
  };
  renderList();

  card.appendChild(
    el("button", {
      class: "btn btn-primary btn-small",
      text: "+ 새 공지",
      onclick: () => {
        const f = form(null, (result) => {
          if (result) {
            blob.notices.push(result);
            markAcademy(S.selAcademy);
          }
          renderTab();
        });
        clear(list).appendChild(f);
      },
    })
  );
  card.appendChild(list);
  container.appendChild(card);
}

// ---------- ⑦ 자료실 ----------
function renderMaterialsTab(container) {
  toolbar(container, { withWeek: false });
  const blob = academyBlob();
  blob.materials = blob.materials || [];
  const card = el("div", { class: "card" }, [el("h2", { text: `자료실 — ${academyEntry().name}` })]);

  // 업로드 폼
  const fileIn = el("input", { type: "file", accept: "application/pdf,.pdf" });
  const titleIn = el("input", { type: "text", placeholder: "자료 제목 (예: 화학 프린트 3)" });
  const weekSel = el("select");
  weekSel.appendChild(el("option", { value: "", text: "주차 미지정" }));
  for (const w of sortWeeks(blob.weeks)) weekSel.appendChild(el("option", { value: w.id, text: w.label }));

  card.appendChild(el("label", { class: "field" }, [el("span", { text: "PDF 파일" }), fileIn]));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "제목" }), titleIn]));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "주차" }), weekSel]));
  card.appendChild(
    el("button", {
      class: "btn btn-primary btn-small",
      text: "+ 추가",
      onclick: async () => {
        const f = fileIn.files[0];
        if (!f) return toast("파일을 선택해 주세요.", "error");
        if (f.size > 90 * 1024 * 1024) return toast("90MB를 넘는 파일은 올릴 수 없습니다 (GitHub 제한).", "error");
        if (f.size > 25 * 1024 * 1024) toast("파일이 큽니다 — 업로드와 열람이 느릴 수 있습니다.", "error");
        const bytes = new Uint8Array(await f.arrayBuffer());
        const id = randomHexId(16);
        const path = `data/m/${id}.bin`;
        blob.materials.push({
          id,
          weekId: weekSel.value || null,
          title: titleIn.value.trim() || f.name,
          path,
          origName: f.name,
          mime: f.type || "application/pdf",
          size: f.size,
        });
        S.pendingUploads.set(path, { bytes, academyFileId: S.selAcademy });
        markAcademy(S.selAcademy);
        toast("추가되었습니다. '발행'해야 학생들이 볼 수 있습니다.", "ok");
        renderTab();
      },
    })
  );

  // 목록
  const weekLabel = (id) => sortWeeks(blob.weeks).find((w) => w.id === id)?.label || "";
  if (!blob.materials.length) {
    card.appendChild(el("p", { class: "empty", text: "등록된 자료가 없습니다." }));
  }
  for (const m of blob.materials) {
    card.appendChild(
      el("div", { class: "material" }, [
        el("div", { class: "m-info" }, [
          el("div", { class: "m-title", text: m.title + (S.pendingUploads.has(m.path) ? " (발행 대기)" : "") }),
          el("div", { class: "m-meta", text: [weekLabel(m.weekId), formatBytes(m.size)].filter(Boolean).join(" · ") }),
        ]),
        el("div", { class: "m-actions" }, [
          el("button", {
            class: "btn btn-small btn-danger",
            text: "삭제",
            onclick: async () => {
              const ok = await confirmModal({
                title: "자료 삭제",
                body: `'${m.title}' 자료를 삭제할까요?`,
                okText: "삭제",
                danger: true,
              });
              if (!ok) return;
              blob.materials = blob.materials.filter((x) => x.id !== m.id);
              if (S.pendingUploads.has(m.path)) S.pendingUploads.delete(m.path);
              else S.pendingDeletes.add(m.path);
              markAcademy(S.selAcademy);
              renderTab();
            },
          }),
        ]),
      ])
    );
  }
  container.appendChild(card);
}

// ---------- ⑧ 진도 ----------
function renderProgressTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "수업 진도" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  const ta = el("textarea", { rows: "4", placeholder: "예) 화학: 몰 개념 ~ 몰 농도 / 물리: 등가속도 운동" });
  ta.value = week.progress || "";
  ta.addEventListener("input", () => {
    week.progress = ta.value;
    markAcademy(S.selAcademy);
  });
  card.appendChild(ta);
  card.appendChild(el("p", { class: "hint", text: "학생 포털의 '출석·진도' 탭에 표시됩니다." }));
  container.appendChild(card);
}

// ---------- ⑨ 원장님 보고서 ----------
function renderDirectorTab(container) {
  toolbar(container);
  const week = selectedWeek();
  const card = el("div", { class: "card" }, [el("h2", { text: "원장님 주간 수업 현황 보고서" })]);
  if (!week) {
    card.appendChild(el("p", { class: "empty", text: "'주차 관리'에서 먼저 주차를 만들어 주세요." }));
    container.appendChild(card);
    return;
  }
  card.appendChild(
    el("p", {
      class: "hint",
      text: "이 보고서는 저장소에 올라가지 않고 이 브라우저에서만 만들어집니다. PDF로 저장한 뒤 카톡·메일로 직접 보내세요.",
    })
  );

  const { checks, doc } = buildDirectorReport({
    academyName: academyEntry().name,
    weeks: academyBlob().weeks,
    weekId: week.id,
    students: activeStudentsOf(S.selAcademy).map((st) => ({
      name: st.name,
      blob: S.students.get(st.fileId),
    })),
    notices: academyBlob().notices,
    teacherName: S.roster.teacher?.name,
    dirty: dirtyCount() > 0,
  });

  // 누락 항목 검사 결과
  const panel = el("div", { class: "check-panel" });
  for (const c of checks) {
    const icon = c.level === "ok" ? "✅" : c.level === "warn" ? "⚠️" : "ℹ️";
    panel.appendChild(el("div", { class: `check-item ${c.level}`, text: `${icon} ${c.text}` }));
  }
  card.appendChild(panel);

  card.appendChild(
    el("button", {
      class: "btn btn-primary btn-block",
      text: "🖨️ PDF로 저장 (인쇄 창에서 '대상: PDF로 저장' 선택)",
      onclick: () => {
        const root = $("#print-root");
        clear(root);
        root.className = "print-report";
        root.appendChild(doc.cloneNode(true));
        window.print();
      },
    })
  );
  card.appendChild(el("div", { class: "table-wrap report-preview" }, [doc]));
  container.appendChild(card);
}

// ---------- ⑩ 발행 ----------
function renderPublishTab(container) {
  const card = el("div", { class: "card" }, [el("h2", { text: "발행" })]);
  card.appendChild(
    el("p", {
      class: "hint",
      text: "지금까지의 변경 사항을 암호화해서 GitHub 저장소에 올립니다. 올린 뒤 1~2분이면 사이트에 반영됩니다.",
    })
  );

  // 저장소 설정
  const guess = guessRepoFromLocation();
  const repo = S.roster.repo || (S.roster.repo = { owner: "", name: "", branch: "main" });
  if (!repo.owner && guess) Object.assign(repo, { owner: guess.owner, name: guess.repo });
  const ownerIn = el("input", { type: "text", value: repo.owner, placeholder: "GitHub 사용자명" });
  const nameIn = el("input", { type: "text", value: repo.name, placeholder: "저장소 이름" });
  const branchIn = el("input", { type: "text", value: repo.branch || "main" });
  const saveRepo = () => {
    if (repo.owner !== ownerIn.value.trim() || repo.name !== nameIn.value.trim() || repo.branch !== branchIn.value.trim()) {
      repo.owner = ownerIn.value.trim();
      repo.name = nameIn.value.trim();
      repo.branch = branchIn.value.trim() || "main";
      markRoster();
    }
  };

  // PAT
  const savedPAT = localStorage.getItem("shs.pat") || sessionStorage.getItem("shs.pat") || "";
  const patIn = el("input", { type: "password", value: savedPAT, placeholder: "github_pat_… (Contents 권한)" });
  const patPersist = el("input", { type: "checkbox", checked: !!localStorage.getItem("shs.pat") });

  const log = el("div", { class: "publish-log", text: "" });
  const logLine = (s) => {
    log.textContent += s + "\n";
    log.scrollTop = log.scrollHeight;
  };

  const publishBtn = el("button", { class: "btn btn-primary btn-block", text: "🚀 GitHub에 발행 (자동 커밋)" });
  publishBtn.addEventListener("click", async () => {
    saveRepo();
    const token = patIn.value.trim();
    if (!repo.owner || !repo.name) return toast("저장소 정보를 입력해 주세요.", "error");
    if (!token) return toast("PAT(개인 접근 토큰)를 입력해 주세요.", "error");
    if (patPersist.checked) {
      localStorage.setItem("shs.pat", token);
      sessionStorage.removeItem("shs.pat");
    } else {
      sessionStorage.setItem("shs.pat", token);
      localStorage.removeItem("shs.pat");
    }
    publishBtn.disabled = true;
    log.textContent = "";
    try {
      logLine("데이터 암호화 중…");
      const { files, deletes } = await buildPublishFiles("api");
      const stamp = toYMD(new Date());
      const { commitSha } = await publishToGitHub({
        owner: repo.owner,
        repo: repo.name,
        branch: repo.branch || "main",
        token,
        files,
        deletes,
        message: `발행: ${stamp}`,
        onProgress: (_step, detail) => logLine(detail),
      });
      clearDirty();
      logLine(`완료! 커밋 ${commitSha.slice(0, 7)} — 1~2분 뒤 사이트에 반영됩니다.`);
      toast("발행 완료!", "ok");
    } catch (e) {
      console.error(e);
      logLine("오류: " + e.message);
      toast(e.message, "error");
    }
    publishBtn.disabled = false;
    updateBadge();
  });

  const zipBtn = el("button", { class: "btn btn-block", text: "📦 ZIP 다운로드 (수동 업로드용)" });
  zipBtn.addEventListener("click", async () => {
    saveRepo();
    zipBtn.disabled = true;
    try {
      const { files } = await buildPublishFiles("zip");
      const zipFiles = files.map((f) => ({ path: f.path, bytes: f.bytes }));
      const stamp = toYMD(new Date()).replaceAll("-", "");
      downloadBlob(buildZip(zipFiles), `발행_${stamp}.zip`);
      S.zipDownloaded = true;
      logLine("ZIP이 저장되었습니다. 압축을 푼 뒤 GitHub 저장소 페이지에서 'Add file → Upload files'로 data 폴더를 끌어다 놓고 커밋하세요. (자세한 방법은 README 참고)");
    } catch (e) {
      console.error(e);
      toast(e.message, "error");
    }
    zipBtn.disabled = false;
  });

  const zipDoneBtn = el("button", { class: "btn btn-small", text: "수동 업로드를 완료했습니다 (변경 표시 지우기)" });
  zipDoneBtn.addEventListener("click", () => {
    clearDirty();
    updateBadge();
    toast("확인했습니다.", "ok");
  });

  card.appendChild(el("h3", { text: "저장소 정보", style: "font-size:15px" }));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "GitHub 사용자명(소유자)" }), ownerIn]));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "저장소 이름" }), nameIn]));
  card.appendChild(el("label", { class: "field" }, [el("span", { text: "브랜치" }), branchIn]));
  card.appendChild(el("h3", { text: "개인 접근 토큰 (PAT)", style: "font-size:15px;margin-top:14px" }));
  card.appendChild(
    el("p", {
      class: "hint",
      text: "GitHub → Settings → Developer settings → Fine-grained tokens에서 이 저장소만, Contents(Read and write) 권한으로 만든 토큰을 사용하세요. 토큰은 이 브라우저에만 저장되며 저장소에는 절대 올라가지 않습니다.",
    })
  );
  card.appendChild(el("label", { class: "field" }, [patIn]));
  card.appendChild(el("label", { class: "check" }, [patPersist, "이 브라우저에 토큰 저장 (개인 기기에서만 체크)"]));
  card.appendChild(publishBtn);
  card.appendChild(el("div", { style: "height:8px" }));
  card.appendChild(zipBtn);
  card.appendChild(el("div", { style: "height:8px" }));
  card.appendChild(zipDoneBtn);
  card.appendChild(log);
  container.appendChild(card);

  // 백업/비밀번호
  const card2 = el("div", { class: "card" }, [el("h2", { text: "백업 · 비밀번호" })]);
  card2.appendChild(
    el("button", {
      class: "btn btn-block",
      text: "💾 백업 다운로드 (평문 JSON — 안전한 곳에 보관)",
      onclick: async () => {
        if (dirtyCount() > 0) {
          const ok = await confirmModal({
            title: "발행 전 백업",
            body: "발행하지 않은 변경과 업로드 대기 파일(PDF 등)은 백업에 포함되지 않습니다. 먼저 '발행'한 뒤 백업하는 것을 권장합니다. 그래도 지금 백업할까요?",
            okText: "지금 백업",
          });
          if (!ok) return;
        }
        const backup = {
          v: S.meta.v,
          savedAt: new Date().toISOString(),
          meta: S.meta,
          roster: S.roster,
          academies: Object.fromEntries(S.academies),
          students: Object.fromEntries(S.students),
        };
        const stamp = toYMD(new Date()).replaceAll("-", "");
        downloadBlob(
          new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }),
          `학원포털백업_${stamp}.json`
        );
        toast("백업은 암호화되지 않은 파일입니다. 개인 컴퓨터에만 보관하세요.", "ok");
      },
    })
  );
  card2.appendChild(el("div", { style: "height:8px" }));
  card2.appendChild(
    el("button", {
      class: "btn btn-block",
      text: "🔑 마스터 비밀번호 변경",
      onclick: changeMasterPassword,
    })
  );
  container.appendChild(card2);
}

async function changeMasterPassword() {
  const pw1 = el("input", { type: "password" });
  const pw2 = el("input", { type: "password" });
  const err = el("p", { class: "error-text" });
  const overlay = el("div", { class: "modal-overlay" });
  overlay.appendChild(
    el("div", { class: "modal" }, [
      el("h3", { text: "마스터 비밀번호 변경" }),
      el("label", { class: "field" }, [el("span", { text: "새 비밀번호 (12자 이상)" }), pw1]),
      el("label", { class: "field" }, [el("span", { text: "확인" }), pw2]),
      err,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn", text: "취소", onclick: () => overlay.remove() }),
        el("button", {
          class: "btn btn-primary",
          text: "변경",
          onclick: async () => {
            const p = normalizePassword(pw1.value);
            if (p.length < 12) return (err.textContent = "12자 이상이어야 합니다.");
            if (p !== normalizePassword(pw2.value)) return (err.textContent = "일치하지 않습니다.");
            S.meta.saltMaster = randomSaltB64();
            S.masterKey = await deriveMasterKey(p, S.meta.saltMaster, S.meta.kdf.iterMaster);
            markRoster();
            overlay.remove();
            toast("변경되었습니다. '발행'해야 적용됩니다.", "ok");
          },
        }),
      ]),
    ])
  );
  document.body.appendChild(overlay);
}

// ---------- 발행 파이프라인 ----------
function clearDirty() {
  S.dirtyStudents.clear();
  S.dirtyAcademies.clear();
  S.rosterDirty = false;
  S.pendingUploads.clear();
  S.pendingDeletes.clear();
  S.zipDownloaded = false;
}

// mode: "api" → 변경분만(base64) + 삭제 목록 / "zip" → 전체 파일(bytes)
async function buildPublishFiles(mode) {
  const enc = new TextEncoder();
  const all = mode === "zip";

  // 1) 학생 blob의 academy 정보를 roster 기준으로 동기화 (키 교체 반영)
  for (const st of S.roster.students) {
    const aEntry = S.roster.academies.find((a) => a.fileId === st.academyFileId);
    const blob = S.students.get(st.fileId);
    if (!blob || !aEntry) continue;
    const cur = blob.academy || {};
    if (cur.fileId !== aEntry.fileId || cur.key !== aEntry.key || cur.name !== aEntry.name) {
      blob.academy = { fileId: aEntry.fileId, key: aEntry.key, name: aEntry.name };
      S.dirtyStudents.add(st.fileId);
    }
    blob.name = st.name;
  }
  // 2) 반 평균 재계산
  for (const a of S.roster.academies) recomputeStats(a.fileId);

  // 3) meta 갱신
  S.meta.students = S.roster.students.map((s) => s.fileId);
  S.meta.academies = S.roster.academies.map((a) => a.fileId);
  S.meta.publishedAt = new Date().toISOString();

  const files = [];
  const push = (path, bytes) => {
    files.push({ path, bytes, base64: b64encode(bytes) });
  };
  const pushJSON = (path, obj) => push(path, enc.encode(JSON.stringify(obj, null, 1)));

  pushJSON("data/meta.json", S.meta);

  // roster (항상 포함: 작은 파일이고 일관성 보장)
  pushJSON("data/roster.json", await encryptJSON(S.masterKey, S.roster));

  for (const a of S.roster.academies) {
    if (!all && !S.dirtyAcademies.has(a.fileId)) continue;
    const key = await importAesKeyB64(a.key);
    pushJSON(`data/a/${a.fileId}.json`, await encryptJSON(key, S.academies.get(a.fileId)));
  }
  for (const st of S.roster.students) {
    if (!all && !S.dirtyStudents.has(st.fileId)) continue;
    const key = await importAesKeyB64(st.encKey);
    pushJSON(`data/s/${st.fileId}.json`, await encryptJSON(key, S.students.get(st.fileId)));
  }
  for (const [path, up] of S.pendingUploads) {
    // 학생 대상(개인 분석 PDF) 또는 학원 대상(자료실) — 소유자를 못 찾으면
    // 조용히 건너뛰지 않고 발행을 중단한다 (무음 데이터 손실 방지)
    const encKeyB64 = up.studentFileId
      ? S.roster.students.find((s) => s.fileId === up.studentFileId)?.encKey
      : S.roster.academies.find((a) => a.fileId === up.academyFileId)?.key;
    if (!encKeyB64) {
      throw new Error(`업로드 파일의 소유자를 찾을 수 없습니다 (${path}). 발행이 중단되었습니다.`);
    }
    const key = await importAesKeyB64(encKeyB64);
    push(path, new Uint8Array(await encryptBytes(key, up.bytes)));
  }

  return { files, deletes: [...S.pendingDeletes] };
}
