# Showtell v2 장면 명세 레퍼런스

렌더러(`render.mjs`)가 검증하는 전체 형식이다. `?`는 선택 필드.

- **id·key**는 영문 소문자·숫자·하이픈만 쓴다(`^[a-z0-9][a-z0-9-]*$`). 화면에 보일 글은 `label`·`text`에 쓴다.
- 글 필드는 `**강조**`와 `` `코드` ``만 지원하고 HTML은 이스케이프된다. 원문에 `**`나 백틱이 들어 있는 값(수식, 코드)은 `` `2**10` ``처럼 백틱으로 감싼다.
- **사진 경로**는 명세 파일 기준 상대 경로 또는 절대 경로다. jpg·jpeg·png·webp·gif만 쓸 수 있고, 렌더러가 HTML 안에 넣는다. base64를 쓰지 않는다. 500KB를 넘으면 경고, 2MB를 넘으면 오류다.
- **숫자 표기**: units·dials·track은 원문 표기 그대로 출력한다(`12800` → "12800"). 정적 `table` 셀의 숫자만 자릿수 쉼표가 붙는다. 쉼표가 있는 원문 값("1,488", "499 / 601장")은 문자열로 쓴다.

## 문서

```json
{
  "title": "문서 제목",
  "subtitle?": "한 줄 부제",
  "lang?": "ko",
  "summary?": ["표지 요약", { "text": "장면으로 가는 요약", "to": "scene-id" }],
  "scenes": [ /* 1~40개 */ ]
}
```

## 장면

```json
{
  "id": "scene-id",
  "title": "짧은 제목",
  "message?": "이 장면의 결론 한 문장 (원문 그대로)",
  "stage?": { /* 무대 하나, 또는 이어 쓰기 */ },
  "blocks?": [ /* 정적 블록 0~6개 */ ]
}
```

- `stage`와 `blocks` 중 하나는 있어야 한다. `cover`는 예약된 id다.
- 구성은 렌더러가 정한다. 직접 고르는 `layout`은 없다.
  - **단계형(steps) 무대**: 무대가 화면에 고정되고 비트 글이 스크롤로 지나간다. `message`는 마지막 비트 뒤에 결론으로 붙는다.
  - **탭·슬라이더 무대**: 조작 → 무대 → 지금 상태 설명 순으로 놓인다.
  - **무대 없이 첫 블록이 photos**: 넓은 사진 화면이다.
  - **그 밖**: 좁은 읽기 화면이다.

### 이어 쓰기 (같은 무대가 다음 장면에서도 계속)

```json
"stage": { "continue": "앞 장면의 무대 id", "states": [ /* 상태 1개 이상 */ ] }
```

- 바로 앞 장면이 단계형 무대(또는 그 이어 쓰기)일 때만 쓸 수 있다.
- 이어 쓴 상태까지 합쳐 12개 이하다.
- 같은 무대 요소가 화면에 남은 채 다음 장면 글로 넘어가므로, 같은 대상(예: 사진 601장)을 장면마다 새로 그리지 않는다.

## 무대 공통

```json
{
  "type": "units | dials | track | lookup | photos",
  "id": "stage-id",
  "control?": "steps | tabs | slider",
  "start?": 0,
  "caption?": "원문 캡션, 항상 보임",
  "states": [ /* 1~12개 */ ]
}
```

- `control` 기본값은 `steps`다. `units`는 steps만, `lookup`·`photos`는 steps·tabs만 쓸 수 있다.
- `start`: tabs·slider의 처음 상태.

상태 공통 필드:

```json
{ "say?": "원문 문장 또는 원문 조각", "label?": "탭·슬라이더 눈금 글", "uncertain?": "확인 필요 내용" }
```

- `label`은 tabs·slider에서 필수다.
- `say`는 100자 이하로 쓴다. 쓸 문장이 없으면 생략한다. 렌더러가 그 상태의 원문 값으로 **데이터 줄**을 자동으로 만든다.

**이어받기 규칙.** 상태는 바뀐 것만 쓴다. 렌더러가 모든 상태를 절대값으로 풀어 두므로 건너뛰거나 거꾸로 가도 결과가 같다.

| 무대 | 생략하면 이전 상태 값을 이어받는 필드 | 생략하면 비는 필드 |
|---|---|---|
| units | `groups`, `layout` | `focus` |
| dials | `show`, `set`(누적) | `focus`, `axes` |
| track | `rows`, `frames` | `focus` |
| lookup | `record` | `focus` |
| photos | `show` | `focus`, `zones`, `detail` |

## units — 셀 수 있는 대상, 점 하나 = 하나 (최대 1500)

```json
{
  "type": "units", "id": "shots", "total": 601, "unit": "장", "layout?": "waffle | rows",
  "states": [
    { "groups": [{ "label": "전체", "n": 601 }] },
    { "layout": "rows", "groups": [
      { "label": "S", "n": 409, "key": "s" }, { "label": "P", "n": 177, "key": "p" }, { "label": "M", "n": 15 }
    ] },
    { "groups": [ { "label": "느린 컷", "n": 55, "of": "P", "key": "slow" }, { "n": "rest", "of": "P" }, … ], "focus": ["느린 컷"] }
  ]
}
```

그룹 필드는 `label`, `n`(양의 정수 또는 `"rest"`), `key?`(문서 전체 색), `of?`(세분), `from?`(합치기)다.

- 각 상태의 합 = `total`. 렌더러가 검사한다.
- `"rest"`는 나머지다. 원문에서 "전체 − 적힌 부분"이 정확히 정해질 때만 쓴다. 개수는 화면에 표시되지 않고, `label`은 생략할 수 있다.
- **점이 이동하는 경우는 세 가지뿐**이다.
  - **세분**: 그룹마다 `of: "이전 상태의 라벨"`. 하위 그룹의 합이 부모와 같아야 한다.
  - **합치기**: `from: ["이전 라벨", …]`. `n`은 그 합과 같아야 한다.
  - **한 그룹이던 상태를 나누기**: `of` 없이 써도 된다.
  - 세분·합치기 상태에서 `of`·`from`이 없는 그룹은 이전 상태와 라벨·개수가 같아야 한다.
- 그 밖의 재분류(교차표가 없는 다른 기준으로 다시 세기)는 **디졸브**한다. 점이 이동하지 않으므로 없는 관계를 암시하지 않는다.
- `layout`: `waffle`은 한 판에 모아서, `rows`는 그룹마다 한 줄씩 놓는다.

## dials — 눈금 위의 값·범위. 사진을 캡션의 값 위치에 꽂는다

```json
{
  "type": "dials", "id": "booth", "control?": "steps | slider",
  "axes": [
    { "key": "iso", "label": "ISO", "min": 300, "max": 1100, "log?": false, "sign?": false, "unit?": "", "ticks?": [400, 640, 1000] },
    { "key": "ss", "label": "셔터", "stops": ["1/60", "1/125", "1/160"] }
  ],
  "items": [
    { "id": "today", "label": "오늘", "at": { "iso": [400, 1000] }, "labels": { "iso": "10~90% 범위 400~1000" } },
    { "id": "d65", "label": "DSC06065", "photo": "assets/DSC06065.jpg", "text": "원문 캡션", "at": { "iso": 800 }, "key?": "p", "tone?": "data | target | zone", "uncertain?": "…" }
  ],
  "states": [
    { "show": ["today"] },
    { "show": ["today", "d65"], "focus": ["d65"] },
    { "set": { "today": { "label": "내일", "at": { "iso": 640 }, "labels": { "iso": "**640 고정**" } } } }
  ]
}
```

- 축은 두 종류다.
  - **순서형**: `stops` 2~10개. 원문 값 그대로 쓰고, 순서만 의미한다.
  - **수치형**: `min`·`max`. 눈금에 표시되지 않는 범위 끝이다. `ticks`는 원문 값만, 축 길이의 12% 이상 띄워서 쓴다.
- 값은 세 가지다. 핀은 `stops` 중 하나 또는 숫자다. 범위는 `[낮은, 높은]`이고 `null`은 축 끝까지다(`[null, null]` = "오토"처럼 전체). **범위에는 `labels[축]`이 필수**다.
- `set`은 누적된다.
  - `at`의 축 값을 `null`로 주면 그 축에서 빠진다.
  - 값을 바꾸면서 `labels`를 주지 않으면 옛 라벨은 지워진다.
  - 범위를 핀으로 바꾸면 "오늘의 퍼짐이 내일 값으로 줄어드는" 장면이 된다.
- `axes`(상태)는 강조할 축이다. 나머지 축은 흐려진다.
- 한계: 축 6개, 항목 10개.

## track — 순서 있는 구간(시간 구간, 순서형 값) 위의 값

```json
{
  "type": "track", "id": "c0003",
  "x": { "label": "구간 시작", "unit?": "초", "bins": ["0", "5", "10"] },
  "rows": [
    { "id": "r50", "label": "1/50 비율", "unit?": "%", "mark": "bar", "values": [100, 44, null], "max?": 100, "caption?": "…" },
    { "id": "iso", "label": "최대 ISO", "mark": "dot", "scale?": "linear | log", "values": [250, 160, 125] },
    { "id": "mode", "label": "주 모드", "mark": "text", "values": ["P", "S 171 · P 7", "S"] }
  ],
  "frames?": [{ "id": "f0", "bin": "0", "src": "assets/vid_01.jpg", "label": "0초", "text?": "…" }],
  "notes?": [{ "bin": "10", "text": "원문 메모 (그 구간에 초점이 갈 때 보임)" }],
  "scrub?": true,
  "states": [{ "rows": ["r50"] }, { "rows": ["r50", "iso"], "focus": ["10"] }]
}
```

- 한계: 구간 2~24개, 행 1~4개, 사진 8개.
- `bar`는 항상 0부터 시작하고 값이 0 이상이어야 한다. `dot`은 점과 값만 그리고 **선으로 잇지 않는다**. `text`는 원문 문자열이다.
- `scrub: true`이면 구간 막대를 움직여 그 구간의 원문 값을 정확히 읽는다.
- 행이 처음 보일 때 막대가 0에서 자란다. 데이터가 축 위에 도착하는 연출이다.

## lookup — 같은 항목을 여러 경우(상황, 슬롯, 오늘/내일)로 비교

```json
{
  "type": "lookup", "id": "sit", "view?": "switch | full", "control?": "steps | tabs",
  "fields": ["모드 · 셔터", "ISO"],
  "records": [
    { "id": "today", "label": "오늘", "badge?": "기록", "values": ["1/50↔1/60 자동 변경", "100~250"], "notes?": ["", "오토"] },
    { "id": "tmr", "label": "내일", "values": ["M · **1/60**", { "text": "200~400 고정", "uncertain": "…" }] }
  ],
  "base?": "today",
  "states": [{ "record": "today" }, { "record": "tmr", "focus": ["모드 · 셔터"] }]
}
```

- **switch**: 카드 한 장이 경우를 바꾼다. 달라진 칸만 바뀌고, `base`와 다른 칸에는 표시가 붙는다.
- **full**: 표 하나(경우 = 열)를 보여 주고, 상태는 `focus`로 줄을 강조한다.
- 칸이 비면 `"—"`로 쓴다. 다른 문서의 값으로 채우지 않는다.
- 합성 문자열은 이미 있는 구분자(" · ", 설정 사이 공백)에서만 나누고, 조각은 그대로 둔다.
- 한계: 항목 14개, 경우 8개.

## photos — 사진은 증거. 한 장을 키우고, 원문이 말한 자리를 표시한다

```json
{
  "type": "photos", "id": "framing", "compare?": true, "control?": "steps | tabs",
  "items": [{
    "id": "d305", "src?": "assets/DSC06305.jpg", "name": "DSC06305", "alt?": "…",
    "meta?": ["S", "1/160", "ISO 400"], "text?": "원문 캡션", "key?": "p", "uncertain?": "…",
    "zones?": [{ "id": "l", "area": "left | right | top | bottom | center | edges", "text": "원문이 말한 위치 설명" }],
    "detail?": { "src": "assets/DSC05963_crop.jpg", "text": "같은 컷 얼굴 100% 크롭" }
  }],
  "states": [{}, { "focus": "d305", "zones": ["d305.l"] }, { "focus": "d63", "detail": "d63" }]
}
```

- `compare: true`이면 같은 순서의 `meta` 값이 사진마다 다를 때 강조된다.
- `src`가 없으면 도식 프레임이다(`frame?`: `3:2`·`2:3`·`16:9`). 위치에 관한 규칙(중앙·가장자리)을 사진 없이 그린다.
- **zones는 원문이 위치를 말한 경우에만** 쓴다. 쓰기 전에 사진을 직접 본다.
- 한계: 사진 6장, 사진마다 영역 4개.

## 정적 블록

- `text`: `{ "type": "text", "text": "문단\n\n다음 문단" }`
- `note`: `{ "type": "note", "tone?": "info | warn | uncertain", "text": "…" }`
- `table`: `{ "type": "table", "columns": [...], "rows": [[...]], "highlight?": [0], "caption?": "…" }` — 첫 열은 행 제목, 숫자 셀은 오른쪽 정렬·자릿수 쉼표.
- `compare`: `{ "type": "compare", "highlight?": 0, "items": [{ "title", "subtitle?", "badge?", "points": [] }] }` — 2~4개.
- `checklist`: `{ "type": "checklist", "items": ["할 일", { "text", "note?", "to?": "scene-id" }] }` — `to`는 그 장면으로 가는 링크.
- `flow`: `{ "type": "flow", "direction?": "horizontal | vertical", "steps": ["단계", { "title", "text?" }] }`
- `code`: `{ "type": "code", "lang?": "js", "code": "…", "highlight?": [2], "caption?": "…" }`
- **상태가 하나인 무대**(`units`·`dials`·`track`·`lookup`·`photos`)도 블록으로 쓸 수 있다. `states`는 생략하거나 1개만 쓰고, `control`은 쓰지 않는다.

모든 블록 공통 선택 필드: `"title?"`. v1의 `cards`·`chart`·`html`과 장면 `layout`은 없어졌다.

## 결과물에서 사용자가 할 수 있는 것

- **문서 모드**: 스크롤하면 무대가 고정된 채 비트에 따라 바뀐다. `←` `→`로 장면을 이동한다.
- **발표 모드**: `P`로 들어간다.
  - `→` `Space` `PageDown`은 다음 비트이고, 비트가 끝나면 다음 장면으로 간다. `←`는 반대 방향이다.
  - `Home` `End`로 처음·끝 장면, `Esc`로 종료한다. 모바일은 좌우 스와이프로 넘긴다.
- **직접 조작**: 탭·슬라이더·구간 스크럽으로 값을 바꿔 본다.
- **다른 환경**: 동작 줄이기, JavaScript 꺼짐, 인쇄에서도 모든 비트의 문장·값과 데이터 표가 보인다.
