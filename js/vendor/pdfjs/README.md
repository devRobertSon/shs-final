# pdf.js (vendored)

- 출처: Mozilla pdf.js — https://mozilla.github.io/pdf.js/
- 패키지: `pdfjs-dist@6.3.289` (npm), **legacy 빌드** (구형 모바일 브라우저 지원)
- 라이선스: Apache License 2.0 (`LICENSE` 파일 참조) — 원본 그대로, 수정 없음
- 용도: PDF 내장 뷰어가 없는 모바일 브라우저에서 리포트·자료실 파일 '보기'를
  포털 페이지 안에서 직접 렌더링 (`js/pdfviewer.js`가 동적 import로 사용)
- 구성: `pdf.min.mjs`(본체) / `pdf.worker.min.mjs`(워커) /
  `cmaps/`(한중일 글꼴 매핑) / `standard_fonts/`(PDF 기본 14종 글꼴) /
  `wasm/`(JPEG2000·ICC 디코더) / `iccs/`(색 프로파일)
- 이 폴더는 저장소의 "외부 의존성 금지" 제약의 **승인된 예외**다 (2026-09-09,
  모바일 '보기' 기능을 위해 사용자 승인). 업데이트할 때는 같은 npm 패키지의
  legacy 빌드에서 위 파일들을 그대로 교체하고 이 문서의 버전을 갱신한다.
