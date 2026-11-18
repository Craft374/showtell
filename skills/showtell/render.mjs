#!/usr/bin/env node
// Showtell v2 renderer: 장면 명세(JSON) → 서버 없이 열리는 단일 HTML. 외부 의존성 없음.
// 장면은 "무대(stage) 하나 + 상태(beat) 여러 개"로 설명한다. 모든 상태는 여기서 미리 계산하고,
// 브라우저는 무대마다 data-s 정수 하나만 바꾼다. 움직임은 전부 CSS 전환이다.
// 사용법: node render.mjs <spec.json> [--no-open]
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STAGES = ['units', 'dials', 'track', 'lookup', 'photos']
const STATIC = ['text', 'note', 'table', 'checklist', 'flow', 'compare', 'code']
const TONES = { info: ['i', '참고'], warn: ['!', '주의'], uncertain: ['?', '확인 필요'] }
const KEBAB = /^[a-z0-9][a-z0-9-]*$/
const IMG_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }
const MAX_STATES = 12
const PER_ROW = [25, 40, 50, 60, 80] // units: 한 줄의 점 개수 후보
const U_LINE = 18 // units 라벨 한 줄 높이 (px)
const U_GAP = 1.5
const U_LABEL_W = 72 // 320px 무대에서 라벨 칸 폭 (실제 80px, 굵은 숫자·글꼴 차이 여유)
const ZONES = ['left', 'right', 'top', 'bottom', 'center', 'edges']

// ---------- 문자열 ----------
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
// 최소 인라인 서식: `코드`, **강조**. 이스케이프 후 적용하므로 HTML 삽입은 불가능하다.
const inline = s => esc(s).replace(/`([^`]+)`|\*\*(.+?)\*\*/g, (_, c, b) => (c !== undefined ? `<code>${c}</code>` : `<strong>${b}</strong>`))
const plain = s => String(s).replace(/`([^`]+)`|\*\*(.+?)\*\*/g, (_, c, b) => c ?? b)
const para = s => String(s).split(/\n{2,}/).map(p => `<p>${inline(p).replace(/\n/g, '<br>')}</p>`).join('')
// 정적 표 전용: 자릿수 쉼표. 아주 작은 값은 로캘 서식이 0으로 잘라내므로 원래 표기를 쓴다
export const fmtNum = (n, lang = 'ko') => (typeof n !== 'number' ? String(n) : n !== 0 && Math.abs(n) < 1e-6 ? String(n) : n.toLocaleString(lang, { maximumFractionDigits: 20 }))
const textW = s => [...String(s)].reduce((a, ch) => a + (ch.codePointAt(0) > 0x2e80 ? 12 : ch === ' ' ? 3.5 : 7), 0) // 12px 글꼴 기준 대략 폭 (공백은 좁다)
const r2 = v => Math.round(v * 100) / 100
const ks = (p, list) => list.map(k => ` ${p}-${k}`).join('')
const unc = t => (t ? ` <span class="st-unc">확인 필요 · ${inline(t)}</span>` : '')
const cellRaw = c => (typeof c === 'string' ? c : c.text)
const cellHtml = c => (typeof c === 'string' ? inline(c) : `${inline(c.text)}${unc(c.uncertain)}`)
// 같은 자리에 겹쳐 두고 상태별로 바꿔 보이는 내용 (높이가 가장 긴 값에 맞춰져 흔들리지 않는다)
function variants(per) {
  const out = []
  per.forEach((h, k) => {
    if (h == null || h === '') return
    const e = out.find(v => v.html === h)
    if (e) e.s.push(k)
    else out.push({ html: h, s: [k] })
  })
  return out
}
const stack = vs => (vs.length ? `<span class="st-stack">${vs.map(v => `<span class="st-v${ks('s', v.s)}">${v.html}</span>`).join('')}</span>` : '')
const isStr = v => typeof v === 'string' && v.trim() !== ''
const isNum = v => typeof v === 'number' && Number.isFinite(v)
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const ctlOf = st => st.control || 'steps'

// ---------- 이미지 ----------
export function imgSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null
      const m = buf[i + 1]
      if (m === 0xff) { i++; continue }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]
      i += 2 + buf.readUInt16BE(i + 2)
    }
  }
  return null
}

function imgOf(src, ctx) {
  const f = path.resolve(ctx.baseDir, src)
  let im = ctx.imgs.get(f)
  if (!im) {
    const buf = fs.readFileSync(f)
    im = { uri: `data:${IMG_TYPES[path.extname(f).toLowerCase()]};base64,${buf.toString('base64')}`, size: imgSize(buf) || [3, 2] }
    ctx.imgs.set(f, im)
  }
  return im
}
// 사진 칸의 가로세로 비율: CSS가 사진 높이 상한(--phmax)에 맞춰 칸 폭을 줄인다 (표시 영역이 사진과 같아야 위치 표시가 맞는다)
const paOf = (src, ctx) => { const [w, h] = imgOf(src, ctx).size; return `--pa:${r2(w / h)};` }
function imgTag(src, alt, ctx) {
  const im = imgOf(src, ctx)
  return `<img src="${im.uri}" width="${im.size[0]}" height="${im.size[1]}" alt="${esc(plain(alt || ''))}" decoding="async">`
}

// ---------- 검증 도우미 ----------
function helpers(V) {
  const h = {
    obj: (v, p) => isObj(v) || (V.bad(p, '객체여야 합니다'), false),
    text: (v, p) => isStr(v) || (V.bad(p, '비어 있지 않은 문자열이어야 합니다'), false),
    str: (o, k, p, opt) => { if (o[k] === undefined ? !opt : !isStr(o[k])) V.bad(`${p}.${k}`, '비어 있지 않은 문자열이어야 합니다') },
    list: (o, k, p, each, min = 1, max = Infinity) => {
      const a = o[k]
      if (!Array.isArray(a) || a.length < min || a.length > max) {
        V.bad(`${p}.${k}`, max === Infinity ? `${min}개 이상의 항목을 가진 배열이어야 합니다` : `${min}~${max}개 항목을 가진 배열이어야 합니다`)
        return false
      }
      a.forEach((v, i) => each(v, `${p}.${k}[${i}]`, i))
      return true
    },
    opt: (o, k, p, each, min, max) => o[k] === undefined || h.list(o, k, p, each, min, max),
    oneOf: (v, opts, p) => v === undefined || opts.includes(v) || (V.bad(p, `${opts.map(o => `"${o}"`).join(', ')} 중 하나여야 합니다`), false),
    kebab: (v, p) => (typeof v === 'string' && KEBAB.test(v)) || (V.bad(p, '영문 소문자·숫자·하이픈만 사용합니다'), false),
    cell: (v, p) => typeof v === 'string' || isNum(v) || V.bad(p, '문자열 또는 숫자여야 합니다'),
    uniq: (arr, key, p) => {
      const s = new Set()
      if (Array.isArray(arr)) arr.forEach((x, i) => {
        const v = x?.[key]
        if (v === undefined) return
        if (s.has(v)) V.bad(`${p}[${i}].${key}`, `중복된 값 "${v}"`)
        s.add(v)
      })
    },
    bool: (o, k, p) => o[k] === undefined || typeof o[k] === 'boolean' || V.bad(`${p}.${k}`, 'true 또는 false여야 합니다'),
    img: (src, p) => {
      if (!isStr(src)) return V.bad(p, '이미지 파일 경로 문자열이어야 합니다')
      if (/^data:/i.test(src)) return V.bad(p, 'base64(data:)는 쓰지 않습니다. 파일 경로를 쓰세요')
      if (!IMG_TYPES[path.extname(src).toLowerCase()]) return V.bad(p, 'jpg, jpeg, png, webp, gif 파일만 쓸 수 있습니다')
      if (V.baseDir === undefined) return
      const f = path.resolve(V.baseDir, src)
      let size
      try { size = fs.statSync(f).size } catch { return V.bad(p, `파일이 없습니다: ${f}`) }
      if (size > 2 * 1024 * 1024) V.bad(p, `2MB를 넘습니다 (${f}). 줄여서 .showtell/assets/에 두세요`)
      else if (size > 500 * 1024) V.warn(p, `500KB를 넘습니다 (${f}). 줄이면 결과물이 가벼워집니다`)
    },
  }
  return h
}

// ---------- units: 셀 수 있는 대상, 점 하나 = 하나 ----------
// 상태 사이 전환을 분류한다. of(세분)·from(합치기)·단일 그룹 분할만 점이 이동하고, 나머지는 디졸브.
function unitsModel(st, states, paths, bad) {
  const N = st.total
  const abs = []
  let layout = st.layout || 'waffle'
  let failed = false
  const sig = g => `${g.label}\u0000${g.n}`
  for (let k = 0; k < states.length; k++) {
    const s = states[k], p = paths[k], prev = abs[k - 1]
    const err = (q, m) => { failed = true; bad(q, m) }
    if (s.layout) layout = s.layout
    const fresh = s.groups !== undefined
    let G, kind = k ? 'same' : null
    if (!fresh) G = prev ? prev.groups.map(g => ({ ...g, of: undefined, from: undefined })) : []
    else {
      G = s.groups.map(g => ({ label: g.label ?? '', n: g.n, key: g.key, rest: g.n === 'rest', of: g.of, from: g.from }))
      const e0 = failed
      failed = false
      const hasOf = G.some(g => g.of !== undefined), hasFrom = G.some(g => g.from !== undefined)
      if (k === 0 && (hasOf || hasFrom)) err(`${p}.groups`, '첫 상태에는 of/from을 쓸 수 없습니다')
      if (hasOf && hasFrom) err(`${p}.groups`, 'of와 from을 한 상태에 섞을 수 없습니다')
      const seen = new Set()
      G.forEach((g, i) => {
        if (!g.label && !g.rest) err(`${p}.groups[${i}].label`, '필수입니다 (rest 그룹만 생략할 수 있습니다)')
        if (g.label && seen.has(g.label)) err(`${p}.groups[${i}].label`, `같은 상태에 중복된 라벨 "${g.label}"`)
        if (g.label) seen.add(g.label)
        if (g.rest && g.from) err(`${p}.groups[${i}].n`, 'from 그룹은 rest일 수 없습니다')
        if (hasOf && g.rest && g.of === undefined) err(`${p}.groups[${i}].of`, 'of가 있는 상태의 rest 그룹은 of가 필요합니다')
      })
      if (!failed) {
        // rest 개수 계산: 부모(of)별로, of가 없으면 전체 기준
        const buckets = new Map()
        G.forEach((g, i) => {
          if (hasOf && g.of === undefined) return
          const b = hasOf ? g.of : ''
          if (!buckets.has(b)) buckets.set(b, [])
          buckets.get(b).push(i)
        })
        if (hasFrom) buckets.clear()
        for (const [b, idx] of buckets) {
          const whole = hasOf ? prev.groups.find(x => x.label && x.label === b) : { n: N }
          if (!whole) { err(`${p}.groups`, `of "${b}": 이전 상태에 그런 라벨이 없습니다`); continue }
          const rests = idx.filter(i => G[i].rest)
          if (rests.length > 1) { err(`${p}.groups`, 'rest 그룹은 하나만 쓸 수 있습니다'); continue }
          const sum = idx.reduce((a, i) => a + (G[i].rest ? 0 : G[i].n), 0)
          if (rests.length) {
            const r = whole.n - sum
            if (r < 1) err(`${p}.groups`, `rest가 1 이상이어야 합니다 (${hasOf ? `"${b}"` : 'total'} ${whole.n}, 나머지 합 ${sum})`)
            else G[rests[0]].n = r
          } else if (sum !== whole.n) err(`${p}.groups`, hasOf ? `"${b}"의 하위 그룹 합 ${sum} ≠ ${whole.n}` : `합 ${sum} ≠ total ${N}`)
        }
      }
      if (!failed && hasFrom) {
        const used = new Set()
        G.forEach((g, i) => {
          if (!g.from) return
          let sum = 0
          g.from.forEach((l, j) => {
            const x = prev.groups.find(y => y.label && y.label === l)
            if (!x) return err(`${p}.groups[${i}].from[${j}]`, `이전 상태에 "${l}"이 없습니다`)
            if (used.has(l)) err(`${p}.groups[${i}].from[${j}]`, `"${l}"을 두 번 합칠 수 없습니다`)
            used.add(l)
            sum += x.n
          })
          if (!failed && sum !== g.n) err(`${p}.groups[${i}].n`, `from으로 합친 개수 ${sum}과 같아야 합니다`)
        })
        if (!failed) {
          prev.groups.forEach(x => { if (!used.has(x.label) && !G.some(g => !g.from && sig(g) === sig(x))) err(`${p}.groups`, `이전 상태의 "${x.label || 'rest'}"가 사라졌습니다. from에 넣거나 그대로 두세요`) })
          G.forEach((g, i) => { if (!g.from && !prev.groups.some(x => sig(x) === sig(g))) err(`${p}.groups[${i}]`, 'from이 없는 그룹은 이전 상태와 라벨·개수가 같아야 합니다') })
        }
        kind = 'merge'
      }
      if (!failed && hasOf) {
        const parents = new Set(G.filter(g => g.of !== undefined).map(g => g.of))
        prev.groups.forEach(x => { if (!parents.has(x.label) && !G.some(g => g.of === undefined && sig(g) === sig(x))) err(`${p}.groups`, `이전 상태의 "${x.label || 'rest'}"가 사라졌습니다. of로 나누거나 그대로 두세요`) })
        G.forEach((g, i) => { if (g.of === undefined && !prev.groups.some(x => sig(x) === sig(g))) err(`${p}.groups[${i}]`, 'of가 없는 그룹은 이전 상태와 라벨·개수가 같아야 합니다') })
        kind = 'refine'
      }
      if (!failed && k > 0 && !hasOf && !hasFrom) {
        if (G.length === prev.groups.length && G.every(g => prev.groups.some(x => sig(x) === sig(g)))) kind = 'same'
        else if (prev.groups.length === 1) kind = 'split' // 한 덩어리가 나뉘는 것은 포함 관계가 명확하다
        else kind = 'independent' // 교차표가 없으므로 점이 이동하지 않고 디졸브한다
      }
      if (!failed) { const sum = G.reduce((a, g) => a + g.n, 0); if (sum !== N) err(`${p}.groups`, `합 ${sum} ≠ total ${N}`) }
      failed = failed || e0
    }
    ;(s.focus || []).forEach((l, j) => { if (!G.some(g => g.label && g.label === l)) err(`${p}.focus[${j}]`, `이 상태에 "${l}" 그룹이 없습니다`) })
    abs.push({ layout, groups: G, focus: s.focus || [], kind })
  }
  if (failed) return null

  // 점 구성원: 같은 대상(점)이 상태를 거쳐 어디로 가는지
  const M = []
  const contiguous = G => { let c = 0; return G.map(g => Array.from({ length: g.n }, () => c++)) }
  abs.forEach((a, k) => {
    const G = a.groups, P = abs[k - 1], PM = M[k - 1]
    let m
    if (!k || a.kind === 'independent') m = contiguous(G)
    else {
      const used = new Set()
      const take = g => { const i = P.groups.findIndex((x, j) => !used.has(j) && sig(x) === sig(g)); used.add(i); return PM[i] }
      const byLabel = l => PM[P.groups.findIndex(x => x.label === l)]
      if (a.kind === 'same') m = G.map(take)
      else if (a.kind === 'split') { let c = 0; m = G.map(g => PM[0].slice(c, (c += g.n))) }
      else if (a.kind === 'refine') {
        const cur = {}
        m = G.map(g => {
          if (g.of === undefined) return take(g)
          const c = cur[g.of] || 0
          cur[g.of] = c + g.n
          return byLabel(g.of).slice(c, c + g.n)
        })
      } else m = G.map(g => (g.from ? g.from.flatMap(byLabel) : take(g)))
    }
    M.push(m)
  })

  const labelText = g => (g.rest ? plain(g.label) : `${plain(g.label)} ${g.n}${st.unit}`)
  const lines = g => Math.max(1, Math.ceil(textW(labelText(g)) / U_LABEL_W))
  // 높이는 점(무대 폭에 비례, cqw)과 라벨(고정 글자 크기, px)이 섞인다. CSS 식으로 두고, 비교용 추정치는 320px 무대 기준
  const cq = v => ({ css: `${r2(v)}cqw`, est: v })
  const px = v => ({ css: `${v}px`, est: v / 3.2 })
  const add = (a, b) => ({ css: `${a.css} + ${b.css}`, est: a.est + b.est })
  const mx = (a, b) => ({ css: `max(${a.css}, ${b.css})`, est: Math.max(a.est, b.est) })
  const labH = g => px(lines(g) * U_LINE) // 좁은 무대에서 줄바꿈되는 줄 수만큼 (넓은 무대에서는 한두 줄 여유)
  const place = (a, m, perRow) => {
    const pitch = 74 / perRow, xs = new Array(N), ys = new Array(N), labs = [], gy = []
    let h
    if (a.layout === 'waffle') {
      let s = 0, floor = null
      a.groups.forEach((g, gi) => {
        const row = cq(Math.floor(s / perRow) * pitch)
        m[gi].forEach(id => { xs[id] = 26 + (s % perRow) * pitch; ys[id] = Math.floor(s / perRow) * pitch; s++ })
        if (!g.label) return // 라벨 없는 rest는 표시하지 않음
        const y = floor ? mx(row, floor) : row // 라벨이 겹치지 않게 아래로 민다
        labs.push({ gi, y })
        floor = add(y, labH(g))
      })
      h = cq(Math.ceil(N / perRow) * pitch)
      if (floor) h = mx(h, floor)
    } else {
      let y = cq(0)
      a.groups.forEach((g, gi) => {
        gy[gi] = y
        if (g.label) labs.push({ gi, y })
        m[gi].forEach((id, j) => { xs[id] = 26 + (j % perRow) * pitch; ys[id] = Math.floor(j / perRow) * pitch })
        const dots = cq(Math.ceil(m[gi].length / perRow) * pitch)
        y = add(add(y, g.label ? mx(dots, labH(g)) : dots), cq(U_GAP))
      })
      h = add(y, cq(-U_GAP))
    }
    return { xs, ys, labs, gy, h }
  }
  let best = null
  for (const pr of PER_ROW) {
    const p = abs.map((a, k) => place(a, M[k], pr)), h = Math.max(...p.map(x => x.h.est))
    if (!best || h < best.h - 1e-9) best = { pr, p, h }
    if (h <= 100) break
  }
  return { N, abs, M, P: best.p, pitch: 74 / best.pr }
}

function renderUnits(st, states, ctx, paths) {
  const md = unitsModel(st, states, paths, (p, m) => { throw new Error(`${p}: ${m}`) })
  const { N, abs, M, P, pitch } = md
  const K = abs.length, sid = `st-${st.id}`
  const gOf = M.map(m => { const a = new Array(N); m.forEach((ids, gi) => ids.forEach(id => { a[id] = gi })); return a })
  let dots = ''
  for (let id = 0; id < N; id++) {
    let c = '', s = ''
    for (let k = 0; k < K; k++) { c += ` g${k}-${gOf[k][id]}`; s += `--x-${k}:${r2(P[k].xs[id])};--y-${k}:${r2(P[k].ys[id])};` }
    dots += `<i class="st-m st-pos st-f${c}" style="${s}--lag:${Math.round((id / N) * 250)}"></i>`
  }
  let css = ''
  abs.forEach((a, k) => a.groups.forEach((g, gi) => {
    const col = g.rest && !g.key ? 'var(--rest)' : g.key ? ctx.col(g.key) : ''
    if (col) css += `#${sid}[data-s="${k}"] .g${k}-${gi}{--col:${col}}`
    if (g.label && a.focus.includes(g.label)) css += `#${sid}.fx-${k}[data-s="${k}"] .g${k}-${gi}{--hot:1}`
    if (P[k].gy[gi]) css += `#${sid}[data-s="${k}"] .g${k}-${gi}{--gy:calc(${P[k].gy[gi].css})}` // 묶음 시작 높이 (라벨 px 포함)
  }))
  ctx.css.push(css)
  const labs = [], last = new Map()
  abs.forEach((a, k) => P[k].labs.forEach(l => {
    const g = a.groups[l.gi]
    const html = `${g.key ? `<i class="st-sw" style="background:${ctx.col(g.key)}"></i>` : ''}${inline(g.label)}${g.rest ? '' : ` <b>${g.n}</b>${esc(st.unit)}`}`
    const key = `${html}|${l.y.css}`
    let e = last.get(key)
    if (!e || e.s[e.s.length - 1] !== k - 1) { e = { html, y: l.y, s: [], f: [] }; last.set(key, e); labs.push(e) }
    e.s.push(k)
    if (a.focus.includes(g.label)) e.f.push(k)
  }))
  const labHtml = labs.map(e => `<span class="st-lab st-v st-f${ks('s', e.s)}${ks('f', e.f)}" style="top:calc(${e.y.css})">${e.html}</span>`).join('')
  const lines = abs.map(a => a.groups.filter(g => g.label).map(g => {
    const t = g.rest ? inline(g.label) : `${inline(g.label)} ${g.n}${esc(st.unit)}`
    return a.focus.includes(g.label) ? `<strong>${t}</strong>` : t
  }).join(' · '))
  const maxH = Math.max(...P.map(x => x.h.est))
  return {
    body: `<div class="st-field" style="--d:${r2(pitch * 0.8)};${P.map((x, k) => `--h-${k}:calc(${x.h.css})`).join(';')}">${dots}${labHtml}</div><p class="st-unitnote" data-chrome>■ 점 1개 = 1${esc(st.unit)}</p>`,
    lines,
    fallback: '',
    ar: (maxH + 8) / 100,
    fx: abs.map((a, k) => (a.focus.length ? k : -1)).filter(k => k >= 0),
    dis: abs.map((a, k) => (a.kind === 'independent' ? k : -1)).filter(k => k > 0),
    hide: true,
  }
}

// ---------- dials: 눈금 위의 값·범위, 사진을 EXIF 값 위치에 꽂는다 ----------
function dialsModel(st, states) {
  let show = st.items.map(i => i.id)
  const cur = Object.fromEntries(st.items.map(i => [i.id, { label: i.label, text: i.text, at: { ...i.at }, labels: { ...(i.labels || {}) } }]))
  return states.map(s => {
    if (s.show) show = s.show
    for (const [id, d] of Object.entries(s.set || {})) {
      const c = cur[id]
      if (!c || !isObj(d)) continue
      const labels = { ...c.labels }
      // 값을 바꾸면서 라벨을 주지 않으면 옛 라벨을 지운다 (오늘 범위 라벨이 내일 값에 붙지 않게)
      for (const ax in d.at || {}) if (!(d.labels && ax in d.labels)) delete labels[ax]
      cur[id] = { label: d.label ?? c.label, text: d.text ?? c.text, at: { ...c.at, ...(d.at || {}) }, labels: Object.assign(labels, d.labels || {}) }
    }
    const items = {}
    for (const id in cur) items[id] = { ...cur[id], at: Object.fromEntries(Object.entries(cur[id].at).filter(([, v]) => v !== null)) }
    return { show, focus: s.focus || null, axes: s.axes || null, items }
  })
}
const dPos = (ax, x) => (ax.stops ? (ax.stops.length === 1 ? 50 : 5 + (90 * ax.stops.indexOf(x)) / (ax.stops.length - 1)) : 5 + 90 * (ax.log ? Math.log(x / ax.min) / Math.log(ax.max / ax.min) : (x - ax.min) / (ax.max - ax.min)))
const dSpan = (ax, v) => {
  const [a, b] = Array.isArray(v) ? [v[0] === null ? 1 : dPos(ax, v[0]), v[1] === null ? 99 : dPos(ax, v[1])] : [dPos(ax, v), dPos(ax, v)]
  return [a, b - a]
}
const dVal = (ax, v) => (typeof v === 'string' ? v : `${ax.sign && v > 0 ? '+' : ''}${v}${ax.unit || ''}`) // 원문 표기 그대로
const dInAx = (ax, x) => (ax.stops ? ax.stops.includes(x) : isNum(x) && x >= ax.min && x <= ax.max)
const dOrder = (ax, x) => (ax.stops ? ax.stops.indexOf(x) : x)
const dOk = (ax, v) => (Array.isArray(v) ? v.length === 2 && v.every(x => x === null || dInAx(ax, x)) && !(v[0] !== null && v[1] !== null && dOrder(ax, v[0]) > dOrder(ax, v[1])) : dInAx(ax, v))

function renderDials(st, states, ctx) {
  const abs = dialsModel(st, states), K = abs.length
  const AX = st.axes, IT = st.items
  const num = new Map(IT.map((it, i) => [it.id, i + 1]))
  const sayAx = (ax, d) => d.labels[ax.key] ?? (Array.isArray(d.at[ax.key]) ? '' : dVal(ax, d.at[ax.key]))
  const vis = (a, id, ax) => a.show.includes(id) && a.items[id].at[ax.key] !== undefined
  const hotI = (a, id) => !a.focus || a.focus.includes(id)
  const hotA = (a, key) => !a.axes || a.axes.includes(key)
  const ksf = pred => abs.map((a, k) => (pred(a, k) ? k : -1)).filter(k => k >= 0)
  const fill = arr => { let last = arr.find(v => v !== undefined); return Array.from({ length: K }, (_, k) => (arr[k] !== undefined ? (last = arr[k]) : last)) }
  const pin = it => `<b data-chrome>${num.get(it.id)}</b>`
  const sw = it => `<i class="st-key"${it.key ? ` style="background:${ctx.col(it.key)};--ink:${ctx.ink(it.key)}"` : ''}>${pin(it)}</i>`
  let body = '<div class="st-dials">'
  for (const ax of AX) {
    const marks = IT.filter(it => abs.some(a => vis(a, it.id, ax)))
    const lane = {}
    const lanes = abs.map(() => 1)
    abs.forEach((a, k) => {
      const ends = []
      marks.filter(it => vis(a, it.id, ax)).map(it => ({ id: it.id, x: dSpan(ax, a.items[it.id].at[ax.key]) })).sort((p, q) => p.x[0] - q.x[0]).forEach(m => {
        let l = ends.findIndex(e => e + 7 <= m.x[0]) // 가까운 핀은 다른 줄로
        if (l < 0) { l = ends.length; ends.push(0) }
        ends[l] = m.x[0] + m.x[1]
        ;(lane[m.id] ||= [])[k] = l
      })
      lanes[k] = Math.max(1, ends.length)
    })
    const ticks = ax.stops ? ax.stops.map(s => [dPos(ax, s), s]) : (ax.ticks || []).map(t => [dPos(ax, t), dVal(ax, t)])
    body += `<div class="st-axis st-f${ks('f', ksf(a => hotA(a, ax.key)))}"><p class="st-axl">${inline(ax.label)}</p><div class="st-rule" style="${lanes.map((l, k) => `--lanes-${k}:${l}`).join(';')}">`
    body += ticks.map(([x, t]) => `<span class="st-tick" style="left:${r2(x)}%">${esc(t)}</span>`).join('')
    for (const it of marks) {
      const xs = fill(abs.map(a => (vis(a, it.id, ax) ? dSpan(ax, a.items[it.id].at[ax.key]) : undefined)))
      const ln = fill(lane[it.id] || [])
      let s = it.key ? `--col:${ctx.col(it.key)};--ink:${ctx.ink(it.key)};` : ''
      for (let k = 0; k < K; k++) s += `--x-${k}:${r2(xs[k][0])};--w-${k}:${r2(xs[k][1])};--y-${k}:${ln[k] ?? 0};`
      body += `<i class="st-mk st-pos st-v st-f t-${it.tone || 'data'}${ks('s', ksf(a => vis(a, it.id, ax)))}${ks('f', ksf(a => hotI(a, it.id)))}" style="${s}">${pin(it)}</i>`
    }
    body += '</div><ul class="st-dl">'
    for (const it of marks) {
      const vs = variants(abs.map(a => (vis(a, it.id, ax) ? `<span class="st-dn">${inline(a.items[it.id].label)}</span> ${inline(sayAx(ax, a.items[it.id]))}` : null)))
      body += `<li class="st-col st-v st-f${ks('s', ksf(a => vis(a, it.id, ax)))}${ks('f', ksf(a => hotI(a, it.id)))}"><div>${sw(it)}${stack(vs)}</div></li>`
    }
    body += '</ul></div>'
  }
  const noted = IT.filter(it => !it.photo && abs.some(a => a.items[it.id].text))
  if (noted.length) body += `<ul class="st-dl st-dnotes">${noted.map(it => `<li class="st-col st-v st-f${ks('s', ksf(a => a.show.includes(it.id) && !!a.items[it.id].text))}${ks('f', ksf(a => hotI(a, it.id)))}"><div>${sw(it)}${stack(variants(abs.map(a => (a.show.includes(it.id) && a.items[it.id].text ? `<span class="st-dn">${inline(a.items[it.id].label)}</span> ${inline(a.items[it.id].text)}` : null))))}</div></li>`).join('')}</ul>`
  const ph = IT.filter(it => it.photo)
  if (ph.length) body += `<div class="st-photos">${ph.map(it => `<figure class="st-ph st-v st-f${ks('s', ksf(a => a.show.includes(it.id)))}${ks('f', ksf(a => hotI(a, it.id)))}" style="${paOf(it.photo, ctx)}${it.key ? `--col:${ctx.col(it.key)}` : ''}"><div class="st-phi">${imgTag(it.photo, it.alt || it.label, ctx)}${`<span class="st-pn">${sw(it)}</span>`}</div><figcaption>${stack(variants(abs.map(a => `<strong>${inline(a.items[it.id].label)}</strong>${a.items[it.id].text ? ` ${inline(a.items[it.id].text)}` : ''}`)))}</figcaption></figure>`).join('')}</div>`
  const uncs = IT.filter(it => it.uncertain)
  if (uncs.length) body += uncs.map(it => `<p class="st-uncl">${sw(it)} ${inline(it.label)}${unc(it.uncertain)}</p>`).join('')
  body += '</div>'

  const lines = abs.map(a => a.show.map(id => {
    const it = IT.find(i => i.id === id), d = a.items[id]
    const segs = AX.filter(ax => d.at[ax.key] !== undefined).map(ax => `${inline(ax.label)}: ${inline(sayAx(ax, d))}`)
    const focused = a.focus && a.focus.includes(id)
    const t = d.text && (!it.photo || focused) ? ` (${inline(d.text)})` : ''
    const s = `${inline(d.label)}${segs.length ? ` — ${segs.join(', ')}` : ''}${t}`
    return (focused ? `<strong>${s}</strong>` : s) + unc(it.uncertain)
  }).join(' / '))
  const fallback = `<table><thead><tr><th scope="col">상태</th>${AX.map(ax => `<th scope="col">${inline(ax.label)}</th>`).join('')}</tr></thead><tbody>${abs.map((a, k) => `<tr><th scope="row">${states[k].label ? inline(states[k].label) : `<span data-chrome>${k + 1}</span>`}</th>${AX.map(ax => `<td>${a.show.filter(id => a.items[id].at[ax.key] !== undefined).map(id => `${inline(a.items[id].label)}: ${inline(sayAx(ax, a.items[id]))}`).join('<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  const listRows = AX.reduce((n, ax) => n + IT.filter(it => abs.some(a => vis(a, it.id, ax))).length, 0)
  return {
    body, lines, fallback,
    ar: (AX.length * 72 + listRows * 24 + (noted.length * 24) + (ph.length ? 190 : 0)) / 600,
    fx: abs.map((a, k) => (a.focus || a.axes ? k : -1)).filter(k => k >= 0),
    dis: [],
    hide: true,
  }
}

// ---------- track: 순서 있는 구간 위의 값 ----------
function trackModel(st, states) {
  let rows = st.rows.map(r => r.id), frames = (st.frames || []).map(f => f.id)
  return states.map(s => {
    if (s.rows) rows = s.rows
    if (s.frames) frames = s.frames
    return { rows, frames, focus: (s.focus || []).map(String) }
  })
}
function renderTrack(st, states, ctx) {
  const abs = trackModel(st, states)
  const bins = st.x.bins.map(String), nb = bins.length, xu = st.x.unit || ''
  const bi = b => bins.indexOf(String(b))
  const FR = (st.frames || []).slice().sort((a, b) => bi(a.bin) - bi(b.bin)), NT = st.notes || []
  const ksf = pred => abs.map((a, k) => (pred(a, k) ? k : -1)).filter(k => k >= 0)
  const hotB = (a, i) => !a.focus.length || a.focus.includes(bins[i])
  const cv = (r, v) => (v === null ? '—' : r.mark === 'text' ? inline(v) : esc(`${v}${r.unit || ''}`)) // 원문 표기 그대로
  const norm = r => {
    const nums = r.values.filter(isNum)
    if (r.mark === 'bar') { const m = r.max ?? Math.max(...nums); return v => (m > 0 ? v / m : 0) }
    const f = r.scale === 'log' ? Math.log : x => x
    const lo = f(Math.min(...nums)), hi = f(Math.max(...nums))
    return v => (hi === lo ? 0.5 : (f(v) - lo) / (hi - lo))
  }
  let body = `<div class="st-track${nb > 8 ? ' st-dense' : ''}" style="--nb:${nb}">`
  for (const r of st.rows) {
    const n = r.mark === 'text' ? null : norm(r)
    body += `<div class="st-trow st-col st-v t-${r.mark}${ks('s', ksf(a => a.rows.includes(r.id)))}"><div><p class="st-tlab">${inline(r.label)}${r.unit && r.mark !== 'text' ? ` <span>(${esc(r.unit)})</span>` : ''}</p><div class="st-tgrid">`
    r.values.forEach((v, i) => {
      const inner = v === null ? '' : r.mark === 'bar' ? `<span class="st-tv">${cv(r, v)}</span><i class="st-tbar" style="--v:${r2(n(v) * 100)}"></i>` : r.mark === 'dot' ? `<i class="st-tdot" style="--v:${r2(8 + n(v) * 70)}"><span class="st-tv">${cv(r, v)}</span></i>` : `<span class="st-tt">${cv(r, v)}</span>`
      body += `<div class="st-tc st-f b-${i}${ks('f', ksf(a => hotB(a, i)))}">${inner}</div>`
    })
    body += `</div>${r.caption ? `<p class="st-tcap">${inline(r.caption)}</p>` : ''}</div></div>`
  }
  const fb = new Set(FR.map(f => bi(f.bin)))
  body += `<div class="st-tgrid st-tx">${bins.map((b, i) => `<span class="st-f b-${i}${ks('f', ksf(a => hotB(a, i)))}">${esc(b)}${fb.has(i) ? `<i class="st-tfm st-v${ks('s', ksf(a => FR.some(f => bi(f.bin) === i && a.frames.includes(f.id))))}" aria-hidden="true">▲</i>` : ''}</span>`).join('')}</div><p class="st-txl">${inline(st.x.label)}${xu ? ` (${esc(xu)})` : ''}</p>`
  if (NT.length) body += `<div class="st-tnotes">${NT.map(nt => `<p class="st-tnote st-v${ks('s', ksf(a => a.focus.includes(String(nt.bin))))}"><strong>${esc(String(nt.bin))}${esc(xu)}</strong> ${inline(nt.text)}</p>`).join('')}</div>`
  if (FR.length) body += `<div class="st-photos st-tframes">${FR.map(fr => `<figure class="st-ph st-v st-f${ks('s', ksf(a => a.frames.includes(fr.id)))}${ks('f', ksf(a => !a.focus.length || a.focus.includes(String(fr.bin))))}" style="${paOf(fr.src, ctx)}"><div class="st-phi">${imgTag(fr.src, fr.label, ctx)}</div><figcaption><strong>${inline(fr.label)}</strong>${fr.text ? ` ${inline(fr.text)}` : ''}</figcaption></figure>`).join('')}</div>`
  const readout = i => [`<strong>${esc(bins[i])}${esc(xu)}</strong>`, ...st.rows.map(r => `${inline(r.label)} ${cv(r, r.values[i])}`), ...FR.filter(f => bi(f.bin) === i).map(f => `사진 ${inline(f.label)}`), ...NT.filter(nt => bi(nt.bin) === i).map(nt => inline(nt.text))].join(' · ')
  if (st.scrub) body += `<div class="st-ctl st-scrubw"><input type="range" class="st-scrub" min="0" max="${nb - 1}" step="1" value="0" aria-label="${esc(plain(st.x.label))}" aria-valuetext="${esc(bins[0] + xu)}"><div class="st-ros"><p class="st-rohint">막대를 움직여 구간별 정확한 값을 봅니다</p>${bins.map((_, i) => `<p class="st-ro b-${i}">${readout(i)}</p>`).join('')}</div></div>`
  body += '</div>'
  const lines = abs.map(a => {
    const parts = [st.rows.filter(r => a.rows.includes(r.id)).map(r => inline(r.label)).join(' · ')]
    a.focus.forEach(b => {
      const i = bi(b)
      parts.push(`<strong>${esc(b)}${esc(xu)}</strong>: ${st.rows.filter(r => a.rows.includes(r.id) && r.values[i] !== null).map(r => `${inline(r.label)} ${cv(r, r.values[i])}`).join(', ')}`)
      NT.filter(nt => String(nt.bin) === b).forEach(nt => parts.push(inline(nt.text)))
    })
    const fs_ = FR.filter(f => a.frames.includes(f.id))
    if (fs_.length) parts.push(`사진: ${fs_.map(f => inline(f.label)).join(', ')}`)
    return parts.filter(Boolean).join(' / ')
  })
  const fallback = `<table><thead><tr><th scope="col">${inline(st.x.label)}${xu ? ` (${esc(xu)})` : ''}</th>${st.rows.map(r => `<th scope="col">${inline(r.label)}</th>`).join('')}${FR.length ? '<th scope="col">사진</th>' : ''}${NT.length ? '<th scope="col">메모</th>' : ''}</tr></thead><tbody>${bins.map((b, i) => `<tr><th scope="row">${esc(b)}</th>${st.rows.map(r => `<td${r.mark === 'text' ? '' : ' class="num"'}>${cv(r, r.values[i])}</td>`).join('')}${FR.length ? `<td>${FR.filter(f => bi(f.bin) === i).map(f => inline(f.label)).join(', ')}</td>` : ''}${NT.length ? `<td>${NT.filter(nt => bi(nt.bin) === i).map(nt => inline(nt.text)).join('<br>')}</td>` : ''}</tr>`).join('')}</tbody></table>`
  return {
    body, lines, fallback,
    ar: (st.rows.length * 100 + 60 + (FR.length ? 150 : 0) + (st.scrub ? 60 : 0)) / 600,
    fx: abs.map((a, k) => (a.focus.length ? k : -1)).filter(k => k >= 0),
    dis: [],
    hide: false,
  }
}

// ---------- lookup: 같은 항목을 여러 경우로 비교 ----------
function lookupModel(st, states) {
  let record = null
  return states.map(s => { if (s.record) record = s.record; return { record, focus: s.focus || [] } })
}
const sameCell = (a, b) => plain(cellRaw(a)) === plain(cellRaw(b))
function renderLookup(st, states, ctx) {
  const abs = lookupModel(st, states), F = st.fields, R = st.records
  const rec = id => R.find(r => r.id === id), base = st.base ? rec(st.base) : null
  const ksf = pred => abs.map((a, k) => (pred(a, k) ? k : -1)).filter(k => k >= 0)
  const hotF = (a, f) => !a.focus.length || a.focus.includes(f)
  const note = (r, i) => (r.notes && r.notes[i] ? `<small>${inline(r.notes[i])}</small>` : '')
  const head = r => `${inline(r.label)}${r.badge ? ` <span class="st-badge">${esc(r.badge)}</span>` : ''}${r === base ? ' <span class="st-base">기준</span>' : ''}`
  const changed = (r, i) => base && r !== base && !sameCell(r.values[i], base.values[i])
  const full = (mark, focusRows) => `<table class="st-lkfull"><thead><tr><th scope="col"></th>${R.map(r => `<th scope="col">${head(r)}</th>`).join('')}</tr></thead><tbody>${F.map((f, i) => `<tr${focusRows ? ` class="st-f${ks('f', ksf(a => hotF(a, f)))}"` : ''}><th scope="row">${inline(f)}</th>${R.map(r => `<td>${cellHtml(r.values[i])}${mark && changed(r, i) ? ' <span class="st-chg">변경</span>' : ''}${note(r, i)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  const fx = abs.map((a, k) => (a.focus.length ? k : -1)).filter(k => k >= 0)
  if (st.view === 'full') {
    return { body: `<div class="st-tablewrap">${full(!!base, true)}</div>`, lines: abs.map(a => a.focus.map(inline).join(', ')), fallback: '', ar: (F.length * 44 + 60) / 600, fx, dis: [], hide: false }
  }
  const rows = F.map((f, i) => {
    const vals = variants(abs.map(a => cellHtml(rec(a.record).values[i])))
    const notes = variants(abs.map(a => note(rec(a.record), i) || null))
    return `<div class="st-lr st-f${ks('f', ksf(a => hotF(a, f)))}${ks('c', ksf(a => changed(rec(a.record), i)))}"><dt>${inline(f)}</dt><dd>${stack(vals)}${stack(notes)}</dd></div>`
  }).join('')
  const lines = abs.map(a => {
    const r = rec(a.record)
    const ch = base && r !== base ? F.filter((f, i) => changed(r, i)) : null
    return `<strong>${inline(r.label)}</strong>${ch ? ` · 바뀐 칸: ${ch.length ? ch.map(inline).join(', ') : '없음'}` : ''}${a.focus.length ? ` · ${a.focus.map(inline).join(', ')}` : ''}`
  })
  return {
    body: `<div class="st-lk"><p class="st-lkh">${stack(variants(abs.map(a => head(rec(a.record)))))}</p><dl>${rows}</dl></div>`,
    lines, fallback: full(true, false), ar: (F.length * 40 + 80) / 600, fx, dis: [], hide: true,
  }
}

// ---------- photos: 증거로서의 사진, 또는 도식 프레임 ----------
function photosModel(st, states) {
  let show = st.items.map(i => i.id)
  return states.map(s => { if (s.show) show = s.show; return { show, focus: s.focus || null, zones: s.zones || [], detail: s.detail || null } })
}
function renderPhotos(st, states, ctx) {
  const abs = photosModel(st, states), IT = st.items
  const ksf = pred => abs.map((a, k) => (pred(a, k) ? k : -1)).filter(k => k >= 0)
  // compare: 같은 순서의 메타 값이 사진마다 다르면 강조
  const diff = (ii, j) => st.compare && IT.some(o => o !== IT[ii] && o.meta && o.meta[j] !== undefined && o.meta[j] !== IT[ii].meta[j])
  const body = `<div class="st-photos">${IT.map((it, ii) => {
    const zs = it.zones || []
    const media = it.src ? imgTag(it.src, it.alt || it.name, ctx) : `<div class="st-frame" style="aspect-ratio:${(it.frame || '3:2').replace(':', '/')}"><span>${inline(it.name)}</span></div>`
    const det = it.detail ? `<div class="st-detail st-v${ks('s', ksf(a => a.detail === it.id))}">${imgTag(it.detail.src, it.detail.text, ctx)}</div>` : ''
    const zones = zs.map((z, zi) => `<span class="st-zone z-${z.area} st-v${ks('s', ksf(a => a.zones.includes(`${it.id}.${z.id}`)))}" aria-hidden="true"><b data-chrome>${zi + 1}</b></span>`).join('')
    const notes = [...zs.map((z, zi) => ({ html: `<b class="st-zn" data-chrome>${zi + 1}</b> ${inline(z.text)}`, s: ksf(a => a.zones.includes(`${it.id}.${z.id}`)) })), ...(it.detail ? [{ html: inline(it.detail.text), s: ksf(a => a.detail === it.id) }] : [])].filter(v => v.s.length)
    const meta = it.meta ? `<span class="st-chips">${it.meta.map((m, j) => `<span class="st-chip${diff(ii, j) ? ' is-diff' : ''}">${inline(m)}</span>`).join('')}</span>` : ''
    return `<figure class="st-ph st-v st-f${ks('s', ksf(a => a.show.includes(it.id)))}${ks('f', ksf(a => !a.focus || a.focus === it.id))}" style="${it.src ? paOf(it.src, ctx) : `--pa:${r2(((fw, fh) => fw / fh)(...(it.frame || '3:2').split(':')))};`}${it.key ? `--col:${ctx.col(it.key)}` : ''}"><div class="st-phi">${media}${det}${zones}</div><figcaption><strong>${inline(it.name)}</strong>${meta}${it.text ? `<span class="st-ptx">${inline(it.text)}</span>` : ''}${unc(it.uncertain)}${notes.length ? `<span class="st-stack st-pnotes">${notes.map(v => `<span class="st-v${ks('s', v.s)}">${v.html}</span>`).join('')}</span>` : ''}</figcaption></figure>`
  }).join('')}</div>`
  const item = id => IT.find(i => i.id === id)
  const lines = abs.map(a => {
    const parts = []
    if (a.focus) { const it = item(a.focus); parts.push(`<strong>${inline(it.name)}</strong>${it.text ? ` — ${inline(it.text)}` : ''}`) }
    else parts.push(a.show.map(id => inline(item(id).name)).join(' · '))
    a.zones.forEach(z => { const [i, zz] = z.split('.'); parts.push(inline(item(i).zones.find(q => q.id === zz).text)) })
    if (a.detail) parts.push(inline(item(a.detail).detail.text))
    return parts.join(' / ')
  })
  return {
    body, lines, fallback: '', ar: IT.length > 2 ? 0.55 : 0.75,
    fx: abs.map((a, k) => (a.focus ? k : -1)).filter(k => k >= 0),
    dis: [], hide: false,
  }
}

const RENDER = { units: renderUnits, dials: renderDials, track: renderTrack, lookup: renderLookup, photos: renderPhotos }

// ---------- 무대 검증 ----------
function checkStage(st, states, paths, sp, h, V, opt) {
  const t = st.type
  const ctl = ctlOf(st)
  const e0 = V.errs.length
  const stateCommon = (s, p) => {
    if (!h.obj(s, p)) return false
    h.str(s, 'say', p, true)
    if (isStr(s.say) && plain(s.say).length > 100) V.warn(`${p}.say`, '100자를 넘습니다. 한 비트에는 한 가지만 말합니다')
    h.str(s, 'label', p, true)
    if (!opt.block && ctl !== 'steps' && !isStr(s.label)) V.bad(`${p}.label`, `${ctl} 무대의 상태에는 label이 필요합니다`)
    h.str(s, 'uncertain', p, true)
    return true
  }
  if (!states.every((s, k) => stateCommon(s, paths[k]))) return
  const strList = (o, k, p) => h.opt(o, k, p, h.text)

  if (t === 'units') {
    if (!Number.isInteger(st.total) || st.total < 1 || st.total > 1500) V.bad(`${sp}.total`, '1~1500 사이의 정수여야 합니다 (더 크면 track을 쓰세요)')
    h.str(st, 'unit', sp)
    h.oneOf(st.layout, ['waffle', 'rows'], `${sp}.layout`)
    if (!opt.block && ctl !== 'steps') V.bad(`${sp}.control`, 'units는 steps만 쓸 수 있습니다')
    states.forEach((s, k) => {
      const p = paths[k]
      h.oneOf(s.layout, ['waffle', 'rows'], `${p}.layout`)
      if (s.groups === undefined) { if (k === 0) V.bad(`${p}.groups`, '첫 상태에는 groups가 필요합니다') }
      else h.list(s, 'groups', p, (g, gp) => {
        if (!h.obj(g, gp)) return
        h.str(g, 'label', gp, true)
        if (!(g.n === 'rest' || (Number.isInteger(g.n) && g.n > 0))) V.bad(`${gp}.n`, '양의 정수 또는 "rest"여야 합니다')
        if (g.key !== undefined) h.kebab(g.key, `${gp}.key`)
        h.str(g, 'of', gp, true)
        strList(g, 'from', gp)
      }, 1, 16)
      strList(s, 'focus', p)
    })
    if (V.errs.length === e0) unitsModel(st, states, paths, V.bad)
  }

  if (t === 'dials') {
    const axKeys = new Set()
    h.list(st, 'axes', sp, (ax, ap) => {
      if (!h.obj(ax, ap)) return
      if (h.kebab(ax.key, `${ap}.key`)) { if (axKeys.has(ax.key)) V.bad(`${ap}.key`, `중복된 key "${ax.key}"`); axKeys.add(ax.key) }
      h.str(ax, 'label', ap)
      if (ax.stops !== undefined) {
        if (h.list(ax, 'stops', ap, h.text, 2, 10)) {
          if (new Set(ax.stops).size !== ax.stops.length) V.bad(`${ap}.stops`, '중복된 값이 있습니다')
          if (90 / (ax.stops.length - 1) < 12) V.warn(`${ap}.stops`, '눈금이 너무 가깝습니다 (stops 8개 이하 권장)')
        }
        if (ax.min !== undefined || ax.max !== undefined) V.bad(ap, 'stops와 min/max를 함께 쓸 수 없습니다')
      } else {
        if (!isNum(ax.min) || !isNum(ax.max) || ax.min >= ax.max) V.bad(ap, 'stops가 없으면 min < max인 숫자 min, max가 필요합니다')
        h.bool(ax, 'log', ap)
        if (ax.log && !(ax.min > 0)) V.bad(`${ap}.min`, 'log 축은 min이 0보다 커야 합니다')
        h.bool(ax, 'sign', ap)
        h.str(ax, 'unit', ap, true)
        if (h.opt(ax, 'ticks', ap, (v, tp) => { if (!isNum(v) || v < ax.min || v > ax.max) V.bad(tp, 'min~max 사이의 원문 값이어야 합니다') }) && Array.isArray(ax.ticks) && isNum(ax.min) && isNum(ax.max) && ax.min < ax.max && V.errs.length === e0) {
          const xs = ax.ticks.map(v => dPos(ax, v)).sort((a, b) => a - b)
          xs.forEach((x, i) => { if (i && x - xs[i - 1] < 12) V.warn(`${ap}.ticks`, '눈금이 너무 가깝습니다 (축 길이의 12% 미만)') })
        }
      }
    }, 1, 6)
    const ids = new Set()
    h.list(st, 'items', sp, (it, ip) => {
      if (!h.obj(it, ip)) return
      if (h.kebab(it.id, `${ip}.id`)) { if (ids.has(it.id)) V.bad(`${ip}.id`, `중복된 id "${it.id}"`); ids.add(it.id) }
      h.str(it, 'label', ip)
      h.oneOf(it.tone, ['data', 'target', 'zone'], `${ip}.tone`)
      if (it.key !== undefined) h.kebab(it.key, `${ip}.key`)
      if (it.photo !== undefined) h.img(it.photo, `${ip}.photo`)
      h.str(it, 'alt', ip, true)
      h.str(it, 'text', ip, true)
      h.str(it, 'uncertain', ip, true)
      if (h.obj(it.at, `${ip}.at`)) for (const k in it.at) if (!axKeys.has(k)) V.bad(`${ip}.at.${k}`, '없는 축입니다')
      if (it.labels !== undefined && h.obj(it.labels, `${ip}.labels`)) for (const k in it.labels) { if (!axKeys.has(k)) V.bad(`${ip}.labels.${k}`, '없는 축입니다'); h.str(it.labels, k, `${ip}.labels`) }
    }, 1, 10)
    states.forEach((s, k) => {
      const p = paths[k]
      for (const key of ['show', 'focus']) h.opt(s, key, p, (v, q) => { if (!ids.has(v)) V.bad(q, `없는 항목 id "${v}"`) })
      h.opt(s, 'axes', p, (v, q) => { if (!axKeys.has(v)) V.bad(q, `없는 축 "${v}"`) })
      if (s.set !== undefined && h.obj(s.set, `${p}.set`)) for (const id in s.set) {
        const q = `${p}.set.${id}`
        if (!ids.has(id)) { V.bad(q, '없는 항목 id입니다'); continue }
        const d = s.set[id]
        if (!h.obj(d, q)) continue
        h.str(d, 'label', q, true)
        h.str(d, 'text', q, true)
        if (d.at !== undefined && h.obj(d.at, `${q}.at`)) for (const ax in d.at) if (!axKeys.has(ax)) V.bad(`${q}.at.${ax}`, '없는 축입니다')
        if (d.labels !== undefined && h.obj(d.labels, `${q}.labels`)) for (const ax in d.labels) { if (!axKeys.has(ax)) V.bad(`${q}.labels.${ax}`, '없는 축입니다'); h.str(d.labels, ax, `${q}.labels`) }
      }
    })
    if (V.errs.length === e0) {
      const AX = Object.fromEntries(st.axes.map(a => [a.key, a]))
      const abs = dialsModel(st, states)
      for (const it of st.items) if (!abs.some(a => a.show.includes(it.id))) V.bad(sp, `항목 "${it.id}"을 보여 주는 상태가 없습니다. 상태의 show에 넣거나 항목을 빼세요`)
      abs.forEach((a, k) => {
        for (const id in a.items) for (const [ax, v] of Object.entries(a.items[id].at)) {
          if (!dOk(AX[ax], v)) V.bad(`${paths[k]}: 항목 "${id}" 축 "${ax}"`, AX[ax].stops ? `stops 중 하나이거나 [낮은 값, 높은 값] 범위여야 합니다 (${JSON.stringify(v)})` : `min~max 안의 숫자이거나 [낮은 값, 높은 값] 범위여야 합니다 (${JSON.stringify(v)})`)
          else if (Array.isArray(v) && !isStr(a.items[id].labels[ax])) V.bad(`${paths[k]}: 항목 "${id}" 축 "${ax}"`, '범위 값에는 labels로 원문 표현이 필요합니다')
        }
      })
    }
  }

  if (t === 'track') {
    let bins = []
    if (h.obj(st.x, `${sp}.x`)) {
      h.str(st.x, 'label', `${sp}.x`)
      h.str(st.x, 'unit', `${sp}.x`, true)
      if (h.list(st.x, 'bins', `${sp}.x`, (v, q) => { if (!isStr(v) && !isNum(v)) V.bad(q, '문자열 또는 숫자여야 합니다') }, 2, 24)) {
        bins = st.x.bins.map(String)
        if (new Set(bins).size !== bins.length) V.bad(`${sp}.x.bins`, '중복된 구간이 있습니다')
      }
    }
    const rowIds = new Set(), frameIds = new Set()
    const binOk = (b, q) => bins.includes(String(b)) || V.bad(q, `x.bins에 없는 구간 "${b}"`)
    h.list(st, 'rows', sp, (r, rp) => {
      if (!h.obj(r, rp)) return
      if (h.kebab(r.id, `${rp}.id`)) { if (rowIds.has(r.id)) V.bad(`${rp}.id`, `중복된 id "${r.id}"`); rowIds.add(r.id) }
      h.str(r, 'label', rp)
      h.str(r, 'unit', rp, true)
      h.str(r, 'caption', rp, true)
      if (!h.oneOf(r.mark, ['bar', 'dot', 'text'], `${rp}.mark`) || r.mark === undefined) { if (r.mark === undefined) V.bad(`${rp}.mark`, '"bar", "dot", "text" 중 하나가 필요합니다'); return }
      h.oneOf(r.scale, ['linear', 'log'], `${rp}.scale`)
      if (!Array.isArray(r.values) || r.values.length !== bins.length) return V.bad(`${rp}.values`, `x.bins 개수(${bins.length})와 같은 길이의 배열이어야 합니다`)
      r.values.forEach((v, i) => {
        if (v === null) return
        if (r.mark === 'text' ? !isStr(v) : !isNum(v)) V.bad(`${rp}.values[${i}]`, r.mark === 'text' ? '문자열 또는 null이어야 합니다' : '숫자 또는 null이어야 합니다')
        else if (r.mark === 'bar' && v < 0) V.bad(`${rp}.values[${i}]`, '막대는 0 이상이어야 합니다 (항상 0에서 시작)')
        else if (r.mark === 'dot' && r.scale === 'log' && v <= 0) V.bad(`${rp}.values[${i}]`, 'log 눈금 값은 0보다 커야 합니다')
      })
      if (r.mark !== 'text' && !r.values.some(isNum)) V.bad(`${rp}.values`, '숫자 값이 하나 이상 있어야 합니다')
      if (r.max !== undefined && (r.mark !== 'bar' || !isNum(r.max) || r.max <= 0 || r.values.some(v => isNum(v) && v > r.max))) V.bad(`${rp}.max`, '막대 행에서 모든 값 이상인 양수여야 합니다')
    }, 1, 4)
    h.opt(st, 'frames', sp, (f, fp) => {
      if (!h.obj(f, fp)) return
      if (h.kebab(f.id, `${fp}.id`)) { if (frameIds.has(f.id)) V.bad(`${fp}.id`, `중복된 id "${f.id}"`); frameIds.add(f.id) }
      binOk(f.bin, `${fp}.bin`)
      h.img(f.src, `${fp}.src`)
      h.str(f, 'label', fp)
      h.str(f, 'text', fp, true)
    }, 0, 8)
    h.opt(st, 'notes', sp, (n, np) => { if (!h.obj(n, np)) return; binOk(n.bin, `${np}.bin`); h.str(n, 'text', np) })
    h.bool(st, 'scrub', sp)
    states.forEach((s, k) => {
      const p = paths[k]
      h.opt(s, 'rows', p, (v, q) => { if (!rowIds.has(v)) V.bad(q, `없는 행 id "${v}"`) }, 0)
      h.opt(s, 'frames', p, (v, q) => { if (!frameIds.has(v)) V.bad(q, `없는 사진 id "${v}"`) }, 0)
      h.opt(s, 'focus', p, (v, q) => binOk(v, q))
    })
  }

  if (t === 'lookup') {
    const full = st.view === 'full'
    h.oneOf(st.view, ['switch', 'full'], `${sp}.view`)
    if (h.list(st, 'fields', sp, h.text, 1, 14) && new Set(st.fields).size !== st.fields.length) V.bad(`${sp}.fields`, '중복된 항목이 있습니다')
    const nf = Array.isArray(st.fields) ? st.fields.length : -1
    const ids = new Set()
    h.list(st, 'records', sp, (r, rp) => {
      if (!h.obj(r, rp)) return
      if (h.kebab(r.id, `${rp}.id`)) { if (ids.has(r.id)) V.bad(`${rp}.id`, `중복된 id "${r.id}"`); ids.add(r.id) }
      h.str(r, 'label', rp)
      h.str(r, 'badge', rp, true)
      if (!Array.isArray(r.values) || r.values.length !== nf) V.bad(`${rp}.values`, `fields 개수(${nf})와 같은 길이의 배열이어야 합니다 (빈 칸은 "—")`)
      else r.values.forEach((c, i) => {
        if (isObj(c)) { h.str(c, 'text', `${rp}.values[${i}]`); h.str(c, 'uncertain', `${rp}.values[${i}]`) }
        else h.text(c, `${rp}.values[${i}]`)
      })
      if (r.notes !== undefined && (!Array.isArray(r.notes) || r.notes.length !== nf || !r.notes.every(n => typeof n === 'string'))) V.bad(`${rp}.notes`, `fields 개수(${nf})와 같은 길이의 문자열 배열이어야 합니다 (없으면 "")`)
    }, 1, 8)
    if (st.base !== undefined && !ids.has(st.base)) V.bad(`${sp}.base`, `없는 record id "${st.base}"`)
    if (!full && !opt.block && ctl === 'slider') V.bad(`${sp}.control`, 'lookup은 steps 또는 tabs만 쓸 수 있습니다')
    states.forEach((s, k) => {
      const p = paths[k]
      if (full && s.record !== undefined) V.bad(`${p}.record`, 'full 보기에서는 record를 쓰지 않습니다 (focus만)')
      if (!full && s.record !== undefined && !ids.has(s.record)) V.bad(`${p}.record`, `없는 record id "${s.record}"`)
      if (!full && k === 0 && s.record === undefined) V.bad(`${p}.record`, '첫 상태에는 record가 필요합니다')
      h.opt(s, 'focus', p, (v, q) => { if (Array.isArray(st.fields) && !st.fields.includes(v)) V.bad(q, `없는 항목 "${v}"`) })
    })
  }

  if (t === 'photos') {
    h.bool(st, 'compare', sp)
    const ids = new Set(), zoneIds = new Set(), details = new Set()
    h.list(st, 'items', sp, (it, ip) => {
      if (!h.obj(it, ip)) return
      if (h.kebab(it.id, `${ip}.id`)) { if (ids.has(it.id)) V.bad(`${ip}.id`, `중복된 id "${it.id}"`); ids.add(it.id) }
      if (it.src !== undefined) { h.img(it.src, `${ip}.src`); if (it.frame !== undefined) V.bad(`${ip}.frame`, 'frame은 src가 없는 도식 프레임에만 씁니다') }
      else h.oneOf(it.frame, ['3:2', '2:3', '16:9'], `${ip}.frame`)
      h.str(it, 'name', ip)
      h.str(it, 'alt', ip, true)
      h.str(it, 'text', ip, true)
      h.str(it, 'uncertain', ip, true)
      if (it.key !== undefined) h.kebab(it.key, `${ip}.key`)
      strList(it, 'meta', ip)
      const zs = new Set()
      h.opt(it, 'zones', ip, (z, zp) => {
        if (!h.obj(z, zp)) return
        if (h.kebab(z.id, `${zp}.id`)) { if (zs.has(z.id)) V.bad(`${zp}.id`, `중복된 id "${z.id}"`); zs.add(z.id); zoneIds.add(`${it.id}.${z.id}`) }
        if (!ZONES.includes(z.area)) V.bad(`${zp}.area`, `${ZONES.join(', ')} 중 하나여야 합니다`)
        h.str(z, 'text', zp)
      }, 1, 4)
      if (it.detail !== undefined && h.obj(it.detail, `${ip}.detail`)) { h.img(it.detail.src, `${ip}.detail.src`); h.str(it.detail, 'text', `${ip}.detail`); details.add(it.id) }
    }, 1, 6)
    if (!opt.block && ctl === 'slider') V.bad(`${sp}.control`, 'photos는 steps 또는 tabs만 쓸 수 있습니다')
    states.forEach((s, k) => {
      const p = paths[k]
      h.opt(s, 'show', p, (v, q) => { if (!ids.has(v)) V.bad(q, `없는 사진 id "${v}"`) })
      if (s.focus !== undefined && !ids.has(s.focus)) V.bad(`${p}.focus`, '사진 id 하나여야 합니다')
      h.opt(s, 'zones', p, (v, q) => { if (!zoneIds.has(v)) V.bad(q, `없는 영역 "${v}" ("사진id.영역id")`) }, 0)
      if (s.detail !== undefined && !details.has(s.detail)) V.bad(`${p}.detail`, 'detail이 있는 사진 id여야 합니다')
    })
    if (V.errs.length === e0) {
      const abs = photosModel(st, states)
      abs.forEach((a, k) => {
        if (a.focus && !a.show.includes(a.focus)) V.bad(`${paths[k]}.focus`, '보이는(show) 사진이어야 합니다')
        a.zones.forEach(z => { if (!a.show.includes(z.split('.')[0])) V.bad(`${paths[k]}.zones`, `"${z}": 보이는(show) 사진의 영역이어야 합니다`) })
        if (a.detail && !a.show.includes(a.detail)) V.bad(`${paths[k]}.detail`, '보이는(show) 사진이어야 합니다')
      })
      // 어느 상태에서도 쓰지 않는 영역·크롭은 화면에 나타나지 않으므로 정보가 사라진다
      for (const z of zoneIds) if (!abs.some(a => a.zones.includes(z))) V.bad(sp, `영역 "${z}"을 보여 주는 상태가 없습니다. 상태의 zones에 넣으세요`)
      for (const d of details) if (!abs.some(a => a.detail === d)) V.bad(sp, `"${d}"의 detail을 보여 주는 상태가 없습니다. 상태의 detail에 넣거나, 정적 그림이면 크롭을 별도 사진 항목으로 쓰세요`)
    }
  }
}

// ---------- 문서 검증 ----------
// 오류(경로 포함) 배열을 돌려준다. 경고는 opts.warnings 배열에 넣는다.
export function validate(spec, opts = {}) {
  const errs = [], warns = []
  const V = { errs, baseDir: opts.baseDir, bad: (p, m) => errs.push(`${p}: ${m}`), warn: (p, m) => warns.push(`${p}: ${m}`) }
  const h = helpers(V)
  const done = () => { if (opts.warnings) opts.warnings.push(...warns); return errs }
  if (!h.obj(spec, 'spec')) return done()
  h.str(spec, 'title', 'spec')
  h.str(spec, 'subtitle', 'spec', true)
  h.str(spec, 'lang', 'spec', true)
  if (isStr(spec.lang)) try { Intl.getCanonicalLocales(spec.lang) } catch { V.bad('spec.lang', '올바른 언어 코드가 아닙니다 (예: "ko", "en")') }
  const links = [] // [경로, 장면 id]
  h.opt(spec, 'summary', 'spec', (v, p) => {
    if (typeof v === 'string') return h.text(v, p)
    if (!h.obj(v, p)) return
    h.str(v, 'text', p)
    if (h.kebab(v.to, `${p}.to`)) links.push([`${p}.to`, v.to])
  }, 1, 6)
  if (!h.list(spec, 'scenes', 'spec', () => {}, 1, 40)) return done()

  const sceneIds = new Set(), stageIds = new Set(), keys = new Set()
  const dom = new Set(['cover', 'cover-t'])
  const claim = (id, p) => { if (dom.has(id)) V.bad(p, `HTML id "${id}"가 다른 장면·무대의 id와 겹칩니다`); dom.add(id) }
  const addKey = k => { if (typeof k === 'string') keys.add(k) }
  let prev = null // 바로 앞 장면의 무대 (이어 쓰기용)
  const seqs = []
  const stageCommon = (st, sp, block) => {
    if (!STAGES.includes(st.type)) { V.bad(`${sp}.type`, `${STAGES.join(', ')} 중 하나여야 합니다`); return false }
    if (!block || st.id !== undefined) {
      if (!h.kebab(st.id, `${sp}.id`)) return false
      if (stageIds.has(st.id)) { V.bad(`${sp}.id`, `중복된 무대 id "${st.id}"`); return false }
      stageIds.add(st.id)
      claim(`st-${st.id}`, `${sp}.id`)
    }
    if (block && st.control !== undefined) V.bad(`${sp}.control`, '블록 안의 무대는 상태가 하나라 control을 쓰지 않습니다')
    if (!block && !h.oneOf(st.control, ['steps', 'tabs', 'slider'], `${sp}.control`)) return false
    h.str(st, 'caption', sp, true)
    if (block) {
      if (st.states !== undefined && (!Array.isArray(st.states) || st.states.length !== 1)) { V.bad(`${sp}.states`, '블록 안의 무대는 상태가 정확히 하나입니다 (여러 상태는 장면의 stage로)'); return false }
    } else if (!h.list(st, 'states', sp, () => {}, 1, MAX_STATES)) return false
    if (!block && ctlOf(st) !== 'steps' && st.start !== undefined && (!Number.isInteger(st.start) || st.start < 0 || st.start >= st.states.length)) V.bad(`${sp}.start`, `0~${st.states.length - 1} 사이의 정수여야 합니다`)
    return true
  }

  spec.scenes.forEach((sc, i) => {
    const p = `spec.scenes[${i}]`
    let cur = null
    if (!h.obj(sc, p)) { prev = null; return }
    if (h.kebab(sc.id, `${p}.id`)) {
      if (sc.id === 'cover') V.bad(`${p}.id`, '"cover"는 표지용으로 예약되어 있습니다')
      else if (sceneIds.has(sc.id)) V.bad(`${p}.id`, `중복된 장면 id "${sc.id}"`)
      else { claim(sc.id, `${p}.id`); claim(`${sc.id}-t`, `${p}.id`) }
      sceneIds.add(sc.id)
    }
    h.str(sc, 'title', p)
    h.str(sc, 'message', p, true)
    if (sc.layout !== undefined) V.bad(`${p}.layout`, 'v2에는 layout이 없습니다. 구성은 무대 종류로 자동 결정됩니다')
    if (sc.stage === undefined && (!Array.isArray(sc.blocks) || !sc.blocks.length)) V.bad(p, 'stage 또는 blocks 중 하나는 있어야 합니다')
    if (sc.stage !== undefined && h.obj(sc.stage, `${p}.stage`)) {
      const st = sc.stage, sp = `${p}.stage`
      if (st.continue !== undefined) {
        if (!prev || prev.id !== st.continue) V.bad(`${sp}.continue`, '바로 앞 장면의 무대 id와 같아야 합니다')
        else if (ctlOf(prev.stage) !== 'steps') V.bad(`${sp}.continue`, '단계형(steps) 무대만 이어 쓸 수 있습니다')
        else if (h.list(st, 'states', sp, () => {}, 1)) {
          st.states.forEach((s, j) => { prev.states.push(s); prev.paths.push(`${sp}.states[${j}]`) })
          cur = prev
        }
      } else if (stageCommon(st, sp, false)) {
        cur = { id: st.id, stage: st, states: [...st.states], paths: st.states.map((_, j) => `${sp}.states[${j}]`) }
        seqs.push(cur)
      }
    }
    prev = cur
    h.opt(sc, 'blocks', p, (b, bp, bi) => {
      if (!h.obj(b, bp)) return
      h.str(b, 'title', bp, true)
      if (STAGES.includes(b.type)) {
        if (b.id === undefined && typeof sc.id === 'string') claim(`st-${sc.id}--b${bi}`, `${bp}.id`) // 렌더러가 붙이는 자동 id
        if (stageCommon(b, bp, true)) seqs.push({ stage: b, states: b.states || [{}], paths: [`${bp}.states[0]`], block: true, sp: bp })
        return
      }
      if (['cards', 'chart', 'html'].includes(b.type)) return V.bad(`${bp}.type`, `v2에서 "${b.type}"은 없어졌습니다. units·dials·track·photos·table을 쓰세요`)
      if (!STATIC.includes(b.type)) return V.bad(`${bp}.type`, `${[...STATIC, ...STAGES].join(', ')} 중 하나여야 합니다`)
      const q = `${bp}(${b.type})`
      switch (b.type) {
        case 'text': h.str(b, 'text', q); break
        case 'note': h.str(b, 'text', q); h.oneOf(b.tone, Object.keys(TONES), `${q}.tone`); break
        case 'table':
          h.list(b, 'columns', q, h.text)
          h.list(b, 'rows', q, (r, rp) => {
            if (!Array.isArray(r)) return V.bad(rp, '배열이어야 합니다')
            if (Array.isArray(b.columns) && r.length !== b.columns.length) V.bad(rp, `열 개수(${b.columns.length})와 셀 개수(${r.length})가 다릅니다`)
            r.forEach((c, ci) => h.cell(c, `${rp}[${ci}]`))
          })
          if (b.highlight !== undefined && Array.isArray(b.rows)) for (const x of [].concat(b.highlight)) if (!Number.isInteger(x) || x < 0 || x >= b.rows.length) V.bad(`${q}.highlight`, `0~${b.rows.length - 1} 사이의 정수여야 합니다`)
          h.str(b, 'caption', q, true)
          break
        case 'compare':
          h.list(b, 'items', q, (it, ip) => {
            if (!h.obj(it, ip)) return
            h.str(it, 'title', ip)
            h.str(it, 'subtitle', ip, true)
            h.str(it, 'badge', ip, true)
            h.list(it, 'points', ip, h.text)
          }, 2, 4)
          if (b.highlight !== undefined && Array.isArray(b.items) && (!Number.isInteger(b.highlight) || b.highlight < 0 || b.highlight >= b.items.length)) V.bad(`${q}.highlight`, '정수 하나여야 합니다')
          break
        case 'checklist':
          h.list(b, 'items', q, (it, ip) => {
            if (typeof it === 'string') return h.text(it, ip)
            if (!h.obj(it, ip)) return
            h.str(it, 'text', ip)
            h.str(it, 'note', ip, true)
            if (it.to !== undefined && h.kebab(it.to, `${ip}.to`)) links.push([`${ip}.to`, it.to])
          })
          break
        case 'flow':
          h.list(b, 'steps', q, (it, ip) => {
            if (typeof it === 'string') return h.text(it, ip)
            if (!h.obj(it, ip)) return
            h.str(it, 'title', ip)
            h.str(it, 'text', ip, true)
          }, 2)
          h.oneOf(b.direction, ['horizontal', 'vertical'], `${q}.direction`)
          break
        case 'code':
          if (typeof b.code !== 'string' || b.code === '') V.bad(`${q}.code`, '비어 있지 않은 문자열이어야 합니다')
          h.str(b, 'lang', q, true)
          h.str(b, 'caption', q, true)
          if (b.highlight !== undefined && (!Array.isArray(b.highlight) || !b.highlight.every(n => Number.isInteger(n) && n > 0))) V.bad(`${q}.highlight`, '1부터 시작하는 줄 번호 배열이어야 합니다')
          break
      }
    }, 0, 6)
  })

  for (const sq of seqs) {
    const sp = sq.block ? sq.sp : sq.paths[0].replace(/\.states\[0\]$/, '')
    if (sq.states.length > MAX_STATES) V.bad(sp, `이어 쓴 상태를 합쳐 ${MAX_STATES}개 이하여야 합니다 (${sq.states.length}개)`)
    else checkStage(sq.stage, sq.states, sq.paths, sp, h, V, { block: !!sq.block })
    const st = sq.stage
    ;(st.items || []).forEach(it => addKey(it?.key))
    sq.states.forEach(s => (Array.isArray(s?.groups) ? s.groups : []).forEach(g => addKey(g?.key)))
  }
  if (keys.size > 8) V.bad('spec', `색 key는 문서 전체에서 8개 이하여야 합니다 (${keys.size}개)`)
  for (const [p, id] of links) if (!sceneIds.has(id)) V.bad(p, `없는 장면 id "${id}"`)
  return done()
}

// ---------- 정적 블록 ----------
function staticBlock(b, ctx) {
  const num = c => (typeof c === 'number' ? ' class="num"' : '')
  const cell = c => (typeof c === 'number' ? esc(ctx.f(c)) : inline(c))
  switch (b.type) {
    case 'text': return `<div class="st-text">${para(b.text)}</div>`
    case 'note': {
      const t = b.tone || 'info', [icon, label] = TONES[t]
      return `<div class="st-note st-note--${t}" role="note"><span class="st-note-i" aria-hidden="true">${icon}</span><div><strong class="st-note-l">${label}</strong>${para(b.text)}</div></div>`
    }
    case 'table': {
      const hl = new Set([].concat(b.highlight ?? []))
      return `<div class="st-tablewrap"><table>${b.caption ? `<caption>${inline(b.caption)}</caption>` : ''}<thead><tr>${b.columns.map(c => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r, i) => `<tr${hl.has(i) ? ' class="is-hl"' : ''}>${r.map((c, ci) => (ci === 0 ? `<th scope="row"${num(c)}>${cell(c)}</th>` : `<td${num(c)}>${cell(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`
    }
    case 'compare': return `<div class="st-compare">${b.items.map((it, i) => `<div class="st-opt${b.highlight === i ? ' is-hl' : ''}">${it.badge ? `<span class="st-badge">${esc(it.badge)}</span>` : ''}<h4>${inline(it.title)}</h4>${it.subtitle ? `<p class="st-opt-sub">${inline(it.subtitle)}</p>` : ''}<ul>${it.points.map(p => `<li>${inline(p)}</li>`).join('')}</ul></div>`).join('')}</div>`
    case 'checklist': return `<ul class="st-check">${b.items.map(it => {
      const o = typeof it === 'string' ? { text: it } : it
      return `<li><label><input type="checkbox"><span>${inline(o.text)}${o.note ? `<small>${inline(o.note)}</small>` : ''}${o.to ? ` <a class="st-to" href="#${esc(o.to)}">→ ${inline(ctx.titles[o.to])}</a>` : ''}</span></label></li>`
    }).join('')}</ul>`
    case 'flow': {
      const vertical = b.direction === 'vertical' || (b.direction !== 'horizontal' && b.steps.length > 4)
      return `<ol class="st-flow${vertical ? ' st-flow--v' : ''}">${b.steps.map((s, i) => {
        const o = typeof s === 'string' ? { title: s } : s
        return `${i ? '<li class="st-arrow" aria-hidden="true"></li>' : ''}<li class="st-step"><span class="st-step-n" data-chrome>${i + 1}</span><strong>${inline(o.title)}</strong>${o.text ? `<p>${inline(o.text)}</p>` : ''}</li>`
      }).join('')}</ol>`
    }
    case 'code': {
      const hl = new Set(b.highlight || [])
      const lines = b.code.replace(/\n$/, '').split('\n')
      return `<figure class="st-codefig">${b.lang ? `<span class="st-lang">${esc(b.lang)}</span>` : ''}<pre class="st-code"><code>${lines.map((l, i) => `<span class="st-ln${hl.has(i + 1) ? ' is-hl' : ''}">${esc(l) || ' '}</span>`).join('')}</code></pre>${b.caption ? `<figcaption>${inline(b.caption)}</figcaption>` : ''}</figure>`
    }
  }
  return ''
}

// ---------- 무대 틀 ----------
function stageHtml(st, states, paths, ctx, mode, name = '') {
  const R = RENDER[st.type](st, states, ctx, paths)
  const n = states.length
  const ctl = mode === 'block' ? 'none' : ctlOf(st)
  const def = ctl === 'steps' ? n - 1 : ctl === 'none' ? 0 : st.start || 0 // JS 없이도 보이는 상태: 단계형은 마지막
  const labels = states.map(s => s.label || '')
  let c = ''
  if (ctl === 'tabs') c = `<div class="st-ctl st-tabs" role="group" aria-label="${esc(plain(name))}">${labels.map((l, k) => `<button type="button" data-to="${k}" aria-pressed="${k === def}">${inline(l)}</button>`).join('')}</div>`
  if (ctl === 'slider') c = `<div class="st-ctl st-slider"><input type="range" class="st-range" min="0" max="${n - 1}" step="1" value="${def}" aria-valuetext="${esc(plain(labels[def]))}" aria-label="${esc(plain(name))}"><output>${esc(plain(labels[def]))}</output><ol class="st-stops">${labels.map(l => `<li>${inline(l)}</li>`).join('')}</ol></div>`
  ctx.K = Math.max(ctx.K, n)
  if (st.type === 'track') ctx.B = Math.max(ctx.B, st.x.bins.length)
  const fig = `<figure class="st-stage st-t-${st.type}${R.fx.map(k => ` fx-${k}`).join('')}" id="st-${esc(st.id)}" data-n="${n}" data-s="${def}" data-ctl="${ctl}"${R.dis.length ? ` data-dis="${R.dis.join(' ')}"` : ''}${ctl === 'slider' ? ` data-labels="${esc(JSON.stringify(labels.map(plain)))}"` : ''} style="--ar:${r2(Math.max(0.3, R.ar))}">${c}<div class="st-body"${R.hide ? ' aria-hidden="true"' : ''}>${R.body}</div>${st.caption ? `<figcaption class="st-cap">${inline(st.caption)}</figcaption>` : ''}</figure>`
  return { fig, lines: R.lines, fallback: R.fallback ? `<details class="st-fallback" open><summary>표로 보기</summary><div class="st-tablewrap">${R.fallback}</div></details>` : '', n }
}
const beatLi = (id, k, s, line, label) => `<li class="st-beat" data-st="${esc(id)}" data-k="${k}">${label && s.label ? `<p class="st-blabel">${inline(s.label)}</p>` : ''}${s.say ? `<p class="st-say">${inline(s.say)}</p>` : ''}${line ? `<p class="st-data">${line}</p>` : ''}${unc(s.uncertain)}</li>`

// ---------- 렌더링 ----------
export function render(spec, { date = localDate(), baseDir = '.' } = {}) {
  const lang = spec.lang || 'ko'
  const keyIdx = new Map()
  const ctx = {
    baseDir, imgs: new Map(), css: [], K: 1, B: 0,
    f: n => fmtNum(n, lang),
    titles: Object.fromEntries(spec.scenes.map(s => [s.id, s.title])),
    col: k => { if (!keyIdx.has(k)) keyIdx.set(k, keyIdx.size + 1); return `var(--c${keyIdx.get(k)})` },
    ink: k => `var(--i${keyIdx.get(k)})`, // 그 색 위에 쓰는 글자색 (밝은 색에는 어두운 글자)
  }
  const blocks = sc => {
    if (!sc.blocks || !sc.blocks.length) return ''
    return `<div class="st-blocks">${sc.blocks.map((b, i) => {
      const title = b.title ? `<h3 class="st-btitle">${inline(b.title)}</h3>` : ''
      if (!STAGES.includes(b.type)) return `<div class="st-block st-b-${b.type}">${title}${staticBlock(b, ctx)}</div>`
      const st = { ...b, id: b.id || `${sc.id}--b${i}` }
      const states = b.states || [{}]
      const S = stageHtml(st, states, [`block ${st.id}`], ctx, 'block')
      const s0 = states[0]
      return `<div class="st-block st-b-stage">${title}${S.fig}${s0.label ? `<p class="st-blabel">${inline(s0.label)}</p>` : ''}${s0.say ? `<p class="st-say">${inline(s0.say)}</p>` : ''}${b.type !== 'photos' && S.lines[0] ? `<p class="st-data">${S.lines[0]}</p>` : ''}${unc(s0.uncertain)}${S.fallback}</div>`
    }).join('')}</div>`
  }
  const head = (sc, tag = 'h2') => `<${tag} id="${esc(sc.id)}-t">${inline(sc.title)}</${tag}>`

  const out = []
  const S_ = spec.scenes
  for (let i = 0; i < S_.length;) {
    const sc = S_[i], st = sc.stage
    if (st && ctlOf(st) === 'steps') {
      // 단계형 무대 + 바로 이어 쓰는 장면들 = 한 시퀀스. 무대는 고정되고 장면 글이 지나간다.
      const group = [i]
      let j = i + 1
      while (j < S_.length && S_[j].stage && S_[j].stage.continue === st.id) group.push(j++)
      const states = [], paths = [], ranges = []
      group.forEach(g => {
        const ss = g === i ? st.states : S_[g].stage.states
        ranges.push([states.length, states.length + ss.length - 1])
        ss.forEach((s, q) => { states.push(s); paths.push(`spec.scenes[${g}].stage.states[${q}]`) })
      })
      const S = stageHtml(st, states, paths, ctx, 'seq')
      const arts = group.map((g, gi) => {
        const s = S_[g], [k0, k1] = ranges[gi]
        const beats = []
        for (let k = k0; k <= k1; k++) beats.push(beatLi(st.id, k, states[k], S.lines[k], true))
        return `<article class="st-sc" id="${esc(s.id)}" data-k0="${k0}" data-k1="${k1}" aria-labelledby="${esc(s.id)}-t">${head(s)}<ol class="st-beats">${beats.join('')}${s.message ? `<li class="st-take" data-st="${esc(st.id)}" data-k="${k1}">${inline(s.message)}</li>` : ''}</ol>${blocks(s)}${gi === group.length - 1 ? S.fallback : ''}</article>`
      }).join('')
      out.push(`<section class="st-seq"><div class="st-stagecol">${S.fig}</div><div class="st-steps">${arts}</div></section>`)
      i = j
      continue
    }
    const msg = sc.message ? `<p class="st-msg">${inline(sc.message)}</p>` : ''
    if (st) {
      // 탭·슬라이더 무대: 사용자가 직접 값을 바꿔 본다
      const paths = st.states.map((_, q) => `spec.scenes[${i}].stage.states[${q}]`)
      const S = stageHtml(st, st.states, paths, ctx, 'panel', sc.title)
      out.push(`<section class="st-sc st-c-panel" id="${esc(sc.id)}" aria-labelledby="${esc(sc.id)}-t"><div class="st-inner">${head(sc)}${msg}${S.fig}<ol class="st-beats st-caps">${st.states.map((s, k) => beatLi(st.id, k, s, S.lines[k], true)).join('')}</ol>${S.fallback}${blocks(sc)}</div></section>`)
    } else {
      const kind = sc.blocks[0].type === 'photos' ? 'figure' : 'reference'
      out.push(`<section class="st-sc st-c-${kind}" id="${esc(sc.id)}" aria-labelledby="${esc(sc.id)}-t"><div class="st-inner">${head(sc)}${msg}${blocks(sc)}</div></section>`)
    }
    i++
  }

  const summary = spec.summary ? `<ol class="st-summary">${spec.summary.map(x => (typeof x === 'string' ? `<li>${inline(x)}</li>` : `<li><a href="#${esc(x.to)}">${inline(x.text)}</a></li>`)).join('')}</ol>` : ''
  const cover = `<section class="st-sc st-cover" id="cover" aria-labelledby="cover-t"><div class="st-inner"><h1 id="cover-t">${inline(spec.title)}</h1>${spec.subtitle ? `<p class="st-sub">${inline(spec.subtitle)}</p>` : ''}${summary}<p class="st-meta" data-chrome>${esc(date)} · 장면 ${S_.length}개<span class="st-hint"> · 스크롤하면 장면이 바뀝니다 · ← → 장면 이동 · P 발표 모드</span></p></div></section>`
  const titles = [['cover', spec.title], ...S_.map(s => [s.id, s.title])]
  const rail = `<nav class="st-rail" aria-label="장면 목록">${titles.map(([id, t]) => `<a href="#${esc(id)}" title="${esc(plain(t))}" aria-label="${esc(plain(t))}"></a>`).join('')}</nav>`
  const ctrl = `<div class="st-ctrl"><button type="button" class="p-only" data-act="prev" aria-label="이전">‹</button><span class="st-count p-only" data-chrome></span><button type="button" class="p-only" data-act="next" aria-label="다음">›</button><button type="button" data-act="mode" aria-pressed="false">발표 모드</button></div>`

  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Showtell 2">
<title>${esc(plain(spec.title))}</title>
<script>document.documentElement.classList.add('js');setTimeout(function(){if(!window.__showtell)document.documentElement.classList.remove('js')},2500)</script>
<style>
${CSS}
${stateCss(ctx.K, ctx.B)}
${ctx.css.join('\n')}
</style>
</head>
<body>
<div class="st-progress" aria-hidden="true"><i></i></div>
${rail}
<main>
${cover}
${out.join('\n')}
</main>
${ctrl}
<script>
${JS}
</script>
</body>
</html>
`
}

// 상태 번호 k마다 같은 규칙: data-s="k"인 무대 안에서 s-k(보임)·f-k(초점)·c-k(바뀜)를 켠다
function stateCss(K, B) {
  let c = ''
  for (let k = 0; k < K; k++) {
    const s = `.st-stage[data-s="${k}"]`
    c += `${s} .s-${k}{--on:1}${s} .f-${k}{--hot:1}${s} .c-${k}{--chg:1}.st-stage.fx-${k}[data-s="${k}"]{--fx:1}.st-stage.fx-${k}[data-s="${k}"] .st-f{--dim:1}${s} .st-pos{--x:var(--x-${k});--y:var(--y-${k});--w:var(--w-${k})}${s} .st-field{--h:var(--h-${k})}${s} .st-rule{--lanes:var(--lanes-${k})}${s} .st-col.s-${k}{grid-template-rows:1fr}\n`
  }
  for (let i = 0; i < B; i++) c += `.st-stage[data-bin="${i}"] .b-${i}{--sel:1}.st-stage[data-bin="${i}"] .st-ro.b-${i}{display:block}\n`
  return c
}

const CSS = fs.readFileSync(path.join(HERE, 'runtime.css'), 'utf8')
const JS = fs.readFileSync(path.join(HERE, 'runtime.js'), 'utf8')
const localDate = () => new Date().toLocaleDateString('sv') // YYYY-MM-DD (로컬 시간)

// ---------- CLI ----------
function openFile(p) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [p]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${p}"`]]
    : ['xdg-open', [p]]
  try {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
    c.on('error', () => console.log('  브라우저를 자동으로 열지 못했습니다. 위 경로를 직접 여세요.'))
    c.unref()
  } catch {}
}

function main(argv) {
  const file = argv.find(a => !a.startsWith('--'))
  if (!file) {
    console.error('사용법: node render.mjs <spec.json> [--no-open]')
    process.exit(2)
  }
  let spec
  try {
    spec = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    console.error(`✗ ${file}: ${e.message}`)
    process.exit(1)
  }
  const dir = path.dirname(path.resolve(file))
  const warnings = []
  const errs = validate(spec, { baseDir: dir, warnings })
  if (warnings.length) console.log(`! 경고 ${warnings.length}건\n${warnings.map(w => `  - ${w}`).join('\n')}`)
  if (errs.length) {
    console.error(`✗ 명세 오류 ${errs.length}건. 명세를 고친 뒤 다시 실행하세요.\n${errs.map(e => `  - ${e}`).join('\n')}`)
    process.exit(1)
  }

  const date = localDate()
  const html = render(spec, { date, baseDir: dir })
  // .showtell 폴더일 때만 자체 .gitignore를 둔다 (사용자 폴더에 `*`를 심지 않기 위해)
  if (path.basename(dir) === '.showtell') {
    try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }) } catch (e) { if (e.code !== 'EEXIST') throw e }
  }
  const slug = path.basename(file, path.extname(file)).replace(/^\d{4}-\d{2}-\d{2}-/, '') || 'showtell'
  let out
  for (let n = 1; ; n++) {
    // 기존 파일은 절대 덮어쓰지 않고 번호를 붙인다
    out = path.join(dir, `${date}-${slug}${n > 1 ? `-${n}` : ''}.html`)
    try { fs.writeFileSync(out, html, { flag: 'wx' }); break } catch (e) { if (e.code !== 'EEXIST') throw e }
  }
  console.log(`✓ Showtell: ${out}\n  장면 ${spec.scenes.length}개 · ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)}MB`)
  if (Buffer.byteLength(html) > 8 * 1024 * 1024) console.log('! 결과물이 8MB를 넘습니다. 사진을 줄이면 빨리 열립니다.')
  if (!argv.includes('--no-open')) openFile(out)
}

// 심볼릭 링크 경로로 실행해도 동작하도록 실제 경로로 비교
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
