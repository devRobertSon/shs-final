// 내장 PDF 뷰어 — PDF를 새 탭에 표시하지 못하는 브라우저(모바일 대부분)용.
// Mozilla pdf.js(js/vendor/pdfjs, Apache-2.0)를 '보기'를 처음 눌렀을 때만 동적 로드해,
// 포털 첫 화면 로딩에는 영향이 없다. 실패하면 예외를 던져 호출부가 저장으로 폴백한다.
import { el } from "./ui.js";

const asset = (p) => new URL("./vendor/pdfjs/" + p, import.meta.url).href;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("./vendor/pdfjs/pdf.min.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = asset("pdf.worker.min.mjs");
      return lib;
    });
  }
  return pdfjsPromise;
}

// blob(PDF)을 전체 화면 오버레이로 표시. 페이지들은 화면 폭에 맞춰 차례로 그려진다.
export async function showPdfOverlay(blob, title) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    data: await blob.arrayBuffer(),
    cMapUrl: asset("cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts/"),
    wasmUrl: asset("wasm/"),
    iccUrl: asset("iccs/"),
  });
  const doc = await task.promise;

  const pages = el("div", { class: "pdfv-pages" });
  const closeBtn = el("button", { class: "btn btn-small pdfv-close", text: "✕ 닫기" });
  const overlay = el("div", { class: "pdfv" }, [
    el("div", { class: "pdfv-bar" }, [
      el("div", { class: "pdfv-title", text: title }),
      closeBtn,
    ]),
    pages,
  ]);
  let closed = false;
  const close = () => {
    closed = true;
    overlay.remove();
    document.body.classList.remove("pdfv-open");
    task.destroy();
  };
  closeBtn.addEventListener("click", close);
  document.body.appendChild(overlay);
  document.body.classList.add("pdfv-open");

  try {
    // 화면 폭 기준 크기, 선명도를 위해 기기 픽셀 비율만큼 크게 그린다
    const cssWidth = Math.min(pages.clientWidth - 16, 900);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (let n = 1; n <= doc.numPages; n++) {
      if (closed) return;
      const page = await doc.getPage(n);
      const scale = cssWidth / page.getViewport({ scale: 1 }).width;
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = el("canvas", { class: "pdfv-page" });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = Math.floor(vp.width / dpr) + "px";
      pages.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    }
  } catch (e) {
    if (!closed) close();
    throw e;
  }
}
