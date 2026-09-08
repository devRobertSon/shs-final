// chart.js — 순수 SVG 꺾은선 그래프 (본인 점수 vs 전체 평균 — 두 학원 합산)
// 외부 라이브러리 없음. 색 + 선 스타일(실선/점선) 이중 부호화로 색각 이상에도 안전.
import { el, clear } from "./ui.js";

const COLOR = {
  mine: "#2a6fd0", // series-1 blue
  avg: "#445062", // secondary ink (비교 기준선은 절제된 회색 점선)
  grid: "#e2e9f4",
  axis: "#c3cede",
  tick: "#76839a",
  surface: "#ffffff",
};

// weeks: [{id, label}], mine/avg: (number|null)[], yMax: number
// X축 라벨은 그리지 않는다 — 단원이 많으면 겹쳐 읽을 수 없어서,
// 점에 마우스를 올리거나(PC) 점/구간을 탭하면(모바일) 단원 이름과 점수가 팝업으로 뜬다.
// 내 점수와 전체 평균이 가까우면(겹쳐 보이면) 한 팝업에 단원·내 점수·평균 세 줄이 함께 나온다.
export function renderScoreChart(container, { weeks, mine, avg, yMax = 100 }) {
  clear(container);
  const n = weeks.length;
  if (!n || mine.every((v) => v == null)) {
    container.appendChild(
      el("p", { class: "empty", text: "아직 표시할 퀴즈 점수가 없습니다." })
    );
    return;
  }

  const W = 360;
  const M = { top: 14, right: 14, bottom: 12, left: 34 };
  const iw = W - M.left - M.right;
  const ih = 186;
  const H = M.top + ih + M.bottom;
  const x = (i) => M.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => M.top + ih - (Math.max(0, Math.min(v, yMax)) / yMax) * ih;

  let s = "";
  // 가로 그리드 (hairline, 5분할)
  const step = yMax / 5;
  for (let g = 0; g <= 5; g++) {
    const gy = y(g * step);
    s += `<line x1="${M.left}" y1="${gy}" x2="${W - M.right}" y2="${gy}" stroke="${
      g === 0 ? COLOR.axis : COLOR.grid
    }" stroke-width="1"/>`;
    s += `<text x="${M.left - 6}" y="${gy + 3.5}" text-anchor="end" font-size="10" fill="${
      COLOR.tick
    }">${Math.round(g * step)}</text>`;
  }

  // null이 끼면 선을 끊는다 (0으로 그리지 않음)
  const segments = (vals) => {
    const segs = [];
    let cur = [];
    vals.forEach((v, i) => {
      if (v == null) {
        if (cur.length) segs.push(cur);
        cur = [];
      } else cur.push([x(i), y(v)]);
    });
    if (cur.length) segs.push(cur);
    return segs;
  };
  const path = (segs, stroke, dash) =>
    segs
      .map((seg) =>
        seg.length === 1
          ? "" // 점 하나는 마커가 담당
          : `<polyline points="${seg.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${
              dash ? ` stroke-dasharray="${dash}"` : ""
            }/>`
      )
      .join("");

  s += path(segments(avg), COLOR.avg, "5 4");
  s += path(segments(mine), COLOR.mine, null);

  // 전체 평균 마커: 작은 점 (팝업 대상이 보이도록)
  avg.forEach((v, i) => {
    if (v == null) return;
    s += `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${COLOR.avg}" stroke="${COLOR.surface}" stroke-width="1.5"/>`;
  });
  // 본인 점수 마커: r=4 + 표면색 2px 링 (선 위에서도 또렷하게)
  mine.forEach((v, i) => {
    if (v == null) return;
    s += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${COLOR.mine}" stroke="${COLOR.surface}" stroke-width="2"/>`;
  });

  const svg = el("div", { class: "chart-svg" });
  svg.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="내 점수와 전체 평균 추이 그래프" style="width:100%;height:auto;display:block">${s}</svg>`;
  const svgEl = svg.querySelector("svg");

  // ---- 팝업 ----
  const tip = el("div", { class: "chart-tip" });
  svg.appendChild(tip);
  let tipKey = null;
  const hide = () => {
    tip.style.display = "none";
    tipKey = null;
  };
  // series: "mine" | "avg" | "both"(구간 탭)
  const show = (i, series) => {
    clear(tip);
    tip.appendChild(el("div", { class: "t", text: weeks[i].label }));
    // 내 점수와 평균이 화면에서 겹칠 만큼 가까우면 어느 점을 골라도 세 줄을 함께 보여준다
    const near = mine[i] != null && avg[i] != null && Math.abs(y(mine[i]) - y(avg[i])) <= 16;
    const wantMine = series !== "avg" || near;
    const wantAvg = series !== "mine" || near;
    if (wantMine) tip.appendChild(el("div", { text: mine[i] != null ? `내 점수 ${mine[i]}` : "내 점수 없음" }));
    if (wantAvg && avg[i] != null) tip.appendChild(el("div", { text: `전체 평균 ${avg[i]}` }));
    const anchor = series === "avg" ? avg[i] : mine[i] != null ? mine[i] : avg[i];
    const box = svg.getBoundingClientRect();
    const scale = box.width / W;
    const px = x(i) * scale;
    const py = y(anchor) * scale;
    tip.style.display = "block";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${Math.max(2, Math.min(box.width - tw - 2, px - tw / 2))}px`;
    tip.style.top = py - th - 10 < 0 ? `${py + 12}px` : `${py - th - 10}px`;
    tipKey = `${i}:${series}`;
  };

  // 히트 영역: 주차 세로 구간(모바일에서 누르기 쉬움) + 점별 원(PC 호버·정밀 탭)
  const NS = "http://www.w3.org/2000/svg";
  const hitLayer = document.createElementNS(NS, "g");
  const colHalf = n === 1 ? iw / 2 : iw / (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", x(i) - colHalf);
    r.setAttribute("y", M.top);
    r.setAttribute("width", colHalf * 2);
    r.setAttribute("height", ih);
    r.setAttribute("fill", "transparent");
    r.style.cursor = "pointer";
    r.addEventListener("click", (e) => {
      e.stopPropagation();
      if (tipKey === `${i}:both`) hide();
      else show(i, "both");
    });
    hitLayer.appendChild(r);
  }
  const addDotHit = (i, series, v) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", x(i));
    c.setAttribute("cy", y(v));
    c.setAttribute("r", "11");
    c.setAttribute("fill", "transparent");
    c.style.cursor = "pointer";
    c.addEventListener("mouseenter", () => show(i, series));
    c.addEventListener("mouseleave", hide);
    c.addEventListener("click", (e) => {
      e.stopPropagation();
      show(i, series);
    });
    hitLayer.appendChild(c);
  };
  avg.forEach((v, i) => v != null && addDotHit(i, "avg", v));
  mine.forEach((v, i) => v != null && addDotHit(i, "mine", v));
  svgEl.appendChild(hitLayer);
  svgEl.addEventListener("click", hide); // 여백을 누르면 닫기

  // 범례 (2계열 → 항상 표시, 텍스트는 잉크 색)
  const legend = el("div", { class: "chart-legend" }, [
    el("span", { class: "legend-item" }, [
      el("span", { class: "legend-swatch", html: legendLine(COLOR.mine, false) }),
      "내 점수",
    ]),
    el("span", { class: "legend-item" }, [
      el("span", { class: "legend-swatch", html: legendLine(COLOR.avg, true) }),
      "전체 평균",
    ]),
  ]);

  container.appendChild(svg);
  container.appendChild(legend);
  container.appendChild(
    el("div", {
      class: "chart-caption",
      text: "점에 마우스를 올리거나 그래프를 누르면 단원 이름과 점수가 나옵니다.",
    })
  );
}

// 점수 분포 히스토그램 (선생님 열람용): 만점 기준 10% 구간 막대
export function renderHistogram(container, { scores, max = 100 }) {
  clear(container);
  if (!scores.length) {
    container.appendChild(el("p", { class: "empty", text: "입력된 점수가 없습니다." }));
    return;
  }
  const buckets = new Array(10).fill(0);
  for (const s of scores) buckets[Math.min(9, Math.max(0, Math.floor((s / max) * 10)))]++;
  const peak = Math.max(...buckets);

  const W = 360;
  const H = 140;
  const M = { top: 16, right: 8, bottom: 20, left: 8 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const slot = iw / 10;
  const barW = Math.min(24, slot - 4);

  let s = `<line x1="${M.left}" y1="${H - M.bottom}" x2="${W - M.right}" y2="${H - M.bottom}" stroke="${COLOR.axis}" stroke-width="1"/>`;
  buckets.forEach((count, i) => {
    const bx = M.left + i * slot + (slot - barW) / 2;
    const bh = peak ? (count / peak) * (ih - 6) : 0;
    const by = H - M.bottom - bh;
    if (count > 0) {
      // 위쪽만 둥근 막대 (바닥은 각지게)
      const r = Math.min(4, bh);
      s += `<path d="M${bx},${H - M.bottom} L${bx},${by + r} Q${bx},${by} ${bx + r},${by} L${bx + barW - r},${by} Q${bx + barW},${by} ${bx + barW},${by + r} L${bx + barW},${H - M.bottom} Z" fill="${COLOR.mine}"/>`;
      s += `<text x="${bx + barW / 2}" y="${by - 4}" text-anchor="middle" font-size="10" fill="#16202e">${count}</text>`;
    }
    if (i % 2 === 0) {
      s += `<text x="${M.left + i * slot}" y="${H - M.bottom + 14}" text-anchor="middle" font-size="9" fill="${COLOR.tick}">${Math.round((i * max) / 10)}</text>`;
    }
  });
  s += `<text x="${W - M.right}" y="${H - M.bottom + 14}" text-anchor="end" font-size="9" fill="${COLOR.tick}">${max}</text>`;

  const box = el("div", { class: "chart-svg" });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="점수 분포 히스토그램" style="width:100%;height:auto;display:block">${s}</svg>`;
  container.appendChild(box);
}

function legendLine(color, dashed) {
  return `<svg viewBox="0 0 28 10" width="28" height="10" aria-hidden="true"><line x1="1" y1="5" x2="27" y2="5" stroke="${color}" stroke-width="2"${
    dashed ? ' stroke-dasharray="5 4"' : ""
  }/>${dashed ? "" : `<circle cx="14" cy="5" r="3.5" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>`}</svg>`;
}


