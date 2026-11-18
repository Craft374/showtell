// 렌더러 최소 자가 점검. 결과물을 쓰거나 브라우저를 열지 않는다 (이미지 검사용 임시 파일만 OS 임시 폴더에 만든다).
// 실행: node skills/showtell/check.mjs [추가로 검사할 spec.json ...]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validate, render, esc, imgSize, fmtNum } from './render.mjs'

// 표시되지 않는 필드: id·참조·설정값·이미지 경로·범위 끝 등
const NOT_SHOWN = new Set(['type', 'id', 'key', 'tone', 'layout', 'control', 'start', 'mark', 'scale', 'view', 'area', 'frame', 'base', 'record',
  'show', 'continue', 'to', 'of', 'from', 'focus', 'at', 'min', 'max', 'total', 'highlight',
  'direction', 'lang', 'src', 'photo', 'alt', 'sign', 'log', 'scrub', 'compare', 'zero'])
// 상태 안에서 id만 가리키는 필드 (같은 이름이 무대에서는 실제 내용이다: track rows, photos zones 등)
const REFS = new Set(['rows', 'frames', 'zones', 'axes', 'detail'])
const isRef = v => typeof v === 'string' || (Array.isArray(v) && v.every(x => typeof x === 'string'))
// inline() 없이 esc()로만 출력되어 **·백틱이 그대로 남는 필드
const VERBATIM = new Set(['code', 'badge', 'stops', 'bins'])
const strip = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
const flatEsc = html => strip(html).replace(/<[^>]*>/g, '').replace(/\s+/g, '')
const decode = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const digits = s => (s.match(/\d+(?:[.,]\d+)*/g) || []).map(d => d.replace(/,/g, ''))

function fidelity(spec, html, name) {
  const lang = spec.lang || 'ko'
  // 정방향: 명세에 적힌 표시용 문자열·숫자가 결과물에 그대로 있다 (누락·변경 금지)
  const flat = flatEsc(html)
  const has = (s, why) => assert.ok(flat.includes(s.replace(/\s+/g, '')), `${name}: 결과물에 없음 — ${why}`)
  const walk = (v, key, parent) => {
    if (NOT_SHOWN.has(key)) return
    if (REFS.has(key) && isRef(v)) return
    if (key === 'n' && v === 'rest') return
    if (key === 'labels' && parent) return Object.values(v).forEach(x => walk(x, 'label'))
    if (key === 'unit' && parent && parent.key !== undefined && ('min' in parent || 'stops' in parent)) return // 축 단위는 값에 붙어서만 보인다
    if (typeof v === 'string') { if (v !== '') has(esc(VERBATIM.has(key) ? v : v.replace(/`([^`]+)`|\*\*(.+?)\*\*/g, (_, c, b) => c ?? b)), v) }
    else if (typeof v === 'number') { const f = fmtNum(v, lang).replace(/\s+/g, ''); assert.ok(flat.includes(String(v)) || flat.includes(f), `${name}: 결과물에 없음 — ${key}=${v}`) }
    else if (Array.isArray(v)) v.forEach(x => walk(x, key, parent))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, v)
  }
  walk(spec)
  // 역방향: 화면에 보이는 숫자는 전부 명세에 있다 (계산한 숫자를 보여 주지 않는다)
  const known = new Set()
  const collect = v => {
    if (typeof v === 'string') digits(v).forEach(d => known.add(d))
    else if (typeof v === 'number') [String(v), fmtNum(v, lang)].forEach(s => digits(s).forEach(d => known.add(d)))
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  collect(spec)
  const visible = decode(strip(html).replace(/<(\w+)[^>]*\bdata-chrome\b[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]*>/g, ' '))
  for (const d of digits(visible)) assert.ok(known.has(d), `${name}: 명세에 없는 숫자가 화면에 보임 — ${d}`)
  // 런타임 JS에는 'undefined'가 정상적으로 들어 있고 사진 base64에도 우연히 나올 수 있으므로 빼고 본다
  const gen = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/data:[^"]*/g, '')
  const specText = JSON.stringify(spec)
  for (const t of gen.match(/NaN|undefined|Infinity/g) || []) assert.ok(specText.includes(t), `${name}: NaN·undefined가 출력되면 안 됩니다`)
}

// 1) 예시 명세: 유효하고, 모든 값이 그대로 들어 있다
const here = path.dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(fs.readFileSync(path.join(here, 'example.json'), 'utf8'))
const warns = []
assert.deepEqual(validate(spec, { baseDir: here, warnings: warns }), [], 'example.json은 유효해야 합니다')
const html = render(spec, { date: '2026-01-01', baseDir: here })
fidelity(spec, html, 'example.json')
// 단계형 무대는 JS 없는 환경을 위해 마지막 상태로 출하, 탭은 start로 출하
assert.ok(/id="st-shots" data-n="4" data-s="3"/.test(html), '이어 쓴 상태까지 합쳐 4개, 출하 상태는 마지막이어야 합니다')
assert.ok(/id="st-sit" data-n="3" data-s="0" data-ctl="tabs"/.test(html), '탭 무대는 start 상태로 출하')
// 모드 → 시간대는 교차표가 없으므로 디졸브, 1개 그룹 분할(1)·세분(2)은 점 이동
assert.ok(/id="st-shots"[^>]*data-dis="3"/.test(html), '관계없는 재분류만 디졸브여야 합니다')
assert.ok(html.includes('details class="st-fallback" open'), '대체 표는 열린 채로 출하')
// 숫자는 원문 표기 그대로 (dials·track은 자릿수 쉼표 없음)
assert.ok(html.includes('6400') && !html.includes('6,400'), 'dials 눈금 숫자에 쉼표가 붙으면 안 됩니다')

// 2) 잘못된 명세는 경로가 포함된 오류로 거부된다
const base = (stage, more = []) => ({ title: 't', scenes: [{ id: 'a', title: 'a', stage }, ...more] })
const units = (states, total = 10) => ({ type: 'units', id: 'u', total, unit: '장', states })
const errsOf = s => validate(s)
let e = errsOf(base(units([{ groups: [{ label: 'x', n: 4 }, { label: 'y', n: 5 }] }])))
assert.ok(e.some(m => m.includes('scenes[0].stage.states[0].groups') && m.includes('합 9 ≠ total 10')), '합계 오류를 잡아야 합니다')
e = errsOf(base(units([{ groups: [{ label: 'x', n: 10 }] }, { groups: [{ label: 'y', n: 3, of: 'x' }, { label: 'z', n: 3, of: 'x' }] }])))
assert.ok(e.some(m => m.includes('하위 그룹 합 6 ≠ 10')), '세분 합계 오류를 잡아야 합니다')
e = errsOf(base(units([{ groups: [{ label: 'x', n: 4 }, { label: 'y', n: 6 }] }, { groups: [{ label: 'z', n: 10, from: ['x'] }] }])))
assert.ok(e.some(m => m.includes('from')), '합치기 합계 오류를 잡아야 합니다')
e = errsOf(base(units([{ groups: [{ label: 'x', n: 10 }] }]), [{ id: 'b', title: 'b', blocks: [{ type: 'text', text: 't' }] }, { id: 'c', title: 'c', stage: { continue: 'u', states: [{}] } }]))
assert.ok(e.some(m => m.includes('scenes[2].stage.continue')), '바로 앞이 아닌 무대 이어 쓰기를 잡아야 합니다')
e = errsOf(base({ type: 'lookup', id: 'l', control: 'tabs', fields: ['f'], records: [{ id: 'r', label: 'r', values: ['v'] }], states: [{ label: 'r', record: 'r' }] }, [{ id: 'b', title: 'b', stage: { continue: 'l', states: [{}] } }]))
assert.ok(e.some(m => m.includes('steps')), '탭 무대 이어 쓰기를 잡아야 합니다')
e = errsOf(base({ type: 'dials', id: 'd', axes: [{ key: 'a', label: 'a', min: 0, max: 10 }], items: [{ id: 'i', label: 'i', at: { a: [2, 5] } }], states: [{}] }))
assert.ok(e.some(m => m.includes('labels')), '범위 값의 라벨 누락을 잡아야 합니다')
e = errsOf({ title: 't', scenes: [{ id: 'cover', title: 's', blocks: [{ type: 'cards', items: [] }] }] })
assert.ok(e.some(m => m.includes('예약')) && e.some(m => m.includes('cards')), '예약 id와 없어진 블록을 잡아야 합니다')

// 3) 텍스트는 이스케이프된다
const evil = render({ title: '<script>alert(1)</script>', scenes: [{ id: 'a', title: 'a"b', stage: { type: 'lookup', id: 'l', fields: ['<b>'], records: [{ id: 'r', label: '<img src=x onerror=alert(1)>', values: ['<i>'] }], states: [{ record: 'r', say: '<svg onload=alert(1)>' }] } }] }, { date: 'd' })
assert.ok(!evil.includes('<script>alert') && !evil.includes('<img src=x') && !evil.includes('<svg onload'), '텍스트가 이스케이프되어야 합니다')

// 4) 이미지: 경로를 읽어 넣고 크기를 읽는다
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showtell-check-'))
const png = Buffer.alloc(33)
png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(640, 16); png.writeUInt32BE(427, 20)
fs.writeFileSync(path.join(tmp, 'a.png'), png)
assert.deepEqual(imgSize(png), [640, 427])
const ph = { title: 't', scenes: [{ id: 'a', title: 'a', blocks: [{ type: 'photos', items: [{ id: 'p', src: 'a.png', name: 'DSC1', meta: ['ISO 400'] }] }] }] }
assert.deepEqual(validate(ph, { baseDir: tmp }), [])
assert.ok(validate({ ...ph, scenes: [{ ...ph.scenes[0], blocks: [{ type: 'photos', items: [{ id: 'p', src: 'nope.jpg', name: 'x' }] }] }] }, { baseDir: tmp }).some(m => m.includes('파일이 없습니다')))
assert.ok(render(ph, { date: 'd', baseDir: tmp }).includes('width="640" height="427"'))
fs.rmSync(tmp, { recursive: true, force: true })

// 5) 인자로 준 실제 명세도 같은 충실성 검사를 한다 (예: 변환한 v2 명세)
for (const f of process.argv.slice(2)) {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'))
  const dir = path.dirname(path.resolve(f)), w = []
  const errs = validate(s, { baseDir: dir, warnings: w })
  assert.deepEqual(errs, [], `${f}: 명세 오류`)
  fidelity(s, render(s, { date: 'd', baseDir: dir }), f)
  console.log(`✓ ${f}${w.length ? ` (경고 ${w.length}건)` : ''}`)
}

console.log('✓ Showtell 자가 점검 통과')
