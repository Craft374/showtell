// Showtell v2 런타임. 무대마다 data-s(상태 번호) 하나만 바꾸고, 움직임은 CSS가 맡는다.
// 문서 모드: 스크롤하면 비트가 화면 가운데를 지날 때 무대 상태가 바뀐다.
// 발표 모드(P): → 는 다음 비트, 비트가 끝나면 다음 장면.
(() => {
  const root = document.documentElement
  const slides = [...document.querySelectorAll('.st-sc')]
  const stages = [...document.querySelectorAll('.st-stage')]
  const rail = [...document.querySelectorAll('.st-rail a')]
  const bar = document.querySelector('.st-progress')
  const ctrl = document.querySelector('.st-ctrl')
  const modeBtn = ctrl.querySelector('[data-act="mode"]')
  const counter = ctrl.querySelector('.st-count')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  const beats = {}
  document.querySelectorAll('li[data-st]').forEach(li => (beats[li.dataset.st] ||= []).push(li))
  let cur = 0, present = false

  // 상태는 렌더러가 절대값으로 계산해 두었으므로 어떤 순서로 불러도 결과가 같다
  const set = (st, k) => {
    const n = +st.dataset.n, old = +st.dataset.s
    k = Math.max(0, Math.min(n - 1, k))
    if (k !== old && st.dataset.dis) {
      // 서로 관계없는 기준으로 다시 세는 전환은 점이 이동하지 않고 디졸브한다
      const lo = Math.min(old, k), hi = Math.max(old, k)
      const dis = !reduce.matches && !st.classList.contains('st-init') && st.dataset.dis.split(' ').some(d => +d > lo && +d <= hi)
      clearTimeout(st._dis)
      st.classList.remove('is-dis')
      if (dis) {
        void st.offsetWidth
        st.classList.add('is-dis')
        st._dis = setTimeout(() => st.classList.remove('is-dis'), 900)
      }
    }
    st.dataset.s = k
    for (const li of beats[st.id.slice(3)] || []) {
      const on = +li.dataset.k === k
      li.classList.toggle('is-on', on)
      if (on) li.setAttribute('aria-current', 'step')
      else li.removeAttribute('aria-current')
    }
    st.querySelectorAll('[data-to]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.to === k)))
    const r = st.querySelector('.st-range')
    if (r) {
      const l = JSON.parse(st.dataset.labels || '[]')[k] || ''
      r.value = k
      r.setAttribute('aria-valuetext', l)
      const o = st.querySelector('.st-slider output')
      if (o) o.textContent = l
    }
  }

  // 시작: 단계형 무대는 첫 상태에서 시작 (출하 상태는 JS 없는 환경을 위한 마지막 상태)
  document.querySelectorAll('details.st-fallback').forEach(d => { d.open = false })
  const steps = stages.filter(s => s.dataset.ctl === 'steps')
  steps.forEach(s => { s.classList.add('st-init'); set(s, 0) })
  stages.filter(s => s.dataset.ctl !== 'steps').forEach(s => set(s, +s.dataset.s))
  requestAnimationFrame(() => requestAnimationFrame(() => steps.forEach(s => s.classList.remove('st-init'))))

  // 무대 비율(--ar)을 실제로 잰다. 렌더러 값은 글자·사진 높이를 모르는 추정이라, 무대가 화면을 넘쳐 잘리기도 한다.
  // 모든 상태 중 가장 높은 비율을 쓰면 상태가 바뀌어도 폭이 흔들리지 않는다.
  const tallest = s => { let h = 0; for (let k = 0; k < +s.dataset.n; k++) { s.dataset.s = k; h = Math.max(h, s.offsetHeight) } return h }
  const fit = () => stages.forEach(s => {
    if (!s.offsetWidth) return // 발표 모드에서 숨은 장면은 다음에 잰다
    const old = s.dataset.s, init = s.classList.contains('st-init')
    s.classList.add('st-init')
    s.style.setProperty('--ar', '0.01') // 먼저 가능한 최대 폭에서 잰다
    const w0 = s.offsetWidth, h0 = tallest(s)
    s.style.setProperty('--ar', (h0 / w0).toFixed(4))
    const w1 = s.offsetWidth
    if (w1 < w0 - 1) {
      // 화면 높이(L)를 넘는다. 높이 = 글자처럼 폭과 무관한 부분(T) + 사진·점처럼 폭에 비례하는 부분(c×폭)으로 보고
      // 두 번 잰 값으로 L에 맞는 폭을 구한다. 그런 폭이 너무 좁으면 최대 폭으로 두고 칸 안에서 스크롤한다
      const h1 = tallest(s), L = (h0 / w0) * w1
      const c = (h0 - h1) / (w0 - w1), w = c > 0 ? (L - (h0 - c * w0)) / c : 0
      s.style.setProperty('--ar', w >= Math.min(w0, 280) ? (L / w).toFixed(4) : '0.01')
    }
    // 그래도 고정 칸보다 길면 칸 안 스크롤 대신: 넓은 화면은 무대 아랫부분이 보이는 자리에 고정, 좁은 화면은 고정하지 않는다
    const col = s.closest('.st-stagecol')
    if (col) {
      col.classList.remove('st-tall'); col.style.top = ''
      const cs = getComputedStyle(col), h = tallest(s), room = parseFloat(cs.maxHeight) - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      if (h > room + 1) { col.classList.add('st-tall'); col.style.top = `${Math.round(innerHeight - h - 24)}px` }
    }
    s.dataset.s = old
    if (!init) { void s.offsetWidth; s.classList.remove('st-init') }
  })
  fit()
  if (document.fonts) document.fonts.ready.then(fit)
  // 휴대폰은 스크롤 중 주소창이 접히며 resize가 계속 온다. vh 기준 무대 폭은 그대로이므로 폭이 바뀔 때만 다시 잰다
  let fitT = 0, fitW = innerWidth
  addEventListener('resize', () => {
    if (narrow.matches && innerWidth === fitW) return
    fitW = innerWidth
    clearTimeout(fitT); fitT = setTimeout(fit, 150)
  })

  // 문서 모드: 화면 가운데 선을 지나는 비트가 무대 상태를 정한다
  // 좁은 화면에서는 무대가 화면 위쪽을 덮으므로 판정선을 무대 아래 읽는 자리로 내린다
  const narrow = matchMedia('(max-width: 859px)')
  let io
  const watch = () => {
    if (io) io.disconnect()
    io = new IntersectionObserver(es => {
      if (present) return
      es.forEach(e => {
        if (!e.isIntersecting) return
        const st = document.getElementById(`st-${e.target.dataset.st}`)
        if (st) set(st, +e.target.dataset.k)
      })
    }, { rootMargin: narrow.matches ? '-66% 0px -33% 0px' : '-50% 0px -49% 0px' })
    document.querySelectorAll('.st-seq li[data-st]').forEach(li => io.observe(li))
  }
  watch()
  narrow.addEventListener('change', watch)

  const sync = () => {
    if (!present) {
      const mid = innerHeight * 0.4
      slides.forEach((s, k) => { if (k === 0 || s.getBoundingClientRect().top <= mid) cur = k })
      const max = root.scrollHeight - innerHeight
      bar.style.setProperty('--p', max > 0 ? Math.min(1, scrollY / max) : 1)
    } else {
      bar.style.setProperty('--p', slides.length > 1 ? cur / (slides.length - 1) : 1)
    }
    rail.forEach((a, k) => a.classList.toggle('on', k === cur))
    counter.textContent = `${cur + 1} / ${slides.length}`
  }
  let raf = 0
  addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync() }) }, { passive: true })
  addEventListener('resize', sync)

  // 발표 모드
  const frame = s => s.closest('main > section')
  const stageOf = s => (s.dataset.k0 !== undefined ? frame(s).querySelector('.st-stage') : null)
  const show = (n, back) => {
    n = Math.max(0, Math.min(slides.length - 1, n))
    const s = slides[n], f = frame(s)
    document.querySelectorAll('.is-current, .is-cur').forEach(e => e.classList.remove('is-current', 'is-cur'))
    f.classList.add('is-current') // 같은 시퀀스 안에서는 틀이 그대로라 무대가 이어진다
    s.classList.add('is-cur')
    f.scrollTop = 0
    const st = stageOf(s)
    if (st) set(st, back ? +s.dataset.k1 : +s.dataset.k0)
    cur = n
    sync()
  }
  const step = d => {
    const s = slides[cur], st = stageOf(s)
    if (st) {
      const k = +st.dataset.s
      if (d > 0 && k < +s.dataset.k1) return set(st, k + 1)
      if (d < 0 && k > +s.dataset.k0) return set(st, k - 1)
    }
    if (cur + d >= 0 && cur + d < slides.length) show(cur + d, d < 0)
  }
  const go = n => {
    n = Math.max(0, Math.min(slides.length - 1, n))
    slides[n].scrollIntoView({ behavior: reduce.matches ? 'auto' : 'smooth' })
  }
  const setMode = on => {
    if (on === present) return
    sync()
    present = on
    root.classList.toggle('present', on)
    if (on) show(cur, false)
    else document.querySelectorAll('.is-current, .is-cur').forEach(e => e.classList.remove('is-current', 'is-cur'))
    fit() // 발표 모드는 무대 폭 규칙이 달라 다시 잰다 (보이는 무대만)
    if (!on) slides[cur].scrollIntoView()
    modeBtn.textContent = on ? '문서 모드' : '발표 모드'
    modeBtn.setAttribute('aria-pressed', String(on))
    sync()
  }

  const NEXT = ['ArrowRight', 'PageDown', ' ', 'Enter'], PREV = ['ArrowLeft', 'PageUp', 'Backspace']
  addEventListener('keydown', e => {
    const t = e.target
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || !t.closest) return
    // 글자 입력 칸과 슬라이더 안에서는 무시 (체크박스에 포커스가 있어도 단축키는 동작)
    if (t.closest('textarea, select, [contenteditable], input:not([type=checkbox]):not([type=radio])')) return
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && t.closest('.st-tablewrap, pre')) return
    if (e.code === 'KeyP') return setMode(!present) // 한글 입력 상태에서도 동작하도록 물리 키로 판단
    const onControl = (e.key === ' ' || e.key === 'Enter') && t.closest('button, a, summary, input')
    if (present) {
      if (e.key === 'Escape') return setMode(false)
      // 화면보다 긴 장면은 Space/PageDown/PageUp으로 먼저 끝까지 스크롤한다
      const f = frame(slides[cur]), down = e.key !== 'PageUp'
      if ((e.key === ' ' || e.key === 'PageDown' || e.key === 'PageUp') && !onControl &&
          (down ? f.scrollTop + f.clientHeight < f.scrollHeight - 1 : f.scrollTop > 0)) {
        e.preventDefault()
        f.scrollBy({ top: (down ? 1 : -1) * f.clientHeight * 0.85, behavior: reduce.matches ? 'auto' : 'smooth' })
        return
      }
      let d = 0
      if (NEXT.includes(e.key) && !onControl) d = 1
      else if (PREV.includes(e.key)) d = -1
      else if (e.key === 'Home') { e.preventDefault(); return show(0, false) }
      else if (e.key === 'End') { e.preventDefault(); return show(slides.length - 1, true) }
      if (d) { e.preventDefault(); step(d) }
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      go(cur + (e.key === 'ArrowRight' ? 1 : -1))
    }
  })

  // 탭·슬라이더·구간 스크럽: 사용자가 직접 상태를 바꾼다
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-to]')
    if (!b) return
    if (e.detail) b.blur() // 마우스 클릭이면 포커스를 풀어 Space/Enter가 장면 이동으로 가게
    set(b.closest('.st-stage'), +b.dataset.to)
  })
  document.addEventListener('input', e => {
    const t = e.target
    if (t.classList.contains('st-range')) set(t.closest('.st-stage'), +t.value)
    else if (t.classList.contains('st-scrub')) {
      const st = t.closest('.st-stage'), ro = st.querySelector(`.st-ro.b-${t.value}`)
      st.dataset.bin = t.value
      if (ro) t.setAttribute('aria-valuetext', ro.textContent)
    }
  })
  ctrl.addEventListener('click', e => {
    const b = e.target.closest('[data-act]')
    if (b && e.detail) b.blur()
    const act = b && b.dataset.act
    if (act === 'mode') setMode(!present)
    else if (act === 'prev') present ? step(-1) : go(cur - 1)
    else if (act === 'next') present ? step(1) : go(cur + 1)
  })
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href^="#"]')
    if (!a) return
    if (e.detail && a.closest('.st-rail')) a.blur()
    if (!present) return
    const n = slides.findIndex(s => s.id === decodeURIComponent(a.hash.slice(1)))
    if (n < 0) return
    e.preventDefault()
    show(n, false)
  })

  // 발표 모드 좌우 스와이프 (가로 스크롤·슬라이더 안에서는 무시)
  let tx = 0, ty = 0, skip = false
  addEventListener('touchstart', e => {
    const p = e.touches[0]
    tx = p.clientX; ty = p.clientY
    skip = !!(e.target.closest && e.target.closest('.st-tablewrap, pre, input'))
  }, { passive: true })
  addEventListener('touchend', e => {
    if (!present || skip) return
    const p = e.changedTouches[0], dx = p.clientX - tx, dy = p.clientY - ty
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1)
  }, { passive: true })

  // 인쇄: 모든 무대를 마지막 상태로, 모든 비트 글과 데이터 표를 펼친다 (전환 없이)
  addEventListener('beforeprint', () => {
    document.querySelectorAll('details.st-fallback').forEach(d => { d._open = d.open; d.open = true })
    stages.forEach(s => { s._s = +s.dataset.s; s.classList.add('st-init'); if (s.dataset.ctl === 'steps') s.dataset.s = s.dataset.n - 1 })
    document.querySelectorAll('li[data-st]').forEach(li => li.classList.add('is-on'))
  })
  addEventListener('afterprint', () => {
    document.querySelectorAll('details.st-fallback').forEach(d => { d.open = !!d._open })
    stages.forEach(s => set(s, s._s)) // st-init이 켜진 채라 전환·디졸브 없이 되돌린다
    requestAnimationFrame(() => requestAnimationFrame(() => stages.forEach(s => s.classList.remove('st-init'))))
  })

  sync()
  root.classList.add('js')
  window.__showtell = 1 // 설정이 끝난 뒤에만 표시: 도중에 오류가 나면 <head>의 안전장치가 숨김 상태를 해제한다
})()
