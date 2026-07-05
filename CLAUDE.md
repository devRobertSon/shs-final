# CLAUDE.md

이 저장소에서 Claude가 작업할 때 따라야 하는 규칙과 개발 가이드.

## 브랜치 / PR 작업 규칙 (사용자 지정 — 반드시 준수)

사용자는 **PR을 merge한 뒤 작업 브랜치를 삭제**한다. 따라서 모든 작업은 다음 절차를 따른다:

1. **작업 시작 전** `git ls-remote origin`으로 원격에 작업 브랜치가 남아 있는지 확인한다.
2. **브랜치가 삭제된 경우** (= 이전 PR이 merge됨):
   - 최신 main을 기준으로 브랜치를 새로 만든다:
     `git fetch origin main && git checkout -B <작업브랜치명> origin/main`
   - 작업 → 커밋 → 푸시 → **main 대상 새 PR 생성**까지 완료한다.
3. **브랜치가 남아 있는 경우** (= 이전 PR이 아직 merge되지 않음):
   - 그 브랜치 위에 커밋을 추가하고 푸시한다 (열려 있는 기존 PR에 자동 반영됨).
   - 열린 PR이 없으면 그 브랜치로 main 대상 PR을 새로 만든다.
4. 작업이 끝나면 **항상 main 대상 PR이 존재하는 상태**로 마무리한다.
5. 이미 merge된 PR/히스토리 위에 새 커밋을 쌓지 않는다.

## 프로젝트 개요

과학고 대비반(두 학원, 약 20명) 학생/학부모용 **클라이언트 사이드 암호화 정적 포털**.
GitHub Pages(main 브랜치, `Deploy from a branch`)로만 배포하며 **서버·빌드·Actions·외부 유료 서비스가 없다**.

- `index.html` — 학생/학부모 포털 (접속 코드 로그인 → 숙제/퀴즈 그래프/리포트/공지/자료실/출석·진도)
- `admin.html` — 선생님 관리 페이지 (마스터 비밀번호 → 편집 → 발행)
- 모든 학생 데이터는 브라우저에서 AES-256-GCM으로 암호화되어 `data/`에 커밋된다.
  public 저장소를 열어봐도 암호문·무작위 파일명만 보여야 한다 (핵심 보안 요구사항).
- 키 유도: PBKDF2-SHA256(학생 31만 회 / 마스터 60만 회) → HKDF로 파일ID·AES키 분리 (`js/crypto.js`)
- 학원별 키 분리: A학원 학생은 B학원 공지/자료를 복호화할 수 없어야 한다.
- 학생 삭제 시 소속 학원 키 자동 교체(rotation)가 유지되어야 한다 (`js/admin.js`).

## 제약 (변경 금지)

- 순수 HTML/CSS/JS (ES 모듈). 빌드 도구·프레임워크·CDN·npm 의존성 금지.
- `js/crypto.js`는 브라우저와 Node 22+ 양쪽에서 동작해야 한다 (`globalThis.crypto` 사용, `window` 참조 금지) — 샘플 생성기가 Node에서 같은 모듈을 사용한다.
- 데이터 fetch는 `cache: "no-store"` + 타임스탬프 쿼리를 유지한다 (Pages CDN 캐시 회피).
- 모바일 우선: 320px 폭까지 페이지 가로 넘침이 없어야 한다. 넓은 표는 `.table-wrap` 내부 스크롤 사용.

## 로컬 실행 / 테스트

```bash
python3 -m http.server 8000        # http://localhost:8000 (file://는 WebCrypto 불가)
# 암호화 셀프테스트: http://localhost:8000/dev/test.html (전부 PASS여야 함)
node dev/make-sample.mjs           # 샘플 데이터 재생성 (코드는 dev/SAMPLE.md에 기록됨)
```

- 샘플 관리자 비밀번호와 학생 테스트 코드: `dev/SAMPLE.md`
- 암호화 관련 코드를 수정하면 반드시 `dev/test.html` 통과 + 샘플 데이터로
  학생 로그인 라운드트립(로그인→6개 탭 표시)을 확인한 뒤 커밋한다.
