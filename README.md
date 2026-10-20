# 하이잭 학생 리포트 MCP

Claude Desktop, Codex, Antigravity 같은 AI 도구에서 우리 학원 사이트의 학생 데이터를 조회·분석하고
학생 리포트 **초안**을 작성하거나, PDF 정답지에서 **OMR 시험(정답)**을 등록할 수 있게 해주는 연결 프로그램입니다.

## 1. 준비물

- **Node.js 18 이상** — https://nodejs.org 에서 LTS 버전 설치
- **이 폴더** (`hijack-report-mcp`) — 예: `C:\hijack-report-mcp` 에 복사
- **API 키** — 관리자 모드 > 사이트 설정 > **AI 연동 키**에서 발급
  - 조회: 데이터 조회·분석만
  - 초안: 리포트 초안 생성과 미발행 리포트 총평 수정까지
  - 전체: 위 기능에 더해 OMR 시험(정답) 등록, 게시판 생성·설정 수정
  - (이전에 발급한 "초안 + OMR 등록" 키는 게시판 생성·수정을 뺀 나머지가 그대로 됩니다)

폴더를 복사한 뒤 한 번만 실행하세요 (명령 프롬프트에서):

```
cd C:\hijack-report-mcp
npm install
```

## 2. AI 도구에 등록

아래 예시의 `SITE_URL`과 `API_KEY`를 발급 화면에 나온 값으로 바꾸세요.
경로의 `\`는 JSON/TOML 안에서 `\\`로 두 번 써야 합니다.

### Claude Desktop

설정 > 개발자 > 설정 편집 → `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "hijack-report": {
      "command": "node",
      "args": ["C:\\hijack-report-mcp\\index.js"],
      "env": {
        "HIJACK_SITE_URL": "https://우리학원주소",
        "HIJACK_API_KEY": "hjk_발급받은키"
      }
    }
  }
}
```

저장 후 Claude Desktop을 완전히 종료했다가 다시 실행하세요.

### Codex

`%USERPROFILE%\.codex\config.toml`

```toml
[mcp_servers.hijack-report]
command = "node"
args = ["C:\\hijack-report-mcp\\index.js"]
env = { HIJACK_SITE_URL = "https://우리학원주소", HIJACK_API_KEY = "hjk_발급받은키" }
```

### Antigravity

에이전트 패널 메뉴 > MCP Servers > Manage MCP Servers > View raw config 에서
Claude Desktop과 같은 `mcpServers` 형식으로 추가합니다.

## 3. 사용 예시

- "김민수 학생 9월 학습 데이터 정리해줘"
- "중2A반 학생들 중 9월 출석률이나 영상 시청률이 낮은 학생 찾아줘"
- "이 학생 8월과 9월 비교해서 학부모용 총평 초안 써줘"
- "그 내용으로 9월 리포트 초안 만들어줘" (초안 키 필요)
- "오늘 중2A 수업 출석 안 한 학생 누구야?"
- "이번 주 과제 안 낸 학생 알려줘"
- "어제 올린 영상 중2A에서 누가 안 봤어?"
- "중2A 이번 달 단어 테스트 평균 점수는?"
- (PDF 첨부) "이 정답지로 중2 듣기 Book1 게시판에 Day1~5 시험 올려줘" (전체 키 필요)
  → 정답표를 먼저 보여주고, 확인하면 등록합니다.
- "학부모 공지 게시판 만들어줘. 읽기는 회원만, 글쓰기는 관리자만" (전체 키 필요)
- "자료실 게시판에 분류 '중1, 중2, 중3' 추가해줘" (전체 키 필요)

## 4. 할 수 있는 것 / 없는 것

| 도구 | 내용 |
|---|---|
| list_students | 학생·반 목록 (연락처는 전달하지 않음) |
| get_student_data | 기간별 출결, 과제, 영상 시청, OMR 점수 |
| list_reports / get_report | 작성된 리포트 조회 |
| create_report_draft | 리포트 초안 생성 |
| update_report_draft | 초안 총평 수정 |
| get_schedule / get_attendance | 수업 일정(일·주·월), 수업별 학생 출결 |
| list_assignments / get_assignment_status | 과제 목록, 학생별 과제 완료 현황 |
| get_video_watch | 게시글 영상 시청 기록(게시판·게시글·학생별) |
| get_group_omr | 반별 OMR 응시 현황·평균 점수 |
| get_site_stats | 회원·게시글·방문자 등 사이트 현황 |
| list_omr_boards | 시험을 등록할 수 있는 OMR 게시판·분류, 최근 시험 제목 |
| create_omr_exams | OMR 시험(정답) 등록 — 먼저 검증만 하고, 확인 후 등록 |
| list_boards | 게시판 목록·설정(그룹, 스킨, 권한 레벨, 분류) |
| create_board / update_board | 게시판 생성(기본 스킨), 이름·순서·권한 레벨·분류·페이지당 글 수 수정 |

- 발행, 삭제(게시판 삭제 포함), 알림톡 발송은 **할 수 없습니다.** 관리자 화면에서 직접 하세요.
- 게시판 스킨·포인트·업로드 설정은 관리자 화면에서 바꾸세요.
- 등록한 OMR 시험의 수정·삭제와 본사 공용 게시판 등록은 **할 수 없습니다.**
- 상담기록은 요청할 때만 조회합니다. 결제 정보는 조회할 수 없습니다.
- 조회 결과는 키를 발급한 관리자의 메뉴 권한 범위 안에서만 나옵니다.

## 5. 주의

- 조회한 학생 데이터는 사용 중인 AI 서비스(Anthropic, OpenAI, Google 등)로 전송됩니다.
- API 키는 위 설정 파일에 저장됩니다. PC를 공유한다면 조회 전용 키를 쓰고,
  유출이 의심되면 관리자 화면에서 바로 **폐기**하세요.

## 문제 해결

| 메시지 | 조치 |
|---|---|
| HIJACK_API_KEY가 올바르지 않습니다 | 키를 `hjk_`부터 빠짐없이 복사했는지 확인 |
| 사이트가 ...(으)로 이동합니다 | 안내된 주소로 `HIJACK_SITE_URL` 변경 (www, https 차이) |
| 유효하지 않거나 폐기된 API 키입니다 | 관리자 화면에서 새 키 발급 |
| API 키 권한으로 허용되지 않는 작업입니다 | 초안 작성은 "초안" 키, OMR 등록·게시판 생성/수정은 "전체" 키 필요. 발행된 리포트는 수정 불가 |
