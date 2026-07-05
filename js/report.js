// report.js — 원장님용 주간 수업 현황 보고서 생성 + 누락 항목 검사
// 보고서는 브라우저 메모리에서만 만들어지고 인쇄(PDF 저장)로만 나간다.
// 저장소에는 절대 커밋되지 않는다 (실명·점수 포함).
import { el } from "./ui.js";
import { sortWeeks, ATTENDANCE, ATTENDANCE_ORDER, toYMD } from "./store.js";

// 입력:
//   academyName, weeks(학원 blob의 weeks), weekId(보고 대상 주차 W),
//   students: [{name, blob}] (활성 학생, roster 순서), notices(학원 blob),
//   teacherName, dirty(발행 안 된 변경 존재 여부)
// 반환: { checks: [{level:'ok'|'warn'|'info', text}], doc: HTMLElement }
export function buildDirectorReport({
  academyName,
  weeks,
  weekId,
  students,
  notices,
  teacherName,
  dirty,
}) {
  const sorted = sortWeeks(weeks);
  const wIdx = sorted.findIndex((w) => w.id === weekId);
  const W = sorted[wIdx];
  const P = wIdx > 0 ? sorted[wIdx - 1] : null; // 저번 주차
  const PP = wIdx > 1 ? sorted[wIdx - 2] : null; // 전전 주차 (평균 변화 비교용)

  const checks = [];
  const warn = (text) => checks.push({ level: "warn", text });
  const info = (text) => checks.push({ level: "info", text });

  const doc = el("div", { class: "report-doc" });
  let secNo = 0;
  const section = (title, children) =>
    el("div", { class: "rd-section" }, [
      el("div", { class: "rd-sec-head" }, [
        el("span", { class: "rd-num", text: String(++secNo) }),
        el("h2", { text: title }),
      ]),
      ...children,
    ]);

  // ---------- 헤더 ----------
  const today = toYMD(new Date());
  doc.appendChild(
    el("div", { class: "rd-header" }, [
      el("div", { class: "rd-head-main" }, [
        el("span", { class: "rd-academy-chip", text: academyName }),
        el("h1", { text: "주간 수업 현황 보고서" }),
        el("div", {
          class: "rd-meta",
          text: `작성 ${teacherName || "담당 교사"} · 생성일 ${today}`,
        }),
      ]),
      el("div", { class: "rd-week-box" }, [
        el("div", { class: "rd-week-label", text: "보고 주차" }),
        el("div", { class: "rd-week", text: W.label }),
      ]),
    ])
  );

  // ---------- ① 수업 진도 (W) ----------
  const progress = (W.progress || "").trim();
  if (!progress) warn("이번 주 진도가 입력되지 않았습니다 ('진도' 탭에서 입력).");
  doc.appendChild(
    section("수업 진도", [
      progress
        ? el("p", { class: "rd-text rd-progress", text: progress })
        : el("p", { class: "rd-empty", text: "(입력되지 않음)" }),
    ])
  );

  // ---------- ② 출석 현황 (W) ----------
  const attChildren = [];
  const sessions = W.sessions || [];
  if (!sessions.length) {
    warn("이번 주 수업일이 등록되지 않았습니다 ('주차 관리'에서 입력).");
    attChildren.push(el("p", { class: "rd-empty", text: "(수업일 미등록)" }));
  } else {
    const missing = [];
    const tally = Object.fromEntries(ATTENDANCE_ORDER.map((c) => [c, 0]));
    let blank = 0;
    const tbl = el("table", { class: "rd-table" });
    tbl.appendChild(
      el("tr", {}, [
        el("th", { text: "이름" }),
        ...sessions.map((d) => el("th", { text: d.slice(5).replace("-", "/") })),
      ])
    );
    for (const s of students) {
      const att = s.blob.weeks?.[W.id]?.attendance || {};
      const row = el("tr", {}, [el("td", { class: "rd-name", text: s.name })]);
      for (const d of sessions) {
        const code = att[d];
        const a = ATTENDANCE[code];
        if (a) {
          tally[code]++;
          row.appendChild(
            el("td", {}, [el("span", { class: `rd-chip ${a.cls}`, text: a.label })])
          );
        } else {
          blank++;
          missing.push(`${s.name}(${d.slice(5).replace("-", "/")})`);
          row.appendChild(el("td", {}, [el("span", { class: "rd-dash", text: "–" })]));
        }
      }
      tbl.appendChild(row);
    }
    if (missing.length) warn(`출석 미입력: ${missing.join(", ")}`);
    const parts = ATTENDANCE_ORDER.filter((c) => tally[c] > 0).map(
      (c) => `${ATTENDANCE[c].label} ${tally[c]}`
    );
    if (blank) parts.push(`미입력 ${blank}`);
    attChildren.push(el("div", { class: "rd-table-wrap" }, [tbl]));
    attChildren.push(el("p", { class: "rd-note", text: parts.length ? `집계 · ${parts.join(" · ")}` : "기록 없음" }));
  }
  doc.appendChild(section("출석 현황", attChildren));

  // ---------- ③ 지난 주 숙제 수행 (P) ----------
  if (!P) {
    info("이전 주차가 없어 숙제·퀴즈 섹션은 표시되지 않습니다 (첫 주차).");
  } else {
    const hwChildren = [];
    const items = P.homework || [];
    if (!items.length) {
      warn(`지난 주(${P.label})에 등록된 숙제 항목이 없습니다.`);
      hwChildren.push(el("p", { class: "rd-empty", text: "(숙제 항목 없음)" }));
    } else {
      hwChildren.push(
        el("ol", { class: "rd-list" }, items.map((it) => el("li", { text: it.text })))
      );
      const tbl = el("table", { class: "rd-table" });
      tbl.appendChild(
        el("tr", {}, [
          el("th", { text: "이름" }),
          ...items.map((_, i) => el("th", { text: `${i + 1}번` })),
          el("th", { text: "완료율" }),
        ])
      );
      let doneAll = 0;
      for (const s of students) {
        const hw = s.blob.weeks?.[P.id]?.homework || {};
        const done = items.filter((it) => hw[it.id]).length;
        doneAll += done;
        const rate = Math.round((done / items.length) * 100);
        tbl.appendChild(
          el("tr", {}, [
            el("td", { class: "rd-name", text: s.name }),
            ...items.map((it) =>
              el("td", {}, [
                hw[it.id]
                  ? el("span", { class: "rd-check", text: "✓" })
                  : el("span", { class: "rd-dash", text: "–" }),
              ])
            ),
            el("td", { class: "rd-rate" }, [
              el("span", { class: "rd-bar", "aria-hidden": "true" }, [
                el("span", { class: "rd-bar-fill", style: `width:${rate}%` }),
              ]),
              el("span", { text: `${rate}%` }),
            ]),
          ])
        );
      }
      const totalRate = students.length
        ? Math.round((doneAll / (items.length * students.length)) * 100)
        : 0;
      hwChildren.push(el("div", { class: "rd-table-wrap" }, [tbl]));
      hwChildren.push(el("p", { class: "rd-note", text: `전체 완료율 · ${totalRate}%` }));
    }
    doc.appendChild(section(`지난 주 숙제 수행 — ${P.label}`, hwChildren));

    // ---------- ④ 지난 주 퀴즈 결과 + 자동 분석 (P) ----------
    const quizChildren = [];
    const scores = [];
    const noScore = [];
    const tbl = el("table", { class: "rd-table rd-quiz-table" });
    tbl.appendChild(el("tr", {}, [el("th", { text: "이름" }), el("th", { text: "점수" })]));
    let max = 100;
    for (const s of students) {
      const q = s.blob.weeks?.[P.id]?.quiz;
      if (q) {
        scores.push(q.score);
        max = q.max || max;
      } else noScore.push(s.name);
    }
    const hi = scores.length ? Math.max(...scores) : null;
    for (const s of students) {
      const q = s.blob.weeks?.[P.id]?.quiz;
      tbl.appendChild(
        el("tr", { class: q && q.score === hi ? "rd-top" : "" }, [
          el("td", { class: "rd-name", text: s.name }),
          el("td", { class: "rd-score", text: q ? String(q.score) : "–" }),
        ])
      );
    }
    if (noScore.length) warn(`지난 주 퀴즈 점수 미입력: ${noScore.join(", ")}`);

    if (scores.length) {
      const avg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
      const lo = Math.min(...scores);
      quizChildren.push(
        el("div", { class: "rd-stats" }, [
          statTile("반 평균", `${avg}점`),
          statTile("최고", `${hi}점`),
          statTile("최저", `${lo}점`),
          statTile("응시", `${scores.length}명`, `만점 ${max}점`),
        ])
      );
      quizChildren.push(el("div", { class: "rd-table-wrap" }, [tbl]));

      // 반 평균 추이 (P까지의 주차별 평균)
      const trendData = sorted.slice(0, wIdx).map((w) => ({
        label: String(w.label).replace(/\s*\(.*\)\s*/, ""),
        avg: weekAvg(w, students),
        isP: w.id === P.id,
      })).filter((d) => d.avg != null);
      if (trendData.length >= 2) {
        quizChildren.push(el("h3", { class: "rd-h3", text: "반 평균 추이" }));
        quizChildren.push(renderTrend(trendData, max));
      }

      let trend = "";
      if (PP) {
        const prevAvg = weekAvg(PP, students);
        if (prevAvg != null) {
          const diff = Math.round((avg - prevAvg) * 10) / 10;
          trend =
            diff > 0
              ? ` 전주 평균(${prevAvg}점)보다 ${diff}점 상승했습니다.`
              : diff < 0
                ? ` 전주 평균(${prevAvg}점)보다 ${Math.abs(diff)}점 하락했습니다.`
                : ` 전주 평균(${prevAvg}점)과 동일합니다.`;
        }
      }
      quizChildren.push(
        el("div", { class: "rd-callout" }, [
          el("strong", { text: "분석 " }),
          el("span", {
            text: `응시 인원 ${scores.length}명의 평균은 ${avg}점(만점 ${max}점)이며, 최고 ${hi}점 · 최저 ${lo}점으로 편차는 ${hi - lo}점입니다.${trend}`,
          }),
        ])
      );
    } else {
      warn(`지난 주(${P.label}) 퀴즈 점수가 하나도 입력되지 않았습니다.`);
      quizChildren.push(el("p", { class: "rd-empty", text: "(점수 없음)" }));
    }
    doc.appendChild(section(`지난 주 퀴즈 결과 — ${P.label}`, quizChildren));
  }

  // ---------- ⑤ 공지사항 (W 기간 + 고정) ----------
  const noticeChildren = [];
  const from = sessions.length ? sessions[0] : null;
  const to = sessions.length ? sessions[sessions.length - 1] : null;
  const included = (notices || []).filter(
    (n) => n.pinned || (from && to && n.date >= from && n.date <= to)
  );
  if (!included.length) {
    info("이 주차 기간에 해당하는 공지가 없습니다.");
    noticeChildren.push(el("p", { class: "rd-empty", text: "(해당 기간 공지 없음)" }));
  } else {
    for (const n of included) {
      noticeChildren.push(
        el("div", { class: "rd-notice" }, [
          el("div", { class: "rd-notice-title" }, [
            n.pinned ? el("span", { class: "rd-pin", text: "고정" }) : null,
            el("span", { text: n.title }),
            el("span", { class: "rd-notice-date", text: n.date || "" }),
          ]),
          n.body ? el("div", { class: "rd-text", text: n.body }) : null,
        ])
      );
    }
  }
  doc.appendChild(section("공지사항", noticeChildren));

  // ---------- 푸터 ----------
  doc.appendChild(
    el("div", { class: "rd-footer", text: `본 보고서는 학습 포털에서 자동 생성되었습니다 · ${today}` })
  );

  // ---------- 검사 결과 정리 ----------
  if (dirty) info("발행하지 않은 변경이 있습니다 — 보고서는 현재 편집 중인 내용 기준으로 생성됩니다.");
  if (!checks.some((c) => c.level === "warn")) {
    checks.unshift({ level: "ok", text: "모든 항목이 준비되었습니다. PDF로 저장해 보내세요." });
  }
  return { checks, doc };
}

function statTile(label, value, sub) {
  return el("div", { class: "rd-stat" }, [
    el("div", { class: "rd-stat-label", text: label }),
    el("div", { class: "rd-stat-value", text: value }),
    sub ? el("div", { class: "rd-stat-sub", text: sub }) : null,
  ]);
}

// 해당 주차의 반 평균 (quizStats 우선, 없으면 직접 계산)
function weekAvg(week, students) {
  if (week.quizStats?.avg != null) return week.quizStats.avg;
  const scores = students
    .map((s) => s.blob.weeks?.[week.id]?.quiz?.score)
    .filter((v) => v != null);
  if (!scores.length) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}

// 반 평균 추이 미니 차트 (단일 계열 — 제목이 곧 범례, 점 위 직접 라벨)
function renderTrend(data, maxScore) {
  const W = 360;
  const H = 110;
  const M = { top: 22, right: 18, bottom: 20, left: 18 };
  const n = data.length;
  const vals = data.map((d) => d.avg);
  const lo = Math.max(0, Math.min(...vals) - 8);
  const hi = Math.min(maxScore, Math.max(...vals) + 8);
  const x = (i) => M.left + (n === 1 ? (W - M.left - M.right) / 2 : (i / (n - 1)) * (W - M.left - M.right));
  const y = (v) => M.top + (H - M.top - M.bottom) * (1 - (v - lo) / Math.max(1, hi - lo));

  // 라벨: 6개 이하면 전부, 많으면 처음/끝/최고/최저만
  const labelIdx = new Set();
  if (n <= 6) for (let i = 0; i < n; i++) labelIdx.add(i);
  else {
    labelIdx.add(0);
    labelIdx.add(n - 1);
    labelIdx.add(vals.indexOf(Math.max(...vals)));
    labelIdx.add(vals.indexOf(Math.min(...vals)));
  }

  let s = `<line x1="${M.left - 6}" y1="${H - M.bottom}" x2="${W - M.right + 6}" y2="${H - M.bottom}" stroke="#c3c2b7" stroke-width="1"/>`;
  s += `<polyline points="${data.map((d, i) => `${x(i)},${y(d.avg)}`).join(" ")}" fill="none" stroke="#2a78d6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  data.forEach((d, i) => {
    s += `<circle cx="${x(i)}" cy="${y(d.avg)}" r="${d.isP ? 4.5 : 3.5}" fill="#2a78d6" stroke="#ffffff" stroke-width="2"/>`;
    if (labelIdx.has(i)) {
      s += `<text x="${x(i)}" y="${y(d.avg) - 8}" text-anchor="middle" font-size="9.5" font-weight="${d.isP ? 700 : 400}" fill="#0b0b0b">${d.avg}</text>`;
    }
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    const every = Math.max(1, Math.ceil(n / 6));
    if (i % every === 0 || i === n - 1) {
      s += `<text x="${x(i)}" y="${H - M.bottom + 13}" text-anchor="${anchor}" font-size="9" fill="#898781">${escapeXML(d.label)}</text>`;
    }
  });

  const box = el("div", { class: "rd-chart" });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="주차별 반 평균 추이" style="width:100%;height:auto;display:block">${s}</svg>`;
  return box;
}

function escapeXML(t) {
  return String(t).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
