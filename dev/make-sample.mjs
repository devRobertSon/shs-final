// make-sample.mjs — QA용 샘플(가상 학생) 데이터셋 생성기
// ⚠️ 경고: 이 스크립트는 data/ 폴더를 삭제 후 재생성한다.
//    실운영 저장소 체크아웃에서 절대 실행 금지 (실제 발행 데이터가 사라진다!).
//    QA는 반드시 저장소를 스크래치 폴더에 복사한 뒤 그 안에서 실행할 것.
// 실제 crypto.js를 그대로 사용하므로 브라우저 복호화와 100% 호환된다.
// 생성된 코드/비밀번호는 dev/SAMPLE.md에 기록된다.

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORMAT_VERSION,
  ITER_STUDENT,
  ITER_MASTER,
  generateCode,
  deriveStudentKeys,
  deriveMasterKey,
  exportAesKeyB64,
  encryptJSON,
  encryptBytes,
  randomSaltB64,
  randomKeyB64,
  randomHexId,
} from "../js/crypto.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

const MASTER_PASSWORD = "sample-master-password-123";
const SITE_TITLE = "과학고 대비 학습 포털 (샘플)";

// 전부 가상의 인물/학원입니다.
const ACADEMIES = [
  {
    name: "한빛학원",
    students: ["김하늘", "이도윤", "박서연", "최지호", "정유나"],
    weeks: [
      { id: "2026-W24", label: "6월 2주차 (6/8~6/14)", sessions: ["2026-06-09", "2026-06-12"] },
      { id: "2026-W25", label: "6월 3주차 (6/15~6/21)", sessions: ["2026-06-16", "2026-06-19"] },
      { id: "2026-W26", label: "6월 4주차 (6/22~6/28)", sessions: ["2026-06-23", "2026-06-26"] },
      { id: "2026-W27", label: "7월 1주차 (6/29~7/5)", sessions: ["2026-06-30", "2026-07-03"] },
    ],
    scores: {
      "2026-W24": [82, 91, 75, 88, 95],
      "2026-W25": [85, 88, 78, 92, 90],
      "2026-W26": [79, 94, null, 85, 97],
      "2026-W27": [88, 90, 82, 91, 93],
    },
  },
  {
    name: "미래학원",
    students: ["강민준", "조수아", "윤재원", "임하은", "한시우"],
    weeks: [
      { id: "2026-W25", label: "6월 3주차 (6/15~6/21)", sessions: ["2026-06-17", "2026-06-20"] },
      { id: "2026-W26", label: "6월 4주차 (6/22~6/28)", sessions: ["2026-06-24", "2026-06-27"] },
      { id: "2026-W27", label: "7월 1주차 (6/29~7/5)", sessions: ["2026-07-01", "2026-07-04"] },
    ],
    scores: {
      "2026-W25": [70, 95, 84, 88, null],
      "2026-W26": [75, 92, 80, 91, 85],
      "2026-W27": [81, 96, 85, 94, 89],
    },
  },
];

const HOMEWORK = [
  { id: "hw1", text: "물리 문제집 p.42~48 풀기" },
  { id: "hw2", text: "화학 오답노트 정리" },
  { id: "hw3", text: "지난 퀴즈 틀린 문제 다시 풀기" },
];

// ---------- 최소 유효 PDF 생성 ----------
function makeSamplePDF(title) {
  const objs = [];
  objs.push("<</Type/Catalog/Pages 2 0 R>>");
  objs.push("<</Type/Pages/Kids[3 0 R]/Count 1>>");
  objs.push(
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>"
  );
  const text = `BT /F1 20 Tf 72 720 Td (${title}) Tj ET`;
  objs.push(`<</Length ${text.length}>>\nstream\n${text}\nendstream`);
  objs.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

// ---------- 생성 ----------
async function main() {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(path.join(dataDir, "s"), { recursive: true });
  await mkdir(path.join(dataDir, "a"), { recursive: true });
  await mkdir(path.join(dataDir, "m"), { recursive: true });

  const saltStudent = randomSaltB64();
  const saltMaster = randomSaltB64();
  const masterKey = await deriveMasterKey(MASTER_PASSWORD, saltMaster, ITER_MASTER);

  const rosterAcademies = [];
  const rosterStudents = [];
  const sampleLines = [];

  for (const A of ACADEMIES) {
    const aEntry = { fileId: randomHexId(16), key: randomKeyB64(), name: A.name };
    rosterAcademies.push(aEntry);
    const { importAesKeyB64 } = await import("../js/crypto.js");
    const aKey = await importAesKeyB64(aEntry.key);

    // 자료실: 샘플 PDF 1개
    const pdfBytes = makeSamplePDF(`${A.name} - Sample Handout`);
    const mId = randomHexId(16);
    const mPath = `data/m/${mId}.bin`;
    const encPdf = new Uint8Array(await encryptBytes(aKey, pdfBytes));
    await writeFile(path.join(root, mPath), encPdf);

    // 학원 blob
    const weeks = A.weeks.map((w, wi) => {
      const scores = (A.scores[w.id] || []).filter((s) => s != null);
      return {
        ...w,
        homework: HOMEWORK.slice(0, 2 + (wi % 2)),
        progress: wi % 2 === 0 ? "화학: 몰 개념 ~ 몰 농도" : "물리: 등가속도 운동 ~ 자유낙하",
        quizStats: scores.length
          ? {
              avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
              count: scores.length,
              max: 100,
            }
          : null,
      };
    });
    const academyBlob = {
      v: FORMAT_VERSION,
      name: A.name,
      weeks,
      notices: [
        {
          id: randomHexId(6),
          date: "2026-07-01",
          title: "7월 수업 안내",
          body: "7월부터 실험 단원이 시작됩니다. 실험 노트를 준비해 주세요.",
          pinned: true,
        },
        {
          id: randomHexId(6),
          date: "2026-06-20",
          title: "모의고사 일정",
          body: "6월 마지막 주에 과학고 대비 모의고사를 진행합니다.",
          pinned: false,
        },
      ],
      materials: [
        {
          id: mId,
          weekId: weeks[weeks.length - 1].id,
          title: `${A.name} 샘플 유인물`,
          path: mPath,
          origName: "sample-handout.pdf",
          mime: "application/pdf",
          size: pdfBytes.length,
        },
      ],
    };
    await writeFile(
      path.join(root, `data/a/${aEntry.fileId}.json`),
      JSON.stringify(await encryptJSON(aKey, academyBlob), null, 1)
    );

    // 학생들
    for (let si = 0; si < A.students.length; si++) {
      const name = A.students[si];
      const code = generateCode();
      const { fileId, aesKey } = await deriveStudentKeys(code, saltStudent, ITER_STUDENT);
      const encKey = await exportAesKeyB64(aesKey);
      rosterStudents.push({ code, name, fileId, encKey, academyFileId: aEntry.fileId, active: true });
      sampleLines.push(`| ${A.name} | ${name} | \`${code}\` |`);

      const weeksData = {};
      A.weeks.forEach((w, wi) => {
        const score = (A.scores[w.id] || [])[si];
        const hwItems = HOMEWORK.slice(0, 2 + (wi % 2));
        const hw = {};
        hwItems.forEach((item, hi) => {
          hw[item.id] = (si + hi + wi) % 3 !== 0; // 적당히 섞인 체크 상태
        });
        const attendance = {};
        for (const [di, d] of w.sessions.entries()) {
          const k = si + di + wi;
          attendance[d] =
            k % 7 === 3 ? "L" : k % 11 === 5 ? "A" : k % 9 === 4 ? "E" : k % 13 === 6 ? "X" : "P";
        }
        weeksData[w.id] = {
          ...(score != null ? { quiz: { score, max: 100 } } : {}),
          homework: hw,
          attendance,
          // 마지막 두 주차에 전달사항 텍스트 (마지막 주차만 PDF 동반 → PDF 없는 케이스도 QA 가능)
          ...(wi >= A.weeks.length - 2
            ? {
                report: `${name} 학생은 이번 주 ${score != null ? `퀴즈에서 ${score}점을 받았습니다` : "퀴즈에 응시하지 않았습니다"}. 개념 이해는 좋으나 계산 실수를 줄이는 연습이 필요합니다. 다음 주에는 실험 단원 예습을 추천합니다.`,
              }
            : {}),
        };
      });

      // 마지막 주차에 개인 퀴즈 분석 PDF 샘플 (학생 본인 키로 암호화)
      const lastWeekId = A.weeks[A.weeks.length - 1].id;
      const analysisPdf = makeSamplePDF("Quiz Analysis Report");
      const pdfPath = `data/m/${randomHexId(16)}.bin`;
      await writeFile(
        path.join(root, pdfPath),
        new Uint8Array(await encryptBytes(aesKey, analysisPdf))
      );
      weeksData[lastWeekId].reportPdf = {
        path: pdfPath,
        origName: "quiz-analysis.pdf",
        mime: "application/pdf",
        size: analysisPdf.length,
      };

      const studentBlob = {
        v: FORMAT_VERSION,
        name,
        academy: { fileId: aEntry.fileId, key: aEntry.key, name: aEntry.name },
        weeks: weeksData,
      };
      await writeFile(
        path.join(root, `data/s/${fileId}.json`),
        JSON.stringify(await encryptJSON(aesKey, studentBlob), null, 1)
      );
    }
  }

  const meta = {
    v: FORMAT_VERSION,
    site: { title: SITE_TITLE },
    kdf: { algo: "PBKDF2-SHA256", iterStudent: ITER_STUDENT, iterMaster: ITER_MASTER },
    saltStudent,
    saltMaster,
    students: rosterStudents.map((s) => s.fileId),
    academies: rosterAcademies.map((a) => a.fileId),
    publishedAt: new Date().toISOString(),
  };
  await writeFile(path.join(dataDir, "meta.json"), JSON.stringify(meta, null, 1));

  const roster = {
    v: FORMAT_VERSION,
    teacher: { name: "샘플선생님" },
    repo: { owner: "", name: "", branch: "main" },
    siteURL: "",
    academies: rosterAcademies,
    students: rosterStudents,
  };
  await writeFile(
    path.join(dataDir, "roster.json"),
    JSON.stringify(await encryptJSON(masterKey, roster), null, 1)
  );

  const sampleMD = `# 샘플 데이터 안내 (QA용)

이 저장소에는 동작 확인용 **가상 학생 샘플 데이터**가 들어 있습니다.
등장하는 학원·학생은 모두 실존하지 않는 예시입니다.

실제로 사용하려면 \`admin.html\`에서 **초기 설정**을 실행하세요 —
샘플 데이터가 새 데이터로 교체됩니다.

## 관리자 (admin.html)

- 마스터 비밀번호: \`${MASTER_PASSWORD}\`

## 학생 접속 코드 (index.html)

| 학원 | 학생 | 접속 코드 |
|------|------|-----------|
${sampleLines.join("\n")}

> 이 파일은 \`node dev/make-sample.mjs\` 실행 시마다 새로 생성됩니다.
`;
  await writeFile(path.join(root, "dev/SAMPLE.md"), sampleMD);

  console.log("샘플 데이터 생성 완료");
  console.log(`학생 ${rosterStudents.length}명, 학원 ${rosterAcademies.length}곳`);
  console.log("코드 목록: dev/SAMPLE.md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
