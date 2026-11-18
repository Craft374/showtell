# Showtell

> Don't just tell. Show it.

Claude Code가 긴 설명 대신 **보면서 이해되는 HTML 장면**으로 보여 주게 하는 플러그인입니다. 비교·관계·절차·수치·구조처럼 시각화가 도움이 되는 답에서 Claude가 스스로 판단해 사용하므로, 별도 명령어를 외울 필요가 없습니다.

v2에서는 장면이 "제목 + 표 + 카드"를 쌓는 문서가 아닙니다. 장면마다 **무대 하나**가 있고, 그 무대의 상태가 단계(비트)마다 바뀝니다. 예를 들면 다음과 같습니다.

- 사진 601장이 점으로 나뉘고 세분되고 합쳐집니다.
- 오늘의 설정값 범위가 내일 값으로 줄어듭니다.
- 상황 탭을 바꾸면 달라진 칸만 바뀝니다.

## 설치

```bash
claude plugin marketplace add Craft374/showtell
claude plugin install showtell@showtell
```

Claude Code 세션 안에서는 `/plugin marketplace add Craft374/showtell` 후 `/plugin install showtell@showtell`을 사용합니다. Node.js 18 이상이 필요합니다(외부 패키지 없음).

## 동작

1. Claude가 답변에 시각화가 효과적인지 판단합니다 (`skills/showtell/SKILL.md`).
2. 장면마다 "무엇이 바뀌는 걸 봐야 이해되는가"를 정하고, 데이터 모양에 맞는 무대를 고릅니다.

   | 무대 | 쓰는 경우 |
   |---|---|
   | `units` | 셀 수 있는 대상이 나뉘고 세분되고 합쳐질 때 |
   | `dials` | 값·범위를 눈금에 놓을 때. 사진을 EXIF 값 위치에 꽂고, 범위를 목표값으로 줄입니다 |
   | `track` | 순서 있는 구간 위의 값을 보여 줄 때. 스크럽으로 정확히 읽습니다 |
   | `lookup` | 같은 항목을 여러 경우로 비교할 때. 탭으로 바꿉니다 |
   | `photos` | 사진이 증거일 때. 확대, 위치 표시, 100% 크롭을 씁니다 |

3. JSON 명세를 `<프로젝트>/.showtell/<이름>.json`에 쓰고, 사진은 파일 경로로 참조합니다.
4. 렌더러가 모든 상태를 미리 계산해 단일 HTML을 만들고 브라우저로 엽니다.
   - 결과물은 `.showtell/YYYY-MM-DD-<이름>.html`입니다. 사진도 이 파일 안에 들어가고, 기존 파일은 덮어쓰지 않고 번호를 붙입니다.
   - `.showtell/` 안에는 자체 `.gitignore`가 생겨 git에 섞이지 않습니다.

## 결과물 사용법

- **문서 모드**: 스크롤하면 무대가 고정된 채 비트에 따라 바뀝니다. `←` `→`로 장면을 이동합니다.
- **발표 모드**: `P`를 누르거나 오른쪽 아래 버튼을 씁니다.
  - `→`/`Space`는 다음 비트이고, 비트가 끝나면 다음 장면으로 갑니다.
  - `←`는 이전, `Esc`는 종료입니다. 모바일은 스와이프로 넘깁니다.
- **직접 조작**: 탭·슬라이더·구간 스크럽으로 값을 직접 바꿔 봅니다.
- **표시 환경**: 라이트/다크는 시스템 설정을 따릅니다. 동작 줄이기, JavaScript 꺼짐, 인쇄에서도 모든 비트의 글과 데이터 표가 보입니다.

## 직접 실행

```bash
mkdir -p .showtell && cp skills/showtell/example.json .showtell/
node skills/showtell/render.mjs .showtell/example.json   # 예시 렌더링 후 브라우저 열기 (--no-open: 열지 않음)
node skills/showtell/check.mjs                           # 렌더러 자가 점검 (결과물 생성 없음)
node skills/showtell/check.mjs <명세.json> ...            # 실제 명세의 충실성까지 점검
```

명세 형식은 [`skills/showtell/reference.md`](skills/showtell/reference.md)를 참고하세요.

## 구조

```
.claude-plugin/plugin.json        플러그인 매니페스트
.claude-plugin/marketplace.json   마켓플레이스 매니페스트
skills/showtell/SKILL.md          사용 판단 + 장면 설계 절차 + 충실성 규칙 (진입점)
skills/showtell/reference.md      장면 명세 형식
skills/showtell/render.mjs        명세 검증 + 상태 계산 + HTML 렌더러 + 브라우저 열기
skills/showtell/runtime.css       디자인 시스템 · 상태 전환
skills/showtell/runtime.js        스크롤 비트 · 발표 모드 · 조작
skills/showtell/example.json      모든 무대를 쓰는 예시 명세
skills/showtell/check.mjs         자가 점검 (정방향·역방향 숫자 검사 포함)
```
