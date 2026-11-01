# OpenLMS

**OpenLMS**는 Canvas / LearningX 계열 대학 LMS의 강의자료를 **내 컴퓨터에** 동기화하고, 어떤 AI 클라이언트(Claude, Cursor 등)에서든 **강의자료 맥락으로 질문**할 수 있게 해 주는 로컬 도구입니다.

명령 하나(`openlms`)로 CLI, TUI, MCP 서버(stdio)를 모두 제공합니다.

- 활성 과목의 파일을 `~/.lms/`에 **증분 다운로드**
- PDF / PPTX / DOCX / 텍스트에서 **텍스트 추출** → SQLite **FTS5(trigram)** 인덱스 (한국어 부분 일치 검색 지원)
- 과제(마감순), 공지 캐시
- MCP 툴은 **로컬 캐시 우선**, 캐시에 없을 때만 LMS API 호출

## 보안·정책

| 항목 | 동작 |
| --- | --- |
| 인증 | 학생이 LMS에서 직접 발급한 **개인 액세스 토큰** |
| 저장 | base URL·토큰 모두 **OS 키체인**(macOS Keychain / Windows Credential Manager / Linux Secret Service). 평문 설정 파일 없음 |
| 전송 | 토큰은 LMS 호스트로만 전송. 리다이렉트(예: 파일 → S3/CDN)는 수동 추적하며 **다른 호스트에는 Authorization 헤더를 붙이지 않음**. 다른 호스트 URL로 토큰 요청 시 거부 |
| 프로토콜 | `https`만 허용 (localhost 제외) |
| 부하 | 요청 간 지연(기본 300ms), `per_page=100`, `Link` 헤더 페이지네이션 |
| 레이트 리밋 | `X-Rate-Limit-Remaining` < 100이면 **즉시 중단**, 429/5xx/rate-limit 403은 지수 백오프(1s→2s→4s→8s), **401은 재시도 안 함** |
| 범위 | **읽기 전용**(GET만). 성적·제출물 엔드포인트는 기본 **차단** (`--allow-grades`로만 해제) |

## 설치

Node.js **22.13 이상**이 필요합니다 (내장 `node:sqlite` 사용 — 네이티브 SQLite 빌드 불필요).

```bash
npm install -g openlms
```

소스에서 설치:

```bash
git clone https://github.com/ponycompute/openlms.git && cd openlms
npm install && npm run build && npm link
```

## 시작하기

### 1. 토큰 발급

LMS 웹 → **계정 → 설정 → 승인된 통합 → `+ 새 액세스 토큰`** 에서 토큰을 만듭니다. (학교에 따라 메뉴 이름이 조금 다를 수 있습니다.) 화면별 안내: [Canvas 액세스 토큰 발급 가이드](https://ponycompute.github.io/openlms/)

### 2. 로그인

```bash
openlms login
```

base URL(예: `https://canvas.ssu.ac.kr`)과 토큰을 입력하면 `/api/v1/users/self`로 검증한 뒤 키체인에 저장합니다.

### 3. 동기화

```bash
openlms sync
```

처음엔 모든 파일을 받고, 이후엔 `updated_at`/크기가 바뀐 파일만 다시 받습니다. LMS에서 사라진 파일은 로컬에서도 삭제됩니다. 학생에게 "파일" 탭이 숨겨진 과목은 **모듈에 올라온 파일**로 대신 수집합니다.

### LearningX 콘텐츠

많은 학교가 강의자료를 Canvas 파일이 아니라 **LearningX 콘텐츠**(외부 도구)로 올립니다. 기본적으로 OpenLMS는 이 콘텐츠를 **링크로** 보여 줍니다 (`openlms files --course ID`, TUI 주차학습, MCP `list_materials`). TUI에서는 `enter`로 브라우저에서 열 수 있습니다.

`--learningx`를 주면 LearningX의 **PDF 강의자료**도 받아서 인덱싱합니다 (기본 꺼짐):

```bash
openlms sync --learningx
```

Canvas의 문서화된 `sessionless_launch` API로 LearningX를 실행해 LearningX 세션을 받고, 그 세션으로 강의 목록을 읽습니다. Canvas 토큰은 LearningX나 콘텐츠 서버로 보내지 않으며, 세션은 메모리에만 두고 저장하지 않습니다. 다만 LearningX의 API는 공개 문서가 없어 예고 없이 바뀔 수 있고, 학교 이용 약관은 직접 확인하세요. 영상과 잠긴 항목은 받지 않습니다. 받은 파일은 `(LearningX)`로 표시됩니다.

`--learningx`로 받을 수 없는 자료(PPTX 등)는 브라우저에서 받아 직접 가져올 수 있습니다:

```bash
openlms import ~/Downloads/데이터베이스 --course 12345   # 폴더는 하위까지, PDF/PPTX/DOCX/텍스트만
```

가져온 파일은 음수 ID로 표시되고, Canvas 동기화로 지워지지 않습니다. 빼려면 `openlms unimport <fileId>`.

## 명령

| 명령 | 설명 |
| --- | --- |
| `openlms login [--url URL]` | base URL·토큰 입력, 검증 후 키체인 저장 |
| `openlms logout` | 키체인에서 자격 증명 삭제 |
| `openlms status` | 로그인 상태·캐시 요약 |
| `openlms sync [--course ID] [--learningx] [--metadata-only] [--max-size MB]` | 증분 다운로드 + 텍스트 추출 + 인덱싱 |
| `openlms courses` | 활성 과목 |
| `openlms files [--course ID]` | 강의자료 목록 (텍스트 추출 상태 포함). `--course`를 주면 LearningX 링크도 표시 |
| `openlms import <paths...> --course ID` | 직접 받은 파일·폴더를 과목에 가져와 인덱싱 |
| `openlms unimport <fileId>` | 가져온 파일을 인덱스에서 제거 |
| `openlms assignments [--course ID] [--upcoming] [--days N]` | 과제 (마감순) |
| `openlms announcements [--course ID] [--limit N]` | 최근 공지 |
| `openlms search <query...> [--course ID]` | 로컬 인덱스 전문 검색 |
| `openlms read <fileId>` | 자료의 추출 텍스트 출력 (없으면 즉시 받아서 추출) |
| `openlms tui` | 터미널 UI |
| `openlms mcp` | stdio MCP 서버 |

조회 명령은 모두 `--json`, `--refresh`(API에서 새로 가져오기)를 지원합니다. 전역 옵션: `--delay <ms>`, `--allow-grades`.

### TUI

```bash
openlms tui
```

학교 Canvas처럼 보이도록 만들었습니다. 왼쪽 글로벌 메뉴는 학교 브랜드 색, 과목 카드는 Canvas 대시보드에서 고른 색을 그대로 씁니다. 패널·탭·`[ OK ]` 태그·진행 막대는 ANSI(Tango) 팔레트의 터미널 UI 스타일을 따르고, 오른쪽 위에 마지막 동기화 상태를 보여 줍니다.

- **대시보드**: 과목 카드(`←↑↓→`로 이동, `enter`로 열기, 추출된 자료 수 막대) + 오른쪽 **할 일** 패널(2주 안에 마감되는 과제, 넓은 터미널에서만)
- **과목**: 위쪽 탭 `주차학습 / 과제 / 공지사항` (`tab`, `←/→`, `1`–`3`)
  - 주차학습은 LearningX처럼 **주차별**로 묶어 보여 줍니다. `PDF`·`PPT` 항목은 `enter`로 추출 텍스트를, `LX` 항목은 브라우저에서 엽니다
  - 과제는 다가오는 과제 / 마감일 없는 과제 / 지난 과제로 나눠 보여 줍니다
- **할 일**(`t`): 날짜별 마감 과제, **검색**(`/`): 과목별로 묶은 전체 자료 검색
- `s` 전체 동기화 (LearningX를 한 번이라도 받았다면 포함). 진행 상황은 아래 상태 바에 표시됩니다
- `r` 현재 화면을 LMS에서 새로고침, `d` 대시보드, `esc` 뒤로, `q` 종료

## MCP 툴

| 툴 | 입력 | 설명 |
| --- | --- | --- |
| `list_courses` | `refresh?` | 활성 과목 |
| `list_materials` | `course_id`, `refresh?` | 과목 파일 목록 + 추출 상태, LearningX 항목(`learningx`: 제목·모듈·`html_url`) |
| `read_material` | `file_id`, `offset?`, `max_chars?` | 추출 텍스트 (긴 문서는 `offset`으로 페이지 넘김). 캐시에 없으면 그때 받아서 추출 |
| `search_materials` | `query`, `course_id?`, `limit?` | 전문 검색, `«…»` 하이라이트 스니펫 |
| `list_assignments` | `course_id?`, `upcoming_only?`, `within_days?`, `refresh?` | 마감순 과제 |
| `get_announcements` | `course_id?`, `limit?`, `refresh?` | 최근 공지 |

모든 툴은 `readOnlyHint: true`입니다. 대량 동기화는 MCP가 아니라 터미널의 `openlms sync`로 하세요.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "openlms": {
      "command": "openlms",
      "args": ["mcp"]
    }
  }
}
```

> macOS에서 nvm 등으로 Node를 설치했다면 GUI 앱은 셸 `PATH`를 모를 수 있습니다. 그럴 땐 `which openlms`, `which node`로 확인한 **절대 경로**를 쓰세요:
> `"command": "/Users/me/.nvm/versions/node/v22.17.0/bin/node", "args": ["/Users/me/.nvm/versions/node/v22.17.0/bin/openlms", "mcp"]`

### Claude Code

```bash
claude mcp add openlms --scope user -- openlms mcp
```

### Cursor

`~/.cursor/mcp.json` (또는 프로젝트의 `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "openlms": {
      "command": "openlms",
      "args": ["mcp"]
    }
  }
}
```

### 질문 예시

- "운영체제 3주차 자료에서 페이징 설명 요약해줘"
- "이번 주 마감 과제 정리하고, 과제1에 필요한 개념이 어느 강의자료에 있는지 찾아줘"
- "자료구조 최근 공지 중 시험 관련 내용 있어?"

## 데이터 위치

```
~/.lms/
├── lms.db                  # SQLite (과목·파일 메타·추출 텍스트·FTS5·과제·공지)
└── files/<course_id>/<file_id>_<name>
```

`LMS_HOME`으로 위치를 바꿀 수 있습니다. 키체인 데몬이 없는 헤드리스 리눅스에서는 `LMS_BASE_URL` + `LMS_TOKEN` 환경 변수로도 인증할 수 있습니다(키체인보다 우선).

## 개발

```bash
npm install
npm run dev -- courses     # tsx로 바로 실행
npm test                   # 가짜 Canvas 서버 대상 E2E (동기화·리다이렉트 토큰 제거·403 폴백·레이트리밋·MCP)
npm run build              # dist/
```

```
src/
├── canvas/   # REST 클라이언트(레이트리밋·백오프·페이지네이션), API 매핑
├── auth/     # OS 키체인 자격 증명
├── store/    # SQLite 캐시 + FTS5
├── extract/  # PDF/PPTX/DOCX/HTML 텍스트 추출
├── learningx/ # LearningX 실행(sessionless launch) + PDF 수집 (opt-in)
├── lms.ts    # 캐시 우선 서비스 + 증분 sync
├── cli/      # 표 출력, 프롬프트
├── mcp/      # MCP 서버
├── tui/      # Ink TUI
└── cli.ts    # 진입점
```

## 한계

- 스캔본(이미지) PDF는 텍스트가 없어 `empty`로 표시됩니다 (OCR 미지원).
- `.ppt`/`.doc` 같은 구형 바이너리 포맷은 다운로드만 하고 파일명만 인덱싱합니다.
- LearningX는 `--learningx`일 때 PDF만 받습니다. 그 밖의 형식은 브라우저에서 받은 뒤 `openlms import`로 추가하세요.
- 학교가 개인 액세스 토큰 발급을 막아 둔 경우엔 사용할 수 없습니다.
