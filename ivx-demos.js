// ivx-demos.js — Keyword Demo Panel
// Replaces the keywords dropdown with animated SVG demos.
// Depends on: ivx-render.js (srcEl, updateHighlight, scheduleRender)
// Licensed under the Apache License, Version 2.0
// Copyright 2026 IVX

'use strict';

// ── Colour palette (matches syntax highlighter) ───────────────────────────────
const DC = {
  K: '#cba6f7',  // keyword purple
  V: '#9cdcfe',  // variable blue
  S: '#ce9178',  // string orange
  N: '#b5cea8',  // number green
  B: '#4a7fff',  // boolean blue
  F: '#c9a227',  // function gold
  C: '#4ec9b0',  // class teal
  G: '#4ade80',  // google green
  A: '#a78bfa',  // AI purple
  D: '#cdd6f4',  // default text
  M: '#6b7280',  // muted grey
};

// ── SVG helpers ───────────────────────────────────────────────────────────────
function ts(text, color) {
  const safe = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return color ? `<tspan fill="${color}">${safe}</tspan>` : `<tspan>${safe}</tspan>`;
}

function codeLine(x, y, parts, cls = '') {
  const inner = parts.map(([t, c]) => ts(t, c)).join('');
  const clsAttr = cls ? ` class="${cls}"` : '';
  return `<text x="${x}" y="${y}" font-family="monospace" font-size="12.5" opacity="1"${clsAttr}>${inner}</text>`;
}

function codePanel(width = 330, height = 280) {
  return `
    <rect x="20" y="20" width="${width}" height="${height}" rx="6" fill="#12121a" stroke="#2a2a40"/>
    <circle cx="40" cy="40" r="4" fill="#e05050"/>
    <circle cx="55" cy="40" r="4" fill="#f0a030"/>
    <circle cx="70" cy="40" r="4" fill="#00e5a0"/>`;
}

function termPanel(x, y, width, height, label = 'TERMINAL') {
  return `
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6" fill="#0d0d12" stroke="#2a2a40"/>
    <text x="${x + 14}" y="${y + 23}" font-family="monospace" font-size="9" fill="#4b5563" letter-spacing="1">${label}</text>
    <line x1="${x}" y1="${y + 30}" x2="${x + width}" y2="${y + 30}" stroke="#1e1e2e"/>`;
}

// Renamed from 'svg' to 'mkSvg' to avoid collision with ivx-render.js's
// `const svg = document.getElementById('canvas')`
function mkSvg(body, vw = 580, vh = 300) {
  return `<svg viewBox="0 0 ${vw} ${vh}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block;font-family:monospace">${body}</svg>`;
}

// ── Demo definitions ──────────────────────────────────────────────────────────
const IVX_DEMOS = [
  {
    id: 'make', label: 'make', color: DC.K,
    tagline: 'Assign a value to a variable',
    insert: 'make ',
    svgFn: () => mkSvg(`
      ${codePanel(330, 240)}
      ${codeLine(36, 82,  [['make ', DC.K], ['name ', DC.V], ['"Alice"', DC.S]])}
      ${codeLine(36, 108, [['make ', DC.K], ['score ', DC.V], ['42', DC.N]])}
      ${codeLine(36, 134, [['make ', DC.K], ['score ', DC.V], ['+ 8', DC.K], ['  note → 50', DC.M]])}
      ${codeLine(36, 160, [['make ', DC.K], ['active ', DC.V], ['yes', DC.B]])}
      ${termPanel(370, 20, 190, 240)}
      <text x="384" y="60"  font-family="monospace" font-size="11" fill="${DC.M}">name =</text>
      <text x="384" y="76"  font-family="monospace" font-size="13" fill="${DC.S}">"Alice"</text>
      <text x="384" y="100" font-family="monospace" font-size="11" fill="${DC.M}">score =</text>
      <text x="384" y="116" font-family="monospace" font-size="13" fill="${DC.N}">42 → 50</text>
      <text x="384" y="140" font-family="monospace" font-size="11" fill="${DC.M}">active =</text>
      <text x="384" y="156" font-family="monospace" font-size="13" fill="${DC.B}">yes</text>
    `),
  },
  {
    id: 'say', label: 'say', color: '#ED8936',
    tagline: 'Print a value to the terminal',
    insert: 'say ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-sy1{0%,10%,100%{opacity:0}20%,92%{opacity:1}}
        @keyframes ivx-sy2{0%,28%,100%{opacity:0}38%,92%{opacity:1}}
        @keyframes ivx-sy3{0%,50%,100%{opacity:0}60%,92%{opacity:1}}
        @keyframes ivx-sy4{0%,70%,100%{opacity:0}78%,92%{opacity:1}}
        @keyframes ivx-sycur{50%{opacity:0}}
        .ivx-sy1{animation:ivx-sy1 7s ease infinite}
        .ivx-sy2{animation:ivx-sy2 7s ease infinite}
        .ivx-sy3{animation:ivx-sy3 7s ease infinite}
        .ivx-sy4{animation:ivx-sy4 7s ease infinite}
        .ivx-sycur{animation:ivx-sycur 1s infinite}
      </style>
      ${codePanel(330, 260)}
      ${codeLine(36, 82,  [['make', DC.K], [' x ', DC.V], ['7', DC.N]])}
      ${codeLine(36, 108, [['say', '#ED8936'], [' "Hello!"', DC.S]])}
      ${codeLine(36, 134, [['say', '#ED8936'], [' x', DC.V]])}
      ${codeLine(36, 160, [['say', '#ED8936'], [' "x is ', DC.S], ['\u007bx\u007d', DC.V], ['"', DC.S]])}
      ${codeLine(36, 186, [['say', '#ED8936'], [' x ', DC.V], ['* 2', DC.K]])}
      ${termPanel(370, 20, 190, 260)}
      <text x="384" y="74"  font-family="monospace" font-size="13" fill="#ED8936" class="ivx-sy1">Hello!</text>
      <text x="384" y="100" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-sy2">7</text>
      <text x="384" y="126" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-sy3">x is 7</text>
      <text x="384" y="152" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-sy4">14</text>
      <rect x="384" y="158" width="2" height="13" fill="#ED8936" class="ivx-sycur ivx-sy4"/>
    `),
  },
  {
    id: 'take', label: 'take', color: DC.G,
    tagline: 'Read input from the user',
    insert: 'take ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-tkp1{0%,8%,100%{opacity:0}16%,92%{opacity:1}}
        @keyframes ivx-tkt1{0%,20%,100%{opacity:0}30%,92%{opacity:1}}
        @keyframes ivx-tkp2{0%,35%,100%{opacity:0}43%,92%{opacity:1}}
        @keyframes ivx-tkt2{0%,48%,100%{opacity:0}58%,92%{opacity:1}}
        @keyframes ivx-tkout{0%,65%,100%{opacity:0}73%,92%{opacity:1}}
        @keyframes ivx-tkcur{50%{opacity:0}}
        .ivx-tkp1{animation:ivx-tkp1 8s ease infinite}
        .ivx-tkt1{animation:ivx-tkt1 8s ease infinite}
        .ivx-tkp2{animation:ivx-tkp2 8s ease infinite}
        .ivx-tkt2{animation:ivx-tkt2 8s ease infinite}
        .ivx-tkout{animation:ivx-tkout 8s ease infinite}
        .ivx-tkcur{animation:ivx-tkcur 0.8s infinite}
      </style>
      ${codePanel(330, 200)}
      ${codeLine(36, 82,  [['take', DC.G], [' name', DC.V]])}
      ${codeLine(36, 108, [['take', DC.G], [' int', DC.B], ['(', DC.D], ['age', DC.V], [')', DC.D]])}
      ${codeLine(36, 134, [['say', DC.K], [' "Hi ', DC.S], ['\u007bname\u007d', DC.V], [', you are ', DC.S], ['\u007bage\u007d', DC.V], ['"', DC.S]])}
      ${termPanel(370, 20, 190, 260)}
      <text x="384" y="72"  font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-tkp1">name ›</text>
      <rect x="422" y="59" width="120" height="18" rx="3" fill="#1e1e2e" stroke="${DC.G}" stroke-width="0.8" class="ivx-tkp1"/>
      <text x="428" y="72"  font-family="monospace" font-size="11" fill="${DC.D}" class="ivx-tkt1">Alice</text>
      <rect x="455" y="61" width="2" height="14" fill="${DC.G}" class="ivx-tkp1 ivx-tkcur"/>
      <text x="384" y="102" font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-tkp2">age ›</text>
      <rect x="420" y="89" width="120" height="18" rx="3" fill="#1e1e2e" stroke="${DC.G}" stroke-width="0.8" class="ivx-tkp2"/>
      <text x="426" y="102" font-family="monospace" font-size="11" fill="${DC.D}" class="ivx-tkt2">30</text>
      <rect x="439" y="91" width="2" height="14" fill="${DC.G}" class="ivx-tkp2 ivx-tkcur"/>
      <text x="384" y="138" font-family="monospace" font-size="11" fill="#ED8936" class="ivx-tkout">Hi Alice,</text>
      <text x="384" y="154" font-family="monospace" font-size="11" fill="#ED8936" class="ivx-tkout">you are 30</text>
    `),
  },
  {
    id: 'give', label: 'give', color: DC.K,
    tagline: 'Return a value from a function',
    insert: 'give ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-gvcall{0%,15%,100%{opacity:0}25%,92%{opacity:1}}
        @keyframes ivx-gvr1{0%,30%,100%{opacity:0}42%,92%{opacity:1}}
        @keyframes ivx-gvr2{0%,52%,100%{opacity:0}62%,92%{opacity:1}}
        .ivx-gvcall{animation:ivx-gvcall 8s ease infinite}
        .ivx-gvr1{animation:ivx-gvr1 8s ease infinite}
        .ivx-gvr2{animation:ivx-gvr2 8s ease infinite}
      </style>
      ${codePanel(330, 260)}
      <rect x="28" y="58" width="314" height="74" rx="4" fill="${DC.F}" fill-opacity=".05" stroke="${DC.F}" stroke-opacity=".2"/>
      ${codeLine(36, 78,  [['fun', DC.F], [' double', DC.F], ['(n)', DC.D]])}
      ${codeLine(50, 104, [['give', DC.K], [' n ', DC.V], ['* 2', DC.K]])}
      ${codeLine(36, 148, [['say', DC.K], [' double', DC.F], ['(6)', DC.D]])}
      ${codeLine(36, 174, [['say', DC.K], [' double', DC.F], ['(21)', DC.D]])}
      ${codeLine(36, 200, [['say', DC.K], [' double', DC.F], ['(', DC.D], ['double', DC.F], ['(3))', DC.D]])}
      ${termPanel(370, 20, 190, 260)}
      <text x="384" y="90"  font-family="monospace" font-size="26" fill="#ED8936" font-weight="bold" class="ivx-gvr1">12</text>
      <text x="384" y="134" font-family="monospace" font-size="26" fill="#ED8936" font-weight="bold" class="ivx-gvr1">42</text>
      <text x="384" y="178" font-family="monospace" font-size="26" fill="#ED8936" font-weight="bold" class="ivx-gvr2">12</text>
      <text x="384" y="200" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-gvr2">double(double(3))</text>
      <text x="384" y="214" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-gvr2">= double(6) = 12</text>
    `),
  },
  {
    id: 'if', label: 'if', color: '#89b4fa',
    tagline: 'Branch on a condition',
    insert: 'if ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-ifa{0%,8%,100%{opacity:0}18%,92%{opacity:1}}
        @keyframes ivx-ifb{0%,35%,55%,100%{opacity:0}45%,52%{opacity:1}}
        @keyframes ivx-ifc{0%,60%,100%{opacity:0}70%,92%{opacity:1}}
        @keyframes ivx-ifhlb{0%,35%,55%,100%{fill:transparent}45%,52%{fill:rgba(137,180,250,0.1)}}
        @keyframes ivx-ifhlc{0%,60%,100%{fill:transparent}70%,92%{fill:rgba(137,180,250,0.1)}}
        .ivx-ifa{animation:ivx-ifa 8s ease infinite}
        .ivx-ifb{animation:ivx-ifb 8s ease infinite}
        .ivx-ifc{animation:ivx-ifc 8s ease infinite}
        .ivx-ifhlb{animation:ivx-ifhlb 8s ease infinite}
        .ivx-ifhlc{animation:ivx-ifhlc 8s ease infinite}
      </style>
      ${codePanel(330, 260)}
      ${codeLine(36, 82,  [['make', DC.K], [' score ', DC.V], ['85', DC.N]])}
      ${codeLine(36, 108, [['if', '#89b4fa'], [' score ', DC.V], ['>= 90', '#89b4fa']])}
      ${codeLine(50, 132, [['say', DC.K], [' "A grade"', DC.S]])}
      <rect x="28" y="142" width="314" height="22" rx="2"/>
      ${codeLine(36, 158, [['else if', '#89b4fa'], [' score ', DC.V], ['>= 80', '#89b4fa']])}
      ${codeLine(50, 182, [['say', DC.K], [' "B grade"', DC.S]])}
      <rect x="28" y="192" width="314" height="22" rx="2"/>
      ${codeLine(36, 208, [['else', '#89b4fa']])}
      ${codeLine(50, 232, [['say', DC.K], [' "C grade"', DC.S]])}
      ${termPanel(370, 20, 190, 260)}
      <text x="384" y="70"  font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-ifa">score = 85</text>
      <text x="384" y="88"  font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-ifa">85 ≥ 90? no</text>
      <text x="384" y="108" font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-ifb">85 ≥ 80? yes</text>
      <text x="384" y="148" font-family="monospace" font-size="22" fill="#ED8936" font-weight="bold" class="ivx-ifb">B grade</text>
      <text x="384" y="196" font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-ifc">score = 65</text>
      <text x="384" y="214" font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-ifc">65 ≥ 80? no →</text>
      <text x="384" y="248" font-family="monospace" font-size="16" fill="#ED8936" font-weight="bold" class="ivx-ifc">C grade</text>
    `),
  },
  {
    id: 'else', label: 'else', color: '#89b4fa',
    tagline: 'Alternate branch when if is false',
    insert: 'else ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-ela{0%,10%,100%{opacity:0}20%,92%{opacity:1}}
        @keyframes ivx-elb{0%,40%,100%{opacity:0}50%,92%{opacity:1}}
        @keyframes ivx-elhlb{0%,35%,100%{fill:transparent}45%,92%{fill:rgba(137,180,250,0.1)}}
        .ivx-ela{animation:ivx-ela 7s ease infinite}
        .ivx-elb{animation:ivx-elb 7s ease infinite}
        .ivx-elhlb{animation:ivx-elhlb 7s ease infinite}
      </style>
      ${codePanel(330, 220)}
      ${codeLine(36, 82,  [['make', DC.K], [' temp ', DC.V], ['15', DC.N]])}
      ${codeLine(36, 108, [['if', '#89b4fa'], [' temp ', DC.V], ['> 20', '#89b4fa']])}
      ${codeLine(50, 132, [['say', DC.K], [' "warm"', DC.S]])}
      <rect x="28" y="142" width="314" height="22" rx="2"/>
      ${codeLine(36, 158, [['else', '#89b4fa']])}
      ${codeLine(50, 182, [['say', DC.K], [' "cold"', DC.S]])}
      ${termPanel(370, 20, 190, 220)}
      <text x="384" y="70"  font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-ela">temp = 15</text>
      <text x="384" y="88"  font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-ela">15 &gt; 20? no</text>
      <text x="384" y="108" font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-ela">→ else branch</text>
      <text x="384" y="152" font-family="monospace" font-size="22" fill="#ED8936" font-weight="bold" class="ivx-elb">cold</text>
    `),
  },
  {
    id: 'loop', label: 'loop', color: DC.K,
    tagline: 'Repeat while a condition is true',
    insert: 'loop ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-lp1{0%,8%,100%{opacity:0}16%,92%{opacity:1}}
        @keyframes ivx-lp2{0%,22%,100%{opacity:0}30%,92%{opacity:1}}
        @keyframes ivx-lp3{0%,36%,100%{opacity:0}44%,92%{opacity:1}}
        @keyframes ivx-lp4{0%,50%,100%{opacity:0}58%,92%{opacity:1}}
        @keyframes ivx-lp5{0%,64%,100%{opacity:0}72%,92%{opacity:1}}
        @keyframes ivx-lpdone{0%,78%,100%{opacity:0}86%,92%{opacity:1}}
        .ivx-lp1{animation:ivx-lp1 8s ease infinite}
        .ivx-lp2{animation:ivx-lp2 8s ease infinite}
        .ivx-lp3{animation:ivx-lp3 8s ease infinite}
        .ivx-lp4{animation:ivx-lp4 8s ease infinite}
        .ivx-lp5{animation:ivx-lp5 8s ease infinite}
        .ivx-lpdone{animation:ivx-lpdone 8s ease infinite}
      </style>
      ${codePanel(330, 200)}
      ${codeLine(36, 82,  [['loop', DC.K], [' count? ', DC.V], ['< 5', '#89b4fa']])}
      ${codeLine(50, 108, [['say', DC.K], [' count', DC.V]])}
      ${codeLine(50, 134, [['make', DC.K], [' count ', DC.V], ['+ 1', DC.K]])}
      ${codeLine(36, 170, [['note count? starts at 0', DC.M]])}
      ${termPanel(370, 20, 190, 260)}
      <text x="384" y="74"  font-family="monospace" font-size="16" fill="#ED8936" class="ivx-lp1">0</text>
      <text x="384" y="100" font-family="monospace" font-size="16" fill="#ED8936" class="ivx-lp2">1</text>
      <text x="384" y="126" font-family="monospace" font-size="16" fill="#ED8936" class="ivx-lp3">2</text>
      <text x="384" y="152" font-family="monospace" font-size="16" fill="#ED8936" class="ivx-lp4">3</text>
      <text x="384" y="178" font-family="monospace" font-size="16" fill="#ED8936" class="ivx-lp5">4</text>
      <text x="384" y="216" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-lpdone">5 &lt; 5 → false</text>
      <text x="384" y="230" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-lpdone">loop exits</text>
    `),
  },
  {
    id: 'for', label: 'for', color: DC.K,
    tagline: 'Iterate over a list — i = value, ii = index',
    insert: 'for ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-fr1{0%,8%,38%,100%{opacity:0}16%,34%{opacity:1}}
        @keyframes ivx-fr2{0%,38%,68%,100%{opacity:0}46%,64%{opacity:1}}
        @keyframes ivx-fr3{0%,68%,92%,100%{opacity:0}76%,90%{opacity:1}}
        @keyframes ivx-frh1{0%,8%,38%,100%{fill:#1a1a26}16%,34%{fill:rgba(137,180,250,0.18)}}
        @keyframes ivx-frh2{0%,38%,68%,100%{fill:#1a1a26}46%,64%{fill:rgba(137,180,250,0.18)}}
        @keyframes ivx-frh3{0%,68%,92%,100%{fill:#1a1a26}76%,90%{fill:rgba(137,180,250,0.18)}}
        .ivx-fr1{animation:ivx-fr1 9s ease infinite}
        .ivx-fr2{animation:ivx-fr2 9s ease infinite}
        .ivx-fr3{animation:ivx-fr3 9s ease infinite}
        .ivx-frh1{animation:ivx-frh1 9s ease infinite}
        .ivx-frh2{animation:ivx-frh2 9s ease infinite}
        .ivx-frh3{animation:ivx-frh3 9s ease infinite}
      </style>
      ${codePanel(310, 220)}
      ${codeLine(36, 82,  [['make', DC.K], [' colors ', DC.V], ['["red","green","blue"]', DC.M]])}
      ${codeLine(36, 108, [['for', DC.K], [' color ', DC.V], ['in', DC.K], [' colors', DC.V]])}
      ${codeLine(50, 134, [['say', DC.K], [' color', DC.V]])}
      ${codeLine(36, 175, [['note i = value, ii = index', DC.M]])}
      <rect x="330" y="30" width="110" height="26" rx="3" fill="#1a1a2e" stroke="#2a2a3e"/>
      <text x="344" y="47" font-family="monospace" font-size="12" fill="${DC.S}">"red"</text>
      <rect x="330" y="62" width="110" height="26" rx="3" fill="#1a1a2e" stroke="#2a2a3e"/>
      <text x="344" y="79" font-family="monospace" font-size="12" fill="${DC.S}">"green"</text>
      <rect x="330" y="94" width="110" height="26" rx="3" fill="#1a1a2e" stroke="#2a2a3e"/>
      <text x="344" y="111" font-family="monospace" font-size="12" fill="${DC.S}">"blue"</text>
      ${termPanel(450, 20, 110, 220, 'OUT')}
      <text x="464" y="76"  font-family="monospace" font-size="13" fill="#ED8936" class="ivx-fr1">red</text>
      <text x="464" y="102" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-fr2">green</text>
      <text x="464" y="128" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-fr3">blue</text>
    `),
  },
  {
    id: 'end', label: 'end', color: '#f87171',
    tagline: 'Terminate a flow path early',
    insert: 'end ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-enstep{0%,8%,100%{opacity:0}16%,92%{opacity:1}}
        @keyframes ivx-enhit{0%,50%,100%{opacity:0}60%,92%{opacity:1}}
        @keyframes ivx-enshake{0%,60%,100%{transform:translateX(0)}63%{transform:translateX(-4px)}66%{transform:translateX(4px)}69%{transform:translateX(-3px)}72%{transform:translateX(0)}}
        .ivx-enstep{animation:ivx-enstep 8s ease infinite}
        .ivx-enhit{animation:ivx-enhit 8s ease infinite}
        .ivx-enshake{animation:ivx-enshake 8s ease infinite;transform-origin:455px 170px}
      </style>
      ${codePanel(330, 240)}
      ${codeLine(36, 82,  [['make', DC.K], [' nums ', DC.V], ['[3, 7, 2, 9, 1]', DC.M]])}
      ${codeLine(36, 108, [['for', DC.K], [' num ', DC.V], ['in', DC.K], [' nums', DC.V]])}
      ${codeLine(50, 132, [['if', '#89b4fa'], [' num ', DC.V], ['= 9', '#89b4fa']])}
      ${codeLine(64, 156, [['end', '#f87171'], [' say', DC.K], [' "found \u007bnum\u007d!"', DC.S]])}
      ${codeLine(50, 180, [['say', DC.K], [' num', DC.V]])}
      ${termPanel(370, 20, 190, 260)}
      <text x="384" y="76"  font-family="monospace" font-size="13" fill="#ED8936" class="ivx-enstep">3</text>
      <text x="384" y="100" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-enstep">7</text>
      <text x="384" y="124" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-enstep">2</text>
      <g class="ivx-enshake">
        <rect x="372" y="138" width="180" height="30" rx="3" fill="#f87171" fill-opacity=".1" stroke="#f87171" stroke-opacity=".5" class="ivx-enhit"/>
        <text x="384" y="158" font-family="monospace" font-size="13" fill="#f87171" font-weight="bold" class="ivx-enhit">found 9!</text>
      </g>
      <text x="384" y="202" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-enhit">loop stopped —</text>
      <text x="384" y="216" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-enhit">1 never visited</text>
    `),
  },
  {
    id: 'fun', label: 'fun', color: DC.F,
    tagline: 'Define a reusable function',
    insert: 'fun ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-fncall{0%,15%,100%{opacity:0}25%,92%{opacity:1}}
        @keyframes ivx-fnr1{0%,30%,100%{opacity:0}42%,92%{opacity:1}}
        @keyframes ivx-fnr2{0%,52%,100%{opacity:0}62%,92%{opacity:1}}
        .ivx-fncall{animation:ivx-fncall 8s ease infinite}
        .ivx-fnr1{animation:ivx-fnr1 8s ease infinite}
        .ivx-fnr2{animation:ivx-fnr2 8s ease infinite}
      </style>
      ${codePanel(330, 260)}
      <rect x="28" y="58" width="314" height="92" rx="4" fill="${DC.F}" fill-opacity=".05" stroke="${DC.F}" stroke-opacity=".2"/>
      ${codeLine(36, 78,  [['fun', DC.F], [' greet', DC.F], ['(name, greeting', DC.D], ['? ', DC.K], ['"Hi"', DC.S], [')', DC.D]])}
      ${codeLine(50, 104, [['give', DC.K], [' "\u007bgreeting\u007d, \u007bname\u007d!"', DC.S]])}
      ${codeLine(50, 128, [['note greeting defaults to "Hi"', DC.M]])}
      ${codeLine(36, 172, [['say', DC.K], [' greet', DC.F], ['("Alice")', DC.D]])}
      ${codeLine(36, 198, [['say', DC.K], [' greet', DC.F], ['("Bob", "Hey")', DC.D]])}
      ${termPanel(370, 20, 190, 260)}
      <text x="384" y="110" font-family="monospace" font-size="17" fill="#ED8936" font-weight="bold" class="ivx-fnr1">Hi, Alice!</text>
      <text x="384" y="170" font-family="monospace" font-size="17" fill="#ED8936" font-weight="bold" class="ivx-fnr2">Hey, Bob!</text>
      <text x="384" y="210" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-fnr2">greeting overridden</text>
    `),
  },
  {
    id: 'class', label: 'class', color: DC.C,
    tagline: 'Define a blueprint for objects',
    insert: 'class ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-clinst{0%,18%,100%{opacity:0}28%,92%{opacity:1}}
        @keyframes ivx-clcall{0%,45%,100%{opacity:0}55%,92%{opacity:1}}
        @keyframes ivx-clout{0%,62%,100%{opacity:0}72%,92%{opacity:1}}
        .ivx-clinst{animation:ivx-clinst 8s ease infinite}
        .ivx-clcall{animation:ivx-clcall 8s ease infinite}
        .ivx-clout{animation:ivx-clout 8s ease infinite}
      </style>
      ${codePanel(310, 260)}
      <rect x="28" y="58" width="294" height="182" rx="4" fill="${DC.C}" fill-opacity=".04" stroke="${DC.C}" stroke-opacity=".15"/>
      ${codeLine(36, 78,  [['class', DC.C], [' Counter', DC.D]])}
      ${codeLine(50, 100, [['init', DC.F], ['(start', DC.D], ['? ', DC.K], ['0', DC.N], [')', DC.D]])}
      ${codeLine(50, 122, [['fun', DC.F], [' bump', DC.F], ['()', DC.D]])}
      ${codeLine(64, 144, [['make', DC.K], [' self', DC.C], ['.', DC.D], ['start ', DC.V], ['+ 1', DC.K]])}
      ${codeLine(50, 166, [['fun', DC.F], [' value', DC.F], ['()', DC.D]])}
      ${codeLine(64, 188, [['give', DC.K], [' self', DC.C], ['.', DC.D], ['start', DC.V]])}
      ${termPanel(330, 20, 240, 260)}
      <text x="344" y="72"  font-family="monospace" font-size="11" fill="${DC.M}">make c Counter(10)</text>
      <rect x="336" y="80" width="224" height="54" rx="4" fill="#1a1a2e" stroke="#3a3a5c"/>
      <text x="348" y="100" font-family="monospace" font-size="11" fill="${DC.M}">start = 10</text>
      <text x="348" y="120" font-family="monospace" font-size="10" fill="#4b5563">methods: bump, value</text>
      <text x="344" y="160" font-family="monospace" font-size="11" fill="${DC.M}">c.bump()  c.bump()</text>
      <text x="344" y="178" font-family="monospace" font-size="11" fill="${DC.M}">say c.value()</text>
      <text x="344" y="224" font-family="monospace" font-size="28" fill="#ED8936" font-weight="bold">12</text>
      <text x="344" y="248" font-family="monospace" font-size="10" fill="${DC.M}">10 + 1 + 1 = 12</text>
    `),
  },
  {
    id: 'try', label: 'try / err', color: '#f59e0b',
    tagline: 'Catch and handle runtime errors',
    insert: 'try\n  \nerr e\n  ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-tryok{0%,8%,55%,100%{opacity:0}18%,50%{opacity:1}}
        @keyframes ivx-tryerr{0%,58%,100%{opacity:0}68%,94%{opacity:1}}
        @keyframes ivx-trycont{0%,30%,100%{opacity:0}40%,92%{opacity:1}}
        @keyframes ivx-trycont2{0%,80%,100%{opacity:0}88%,94%{opacity:1}}
        @keyframes ivx-tryshake{0%,68%,100%{transform:translateX(0)}71%{transform:translateX(-4px)}74%{transform:translateX(4px)}77%{transform:translateX(-3px)}80%{transform:translateX(0)}}
        .ivx-tryok{animation:ivx-tryok 9s ease infinite}
        .ivx-tryerr{animation:ivx-tryerr 9s ease infinite}
        .ivx-trycont{animation:ivx-trycont 9s ease infinite}
        .ivx-trycont2{animation:ivx-trycont2 9s ease infinite}
        .ivx-tryshake{animation:ivx-tryshake 9s ease infinite;transform-origin:455px 180px}
      </style>
      ${codePanel(330, 260)}
      <rect x="28" y="58" width="6" height="76" rx="3" fill="#f59e0b" fill-opacity=".5"/>
      ${codeLine(36, 78,  [['try', '#f59e0b']])}
      ${codeLine(50, 104, [['make', DC.K], [' data ', DC.V], ['https://api.x.com', '#56b6c2']])}
      ${codeLine(50, 128, [['say', DC.K], [' data', DC.V]])}
      <rect x="28" y="140" width="6" height="64" rx="3" fill="#f87171" fill-opacity=".5"/>
      ${codeLine(36, 160, [['err', '#f87171'], [' msg', DC.V]])}
      ${codeLine(50, 184, [['say', DC.K], [' "Failed: ', DC.S], ['\u007bmsg\u007d', DC.V], ['"', DC.S]])}
      ${codeLine(36, 224, [['say', DC.K], [' "done"', DC.S]])}
      ${termPanel(370, 20, 190, 260)}
      <text x="384" y="72"  font-family="monospace" font-size="11" fill="${DC.M}" class="ivx-tryok">✓ fetch ok</text>
      <text x="384" y="90"  font-family="monospace" font-size="11" fill="#ED8936" class="ivx-tryok">{ status: 200 }</text>
      <text x="384" y="118" font-family="monospace" font-size="11" fill="#ED8936" class="ivx-trycont">done</text>
      <g class="ivx-tryshake">
        <rect x="372" y="140" width="180" height="28" rx="3" fill="#f87171" fill-opacity=".1" stroke="#f87171" stroke-opacity=".5" class="ivx-tryerr"/>
        <text x="384" y="158" font-family="monospace" font-size="11" fill="#f87171" class="ivx-tryerr">Failed: network error</text>
      </g>
      <text x="384" y="196" font-family="monospace" font-size="11" fill="#ED8936" class="ivx-trycont2">done</text>
      <text x="384" y="214" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-trycont2">always runs ↑</text>
    `),
  },
  {
    id: 'dot', label: 'dot', color: '#9ca3af',
    tagline: 'Explicit connector — merge branches in the flowchart',
    insert: 'dot\n',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-dtflow{from{stroke-dashoffset:120}60%,100%{stroke-dashoffset:0}}
        @keyframes ivx-dtpulse{0%,100%{r:7;opacity:.6}50%{r:10;opacity:1}}
        .ivx-dtflow{stroke-dasharray:120;animation:ivx-dtflow 3s ease infinite}
        .ivx-dtpulse{animation:ivx-dtpulse 1.5s ease infinite}
      </style>
      ${codePanel(280, 260)}
      ${codeLine(36, 82,  [['if', '#89b4fa'], [' x ', DC.V], ['> 10', '#89b4fa']])}
      ${codeLine(50, 106, [['say', DC.K], [' "big"', DC.S]])}
      ${codeLine(36, 130, [['else', '#89b4fa']])}
      ${codeLine(50, 154, [['say', DC.K], [' "small"', DC.S]])}
      <line x1="28" y1="166" x2="264" y2="166" stroke="#2a2a3e"/>
      ${codeLine(36, 186, [['dot', '#9ca3af']])}
      ${codeLine(36, 210, [['say', DC.K], [' "either way, done"', DC.S]])}
      <g transform="translate(296,20)">
        <rect width="264" height="260" rx="6" fill="#0d0d12" stroke="#2a2a40"/>
        <text x="14" y="23" font-family="monospace" font-size="9" fill="#4b5563" letter-spacing="1">FLOWCHART</text>
        <line x1="0" y1="30" x2="264" y2="30" stroke="#1e1e2e"/>
        <polygon points="132,48 172,78 132,108 92,78" fill="#004b8d" stroke="#4a9eff" stroke-width="1.5"/>
        <text x="132" y="82" font-family="monospace" font-size="9" fill="#fff" text-anchor="middle">x &gt; 10</text>
        <path d="M 92 78 L 52 138" stroke="#4ade80" stroke-width="1.5" fill="none" class="ivx-dtflow"/>
        <rect x="14" y="138" width="74" height="22" rx="3" fill="#1e2d3e" stroke="#4ade80" stroke-opacity=".5"/>
        <text x="51" y="153" font-family="monospace" font-size="9" fill="${DC.D}" text-anchor="middle">"big"</text>
        <path d="M 172 78 L 212 138" stroke="#f87171" stroke-width="1.5" fill="none" class="ivx-dtflow"/>
        <rect x="176" y="138" width="74" height="22" rx="3" fill="#1e2d3e" stroke="#f87171" stroke-opacity=".5"/>
        <text x="213" y="153" font-family="monospace" font-size="9" fill="${DC.D}" text-anchor="middle">"small"</text>
        <path d="M 51 160 Q 51 200 132 200" stroke="#9ca3af" stroke-width="1.5" fill="none" class="ivx-dtflow"/>
        <path d="M 213 160 Q 213 200 132 200" stroke="#9ca3af" stroke-width="1.5" fill="none" class="ivx-dtflow"/>
        <circle cx="132" cy="200" class="ivx-dtpulse" fill="#bbb"/>
        <text x="132" y="234" font-family="monospace" font-size="9" fill="#6b7280" text-anchor="middle">dot — merge point</text>
      </g>
    `),
  },
  {
    id: 'wait', label: 'wait', color: DC.G,
    tagline: 'Pause or block until a trigger fires',
    insert: 'wait ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-wtidle{0%,8%,100%{opacity:0}16%,52%{opacity:1}58%{opacity:0}}
        @keyframes ivx-wtfire{0%,55%,100%{opacity:0}65%,92%{opacity:1}}
        @keyframes ivx-wtrow{0%,55%,100%{fill:#1a1a26}65%,92%{fill:rgba(74,222,128,0.18)}}
        @keyframes ivx-wtreply{0%,72%,100%{opacity:0}80%,92%{opacity:1}}
        .ivx-wtidle{animation:ivx-wtidle 9s ease infinite}
        .ivx-wtfire{animation:ivx-wtfire 9s ease infinite}
        .ivx-wtrow{animation:ivx-wtrow 9s ease infinite}
        .ivx-wtreply{animation:ivx-wtreply 9s ease infinite}
      </style>
      ${codePanel(310, 250)}
      ${codeLine(36, 82,  [['wait every', DC.G], [' email', DC.D]])}
      ${codeLine(50, 104, [['by', DC.K], [' "boss@example.com"', DC.S]])}
      ${codeLine(50, 128, [['make', DC.K], [' subj ', DC.V], ['request', DC.D], ['["subject"]', DC.M]])}
      ${codeLine(50, 152, [['email', DC.G], [' "boss@example.com"', DC.S]])}
      ${codeLine(64, 174, [['subject', DC.M], [' "Re: \u007bsubj\u007d"', DC.S]])}
      ${codeLine(64, 196, [['body', DC.M], [' "On it!"', DC.S]])}
      ${termPanel(330, 20, 240, 260, 'INBOX')}
      <text x="344" y="76"  font-family="monospace" font-size="11" fill="${DC.M}">⏳ waiting for email…</text>
      <rect x="338" y="88"  width="224" height="42" rx="3"/>
      <text x="350" y="106" font-family="monospace" font-size="10" fill="${DC.G}" font-weight="bold">From: boss@example.com</text>
      <text x="350" y="122" font-family="monospace" font-size="10" fill="${DC.D}">Subject: deploy today?</text>
      <rect x="338" y="152" width="224" height="42" rx="3" fill="#1a2e1a" stroke="${DC.G}" stroke-opacity=".5"/>
      <text x="350" y="170" font-family="monospace" font-size="10" fill="${DC.G}" font-weight="bold">Auto-reply sent ✓</text>
      <text x="350" y="186" font-family="monospace" font-size="10" fill="${DC.M}">Re: deploy today? → "On it!"</text>
    `),
  },
  {
    id: 'ask', label: 'ask', color: DC.A,
    tagline: 'Call an AI model and get a response',
    insert: 'ask gemini ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-aksend{0%,10%,100%{opacity:0}20%,45%{opacity:1}55%{opacity:0}}
        @keyframes ivx-akd1{0%,25%,100%{opacity:0}35%{opacity:1}50%{opacity:0}}
        @keyframes ivx-akd2{0%,30%,100%{opacity:0}40%{opacity:1}55%{opacity:0}}
        @keyframes ivx-akd3{0%,35%,100%{opacity:0}45%{opacity:1}60%{opacity:0}}
        @keyframes ivx-akresp{0%,55%,100%{opacity:0}65%,92%{opacity:1}}
        .ivx-aksend{animation:ivx-aksend 8s ease infinite}
        .ivx-akd1{animation:ivx-akd1 8s ease infinite}
        .ivx-akd2{animation:ivx-akd2 8s ease infinite}
        .ivx-akd3{animation:ivx-akd3 8s ease infinite}
        .ivx-akresp{animation:ivx-akresp 8s ease infinite}
      </style>
      ${codePanel(310, 200)}
      ${codeLine(36, 82,  [['key', DC.K], [' "my-gemini-key"', DC.S]])}
      ${codeLine(36, 108, [['make', DC.K], [' result ', DC.V], ['ask', DC.A], [' gemini', DC.D]])}
      ${codeLine(50, 132, [['"Summarise computing history"', DC.S]])}
      ${codeLine(36, 158, [['say', DC.K], [' result', DC.V]])}
      ${termPanel(330, 20, 240, 270)}
      <rect x="342" y="62" width="214" height="24" rx="4" fill="${DC.A}" fill-opacity=".12" stroke="${DC.A}" stroke-opacity=".4"/>
      <text x="352" y="77" font-family="monospace" font-size="10" fill="${DC.A}">Summarise computing history</text>
      <circle cx="360" cy="108" r="5" fill="${DC.A}" class="ivx-akd1"/>
      <circle cx="378" cy="108" r="5" fill="${DC.A}" class="ivx-akd2"/>
      <circle cx="396" cy="108" r="5" fill="${DC.A}" class="ivx-akd3"/>
      <rect x="342" y="68" width="214" height="118" rx="4" fill="#1a1a2e" stroke="#3a3a5c"/>
      <text x="352" y="88"  font-family="monospace" font-size="10" fill="${DC.D}">Computing began with</text>
      <text x="352" y="104" font-family="monospace" font-size="10" fill="${DC.D}">Babbage's Analytical</text>
      <text x="352" y="120" font-family="monospace" font-size="10" fill="${DC.D}">Engine in the 1830s.</text>
      <text x="352" y="136" font-family="monospace" font-size="10" fill="${DC.D}">ENIAC (1945) was the</text>
      <text x="352" y="152" font-family="monospace" font-size="10" fill="${DC.D}">first electronic computer.</text>
      <text x="352" y="168" font-family="monospace" font-size="10" fill="${DC.D}">Silicon chips followed…</text>
    `),
  },
  {
    id: 'email', label: 'email', color: DC.G,
    tagline: 'Send an email via Gmail',
    insert: 'email "" subject "" body ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-emup{0%,15%{opacity:0;transform:translateY(0)}25%{opacity:1;transform:translateY(0)}55%{opacity:1;transform:translateY(-50px)}65%{opacity:0}}
        @keyframes ivx-eminbox{0%,60%,100%{opacity:0}70%,92%{opacity:1}}
        .ivx-emup{animation:ivx-emup 7s ease infinite}
        .ivx-eminbox{animation:ivx-eminbox 7s ease infinite}
      </style>
      ${codePanel(310, 220)}
      ${codeLine(36, 82,  [['make', DC.K], [' to ', DC.V], ['"alice@example.com"', DC.S]])}
      ${codeLine(36, 108, [['email', DC.G], [' to', DC.V]])}
      ${codeLine(50, 132, [['subject', DC.M], [' "Welcome!"', DC.S]])}
      ${codeLine(50, 156, [['body', DC.M], [' "Thanks for joining us."', DC.S]])}
      <g class="ivx-emup">
        <rect x="115" y="178" width="150" height="40" rx="4" fill="#1a2e1a" stroke="${DC.G}" stroke-width="1.5"/>
        <text x="126" y="195" font-family="monospace" font-size="10" fill="${DC.G}" font-weight="bold">Welcome!</text>
        <text x="126" y="210" font-family="monospace" font-size="9"  fill="${DC.M}">Thanks for joining us.</text>
      </g>
      ${termPanel(330, 20, 240, 260, 'INBOX · alice@…')}
      <rect x="338" y="68" width="224" height="50" rx="4" fill="#1a2e1a" stroke="${DC.G}" stroke-opacity=".6"/>
      <text x="350" y="88"  font-family="monospace" font-size="11" fill="${DC.G}" font-weight="bold">Welcome! ✓</text>
      <text x="350" y="106" font-family="monospace" font-size="10" fill="${DC.M}">Thanks for joining us.</text>
    `),
  },
  {
    id: 'sheets', label: 'sheets', color: DC.G,
    tagline: 'Read and write Google Sheets',
    insert: 'sheets ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-shread{0%,8%,100%{opacity:0}18%,92%{opacity:1}}
        @keyframes ivx-shappend{0%,55%,100%{fill:#1a1a26}65%,90%{fill:rgba(74,222,128,0.18)}}
        @keyframes ivx-shapptext{0%,58%,100%{opacity:0}68%,90%{opacity:1}}
        .ivx-shread{animation:ivx-shread 8s ease infinite}
        .ivx-shappend{animation:ivx-shappend 8s ease infinite}
        .ivx-shapptext{animation:ivx-shapptext 8s ease infinite}
      </style>
      ${codePanel(300, 240)}
      ${codeLine(36, 82,  [['make', DC.K], [' s ', DC.V], ['sheets', DC.G], [' "Sales"', DC.S]])}
      ${codeLine(36, 106, [['make', DC.K], [' data ', DC.V], ['s', DC.V], ['.read', DC.F], ['("A1:C5")', DC.D]])}
      ${codeLine(36, 130, [['for', DC.K], [' row ', DC.V], ['in', DC.K], [' data', DC.V]])}
      ${codeLine(50, 154, [['say', DC.K], [' row', DC.V], ['[0]', DC.M]])}
      ${codeLine(36, 178, [['s', DC.V], ['.append', DC.F], ['(["Eve", 99, "West"])', DC.D]])}
      <g transform="translate(316,20)">
        <rect width="244" height="260" rx="6" fill="#0d0d12" stroke="#2a2a40"/>
        <text x="14" y="23" font-family="monospace" font-size="9" fill="${DC.G}" letter-spacing="1">Sales</text>
        <line x1="0" y1="30" x2="244" y2="30" stroke="#1e1e2e"/>
        <rect x="8" y="36" width="228" height="20" rx="2" fill="#1e3a1e"/>
        <text x="16" y="50" font-family="monospace" font-size="9" fill="${DC.G}">Name</text>
        <text x="76" y="50" font-family="monospace" font-size="9" fill="${DC.G}">Sales</text>
        <text x="126" y="50" font-family="monospace" font-size="9" fill="${DC.G}">Region</text>
        <rect x="8" y="60" width="228" height="20" rx="2" fill="#1a1a26"/>
        <text x="16" y="74" font-family="monospace" font-size="9" fill="${DC.D}">Alice</text>
        <text x="76" y="74" font-family="monospace" font-size="9" fill="${DC.N}">1200</text>
        <text x="126" y="74" font-family="monospace" font-size="9" fill="${DC.D}">West</text>
        <rect x="8" y="82" width="228" height="20" rx="2" fill="#1a1a26"/>
        <text x="16" y="96" font-family="monospace" font-size="9" fill="${DC.D}">Bob</text>
        <text x="76" y="96" font-family="monospace" font-size="9" fill="${DC.N}">980</text>
        <text x="126" y="96" font-family="monospace" font-size="9" fill="${DC.D}">East</text>
        <rect x="8" y="104" width="228" height="20" rx="2" fill="#1a1a26"/>
        <text x="16" y="118" font-family="monospace" font-size="9" fill="${DC.D}">Carol</text>
        <text x="76" y="118" font-family="monospace" font-size="9" fill="${DC.N}">1450</text>
        <text x="126" y="118" font-family="monospace" font-size="9" fill="${DC.D}">West</text>
        <rect x="8" y="126" width="228" height="20" rx="2"/>
        <text x="16"  y="140" font-family="monospace" font-size="9" fill="${DC.G}">Eve</text>
        <text x="76"  y="140" font-family="monospace" font-size="9" fill="${DC.G}">99</text>
        <text x="126" y="140" font-family="monospace" font-size="9" fill="${DC.G}">West ← new</text>
      </g>
    `),
  },
  {
    id: 'key', label: 'key', color: DC.K,
    tagline: 'Set a global API credential',
    insert: 'key ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-keyr1{0%,20%,100%{opacity:0}30%,92%{opacity:1}}
        @keyframes ivx-keyr2{0%,50%,100%{opacity:0}60%,92%{opacity:1}}
        .ivx-keyr1{animation:ivx-keyr1 7s ease infinite}
        .ivx-keyr2{animation:ivx-keyr2 7s ease infinite}
      </style>
      ${codePanel(330, 200)}
      ${codeLine(36, 82,  [['key', DC.K], [' "my-gemini-api-key"', DC.S]])}
      ${codeLine(36, 108, [['make', DC.K], [' r1 ', DC.V], ['ask', DC.A], [' gemini ', DC.D], ['"Hello!"', DC.S]])}
      ${codeLine(36, 134, [['make', DC.K], [' r2 ', DC.V], ['ask', DC.A], [' gemini ', DC.D], ['"Goodbye!"', DC.S]])}
      ${termPanel(370, 20, 190, 260)}
      <text x="384" y="68"  font-family="monospace" font-size="10" fill="${DC.M}">🔑 credential set</text>
      <text x="384" y="100" font-family="monospace" font-size="12" fill="#ED8936" class="ivx-keyr1">Hello!</text>
      <text x="384" y="130" font-family="monospace" font-size="12" fill="#ED8936" class="ivx-keyr2">Goodbye!</text>
      <text x="384" y="170" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-keyr2">both calls used</text>
      <text x="384" y="184" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-keyr2">the same key</text>
    `),
  },
  {
    id: 'from', label: 'from … use', color: DC.G,
    tagline: 'Import and alias functions from a URL',
    insert: 'from \n  use  as \n  use  as ',
    svgFn: () => mkSvg(`
      <style>
        @keyframes ivx-fra{0%,8%,100%{opacity:0}18%,92%{opacity:1}}
        @keyframes ivx-frb{0%,30%,100%{opacity:0}40%,92%{opacity:1}}
        @keyframes ivx-frc{0%,52%,100%{opacity:0}62%,92%{opacity:1}}
        @keyframes ivx-frd{0%,70%,100%{opacity:0}80%,92%{opacity:1}}
        .ivx-fra{animation:ivx-fra 9s ease infinite}
        .ivx-frb{animation:ivx-frb 9s ease infinite}
        .ivx-frc{animation:ivx-frc 9s ease infinite}
        .ivx-frd{animation:ivx-frd 9s ease infinite}
      </style>
      ${codePanel(370, 260)}
      ${codeLine(36, 78,  [['from', DC.G], [' https://ivxs.tech/std/math', '#56b6c2']])}
      ${codeLine(50, 102, [['use', DC.G], [' cosine ', DC.F], ['as', DC.K], [' c', DC.F]])}
      ${codeLine(50, 126, [['use', DC.G], [' sine ', DC.F], ['as', DC.K], [' s', DC.F]])}
      ${codeLine(50, 150, [['use', DC.G], [' fibonacci ', DC.F], ['as', DC.K], [' fib', DC.F]])}
      ${codeLine(36, 186, [['say', DC.K], [' c', DC.F], ['(0)', DC.D]])}
      ${codeLine(36, 210, [['say', DC.K], [' s', DC.F], ['(0)', DC.D]])}
      ${codeLine(36, 234, [['say', DC.K], [' fib', DC.F], ['(10)', DC.D]])}
      ${termPanel(390, 20, 170, 260)}
      <text x="404" y="100" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-fra">1.0</text>
      <text x="404" y="118" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-fra">cosine(0)</text>
      <text x="404" y="148" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-frb">0.0</text>
      <text x="404" y="166" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-frb">sine(0)</text>
      <text x="404" y="196" font-family="monospace" font-size="13" fill="#ED8936" class="ivx-frc">55</text>
      <text x="404" y="214" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-frc">fibonacci(10)</text>
      <text x="404" y="244" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-frd">c, s, fib — all</text>
      <text x="404" y="258" font-family="monospace" font-size="10" fill="${DC.M}" class="ivx-frd">local aliases</text>
    `, 580, 300),
  },

// ── string ──────────────────────────────────────────────────────────────────
  {
    id: 'type-string', label: 'string', color: DC.S,
    tagline: 'Text in double quotes — supports \u007binterpolation\u007d',
    insert: '"" ',
    svgFn: () => mkSvg(`
      ${codePanel(310, 280)}
      ${codeLine(36, 78,  [['make ', DC.K], ['a ', DC.V], ['"Hello"', DC.S]])}
      ${codeLine(36, 100, [['make ', DC.K], ['b ', DC.V], ['"World"', DC.S]])}
      ${codeLine(36, 122, [['make ', DC.K], ['c ', DC.V], ['"\u007ba\u007d, \u007bb\u007d!"', DC.S]])}
      ${codeLine(36, 152, [['say ', DC.K], ['size', DC.F], ['(a)', DC.D]])}
      ${codeLine(36, 174, [['say ', DC.K], ['upper', DC.F], ['(a)', DC.D]])}
      ${codeLine(36, 196, [['say ', DC.K], ['a ', DC.V], ['+ " " + ', DC.K], ['b', DC.V]])}
      ${codeLine(36, 218, [['say ', DC.K], ['a', DC.V], ['[0]', DC.M]])}
      ${codeLine(36, 248, [['note Ops: + size() upper() lower()', DC.M]])}
      ${codeLine(36, 262, [['note split() trim() replace() sub()', DC.M]])}
      ${termPanel(330, 20, 230, 280)}
      <text x="344" y="78"  font-family="monospace" font-size="11" fill="${DC.M}">c =</text>
      <text x="344" y="94"  font-family="monospace" font-size="13" fill="${DC.S}">"Hello, World!"</text>
      <text x="344" y="122" font-family="monospace" font-size="11" fill="${DC.M}">size(a) =</text>
      <text x="344" y="138" font-family="monospace" font-size="13" fill="${DC.N}">5</text>
      <text x="344" y="166" font-family="monospace" font-size="13" fill="${DC.S}">"HELLO"</text>
      <text x="344" y="194" font-family="monospace" font-size="13" fill="${DC.S}">"Hello World"</text>
      <text x="344" y="222" font-family="monospace" font-size="13" fill="${DC.S}">"H"</text>
    `, 580, 300),
  },

  // ── integer ─────────────────────────────────────────────────────────────────
  {
    id: 'type-integer', label: 'integer', color: DC.N,
    tagline: 'Whole numbers — + - * // % ^ and comparisons',
    insert: '0',
    svgFn: () => mkSvg(`
      ${codePanel(310, 260)}
      ${codeLine(36, 78,  [['make ', DC.K], ['a ', DC.V], ['17', DC.N]])}
      ${codeLine(36, 100, [['make ', DC.K], ['b ', DC.V], ['5', DC.N]])}
      ${codeLine(36, 130, [['say ', DC.K], ['a ', DC.V], ['+ ', DC.K], ['b', DC.V]])}
      ${codeLine(36, 152, [['say ', DC.K], ['a ', DC.V], ['// ', DC.K], ['b', DC.V]])}
      ${codeLine(36, 174, [['say ', DC.K], ['a ', DC.V], ['% ', DC.K], ['b', DC.V]])}
      ${codeLine(36, 196, [['say ', DC.K], ['a ', DC.V], ['^ 2', DC.K]])}
      ${codeLine(36, 226, [['note // is floor division', DC.M]])}
      ${codeLine(36, 240, [['note ^ is exponent, not XOR', DC.M]])}
      ${termPanel(330, 20, 230, 260)}
      <text x="344" y="100" font-family="monospace" font-size="13" fill="${DC.N}">22</text>
      <text x="344" y="122" font-family="monospace" font-size="11" fill="${DC.M}">a + b</text>
      <text x="344" y="148" font-family="monospace" font-size="13" fill="${DC.N}">3</text>
      <text x="344" y="170" font-family="monospace" font-size="11" fill="${DC.M}">a // b  (floor)</text>
      <text x="344" y="196" font-family="monospace" font-size="13" fill="${DC.N}">2</text>
      <text x="344" y="218" font-family="monospace" font-size="11" fill="${DC.M}">a % b  (remainder)</text>
      <text x="344" y="244" font-family="monospace" font-size="13" fill="${DC.N}">289</text>
    `, 580, 280),
  },

  // ── float ───────────────────────────────────────────────────────────────────
  {
    id: 'type-float', label: 'float', color: '#14b8a6',
    tagline: 'Decimal numbers — use flt() to convert',
    insert: '0.0',
    svgFn: () => mkSvg(`
      ${codePanel(310, 240)}
      ${codeLine(36, 78,  [['make ', DC.K], ['x ', DC.V], ['3.14', DC.N]])}
      ${codeLine(36, 100, [['make ', DC.K], ['y ', DC.V], ['flt', DC.F], ['(2)', DC.D]])}
      ${codeLine(36, 130, [['say ', DC.K], ['x ', DC.V], ['* 2', DC.K]])}
      ${codeLine(36, 152, [['say ', DC.K], ['round', DC.F], ['(x, 1)', DC.D]])}
      ${codeLine(36, 174, [['say ', DC.K], ['int', DC.F], ['(x)', DC.D]])}
      ${codeLine(36, 196, [['say ', DC.K], ['7 / 2', DC.K]])}
      ${codeLine(36, 222, [['note / always gives float', DC.M]])}
      ${codeLine(36, 236, [['note // always gives integer', DC.M]])}
      ${termPanel(330, 20, 230, 240)}
      <text x="344" y="100" font-family="monospace" font-size="13" fill="#14b8a6">6.28</text>
      <text x="344" y="128" font-family="monospace" font-size="13" fill="#14b8a6">3.1</text>
      <text x="344" y="156" font-family="monospace" font-size="13" fill="${DC.N}">3</text>
      <text x="344" y="184" font-family="monospace" font-size="13" fill="#14b8a6">3.5</text>
      <text x="344" y="206" font-family="monospace" font-size="11" fill="${DC.M}">/ gives float</text>
    `, 580, 260),
  },

  // ── boolean ─────────────────────────────────────────────────────────────────
  {
    id: 'type-boolean', label: 'boolean', color: DC.B,
    tagline: 'yes or no — combine with and, or, not',
    insert: 'yes',
    svgFn: () => mkSvg(`
      ${codePanel(310, 260)}
      ${codeLine(36, 78,  [['make ', DC.K], ['a ', DC.V], ['yes', DC.B]])}
      ${codeLine(36, 100, [['make ', DC.K], ['b ', DC.V], ['no', DC.B]])}
      ${codeLine(36, 130, [['say ', DC.K], ['a ', DC.V], ['and ', DC.K], ['b', DC.V]])}
      ${codeLine(36, 152, [['say ', DC.K], ['a ', DC.V], ['or ', DC.K], ['b', DC.V]])}
      ${codeLine(36, 174, [['say ', DC.K], ['not ', DC.K], ['a', DC.V]])}
      ${codeLine(36, 196, [['say ', DC.K], ['10 > 5', DC.K]])}
      ${codeLine(36, 218, [['say ', DC.K], ['"x" ', DC.S], ['in ', DC.K], ['"text"', DC.S]])}
      ${termPanel(330, 20, 230, 260)}
      <text x="344" y="100" font-family="monospace" font-size="13" fill="${DC.B}">no</text>
      <text x="344" y="128" font-family="monospace" font-size="13" fill="${DC.B}">yes</text>
      <text x="344" y="156" font-family="monospace" font-size="13" fill="${DC.B}">no</text>
      <text x="344" y="184" font-family="monospace" font-size="13" fill="${DC.B}">yes</text>
      <text x="344" y="212" font-family="monospace" font-size="13" fill="${DC.B}">yes</text>
    `, 580, 280),
  },

  // ── none ────────────────────────────────────────────────────────────────────
  {
    id: 'type-none', label: 'none', color: '#ef4444',
    tagline: 'The absence of a value — test with = none',
    insert: 'none',
    svgFn: () => mkSvg(`
      ${codePanel(310, 240)}
      ${codeLine(36, 78,  [['make ', DC.K], ['x ', DC.V], ['none', DC.M]])}
      ${codeLine(36, 108, [['if ', DC.K], ['x ', DC.V], ['= none', DC.K]])}
      ${codeLine(50, 130, [['say ', DC.K], ['"nothing here"', DC.S]])}
      ${codeLine(36, 158, [['make ', DC.K], ['x ', DC.V], ['42', DC.N]])}
      ${codeLine(36, 180, [['if ', DC.K], ['x ', DC.V], ['!= none', DC.K]])}
      ${codeLine(50, 202, [['say ', DC.K], ['"got \u007bx\u007d"', DC.S]])}
      ${codeLine(36, 228, [['note functions give none by default', DC.M]])}
      ${termPanel(330, 20, 230, 240)}
      <text x="344" y="100" font-family="monospace" font-size="13" fill="#ef4444">none</text>
      <text x="344" y="128" font-family="monospace" font-size="13" fill="${DC.S}">"nothing here"</text>
      <text x="344" y="170" font-family="monospace" font-size="13" fill="${DC.N}">42</text>
      <text x="344" y="198" font-family="monospace" font-size="13" fill="${DC.S}">"got 42"</text>
    `, 580, 260),
  },

  // ── list ────────────────────────────────────────────────────────────────────
  {
    id: 'type-list', label: 'list', color: '#9ca3af',
    tagline: 'Ordered collection — index with [n], iterate with for',
    insert: '[]',
    svgFn: () => mkSvg(`
      ${codePanel(310, 280)}
      ${codeLine(36, 78,  [['make ', DC.K], ['nums ', DC.V], ['[10, 20, 30]', DC.M]])}
      ${codeLine(36, 100, [['say ', DC.K], ['nums', DC.V], ['[0]', DC.M]])}
      ${codeLine(36, 122, [['say ', DC.K], ['size', DC.F], ['(nums)', DC.D]])}
      ${codeLine(36, 144, [['push', DC.F], ['(nums, 40)', DC.D]])}
      ${codeLine(36, 166, [['say ', DC.K], ['nums', DC.V]])}
      ${codeLine(36, 188, [['say ', DC.K], ['nums', DC.V], ['[1:3]', DC.M]])}
      ${codeLine(36, 218, [['note [1:3] is a slice', DC.M]])}
      ${codeLine(36, 232, [['note push pop head drop reverse', DC.M]])}
      ${termPanel(330, 20, 230, 280)}
      <text x="344" y="100" font-family="monospace" font-size="13" fill="#9ca3af">10</text>
      <text x="344" y="128" font-family="monospace" font-size="13" fill="${DC.N}">3</text>
      <text x="344" y="168" font-family="monospace" font-size="13" fill="#9ca3af">[10, 20, 30, 40]</text>
      <text x="344" y="196" font-family="monospace" font-size="13" fill="#9ca3af">[20, 30]</text>
    `, 580, 300),
  },

  // ── dict ────────────────────────────────────────────────────────────────────
  {
    id: 'type-dict', label: 'dict', color: '#7a4d2e',
    tagline: 'Key-value pairs — access with ["key"] or .key',
    insert: '{}',
    svgFn: () => mkSvg(`
      ${codePanel(310, 260)}
      ${codeLine(36, 78,  [['make ', DC.K], ['p ', DC.V], ['{"name": "Alice", "age": 30}', DC.M]])}
      ${codeLine(36, 100, [['say ', DC.K], ['p', DC.V], ['["name"]', DC.M]])}
      ${codeLine(36, 122, [['make ', DC.K], ['p', DC.V], ['["age"] ', DC.K], ['31', DC.N]])}
      ${codeLine(36, 144, [['say ', DC.K], ['"age" ', DC.S], ['in ', DC.K], ['p', DC.V]])}
      ${codeLine(36, 166, [['say ', DC.K], ['keys', DC.F], ['(p)', DC.D]])}
      ${codeLine(36, 188, [['say ', DC.K], ['size', DC.F], ['(p)', DC.D]])}
      ${codeLine(36, 214, [['note keys() values() size() in', DC.M]])}
      ${termPanel(330, 20, 230, 260)}
      <text x="344" y="100" font-family="monospace" font-size="13" fill="${DC.S}">"Alice"</text>
      <text x="344" y="144" font-family="monospace" font-size="13" fill="${DC.B}">yes</text>
      <text x="344" y="172" font-family="monospace" font-size="13" fill="#9ca3af">["name", "age"]</text>
      <text x="344" y="200" font-family="monospace" font-size="13" fill="${DC.N}">2</text>
    `, 580, 280),
  },
];

// ── Demo index ────────────────────────────────────────────────────────────────
const IVX_DEMO_MAP = Object.fromEntries(IVX_DEMOS.filter(d => d && d.id).map(d => [d.id, d]));


const IVX_DEMO_SECTIONS = [
  { label: 'Data',         ids: ['make', 'say', 'take'] },
  { label: 'Control Flow', ids: ['if', 'else', 'loop', 'for', 'end', 'dot', 'try'] },
  { label: 'Functions',    ids: ['give', 'fun', 'class'] },
  { label: 'Network & AI', ids: ['ask', 'wait', 'email', 'sheets', 'key', 'from'] },
  { label: 'Types',        ids: ['type-string', 'type-integer', 'type-float', 'type-boolean', 'type-none', 'type-list', 'type-dict'] },
];

let _demoPanel = null;
let _currentDemoId = 'make';

function _buildDemoPanel() {
  const panel = document.createElement('div');
  panel.id = 'ivx-demo-panel';

  const sidebar = document.createElement('div');
  sidebar.id = 'ivx-demo-sidebar';

  IVX_DEMO_SECTIONS.forEach(sec => {
    const secEl = document.createElement('div');
    secEl.className = 'ivx-demo-section';
    const lbl = document.createElement('div');
    lbl.className = 'ivx-demo-section-label';
    lbl.textContent = sec.label;
    secEl.appendChild(lbl);
    sec.ids.forEach(id => {
      const demo = IVX_DEMO_MAP[id];
      if (!demo) return;
      const btn = document.createElement('button');
      btn.className = 'ivx-demo-kw-btn';
      btn.dataset.demoId = id;
      btn.textContent = demo.label;
      btn.addEventListener('click', () => _selectDemo(id));
      secEl.appendChild(btn);
    });
    sidebar.appendChild(secEl);
  });

  const main = document.createElement('div');
  main.id = 'ivx-demo-main';

  const hdr = document.createElement('div');
  hdr.id = 'ivx-demo-hdr';

  const titleEl = document.createElement('span');
  titleEl.id = 'ivx-demo-title';
  const sep = document.createElement('span');
  sep.id = 'ivx-demo-sep';
  const taglineEl = document.createElement('span');
  taglineEl.id = 'ivx-demo-tagline';

  const replayBtn = document.createElement('button');
  replayBtn.id = 'ivx-demo-replay';
  replayBtn.textContent = '↺ replay';
  replayBtn.addEventListener('click', () => _replayDemo());

  const insertBtn = document.createElement('button');
  insertBtn.id = 'ivx-demo-insert';
  insertBtn.textContent = '← insert';
  insertBtn.addEventListener('click', () => _insertDemo());

  hdr.append(titleEl, sep, taglineEl, replayBtn, insertBtn);

  const viewport = document.createElement('div');
  viewport.id = 'ivx-demo-viewport';

  main.append(hdr, viewport);
  panel.append(sidebar, main);
  return panel;
}

function _renderDemo(id) {
  const demo = IVX_DEMO_MAP[id];
  if (!demo) return;
  _currentDemoId = id;

  const titleEl   = document.getElementById('ivx-demo-title');
  const taglineEl = document.getElementById('ivx-demo-tagline');
  if (titleEl)   { titleEl.textContent = demo.label; titleEl.style.color = demo.color; }
  if (taglineEl)   taglineEl.textContent = demo.tagline;

  const viewport = document.getElementById('ivx-demo-viewport');
  if (!viewport) return;
  viewport.innerHTML = demo.svgFn();

  document.querySelectorAll('.ivx-demo-kw-btn').forEach(btn => {
    const active = btn.dataset.demoId === id;
    btn.classList.toggle('ivx-demo-kw-btn--active', active);
    btn.style.color           = active ? demo.color : '';
    btn.style.borderLeftColor = active ? demo.color : '';
    btn.style.background      = active ? `${demo.color}18` : '';
  });
}

function _selectDemo(id) { _renderDemo(id); }
function _replayDemo()   { _renderDemo(_currentDemoId); }

function _insertDemo() {
  const demo = IVX_DEMO_MAP[_currentDemoId];
  if (!demo || typeof srcEl === 'undefined') return;
  const s = srcEl.selectionStart, e = srcEl.selectionEnd;
  srcEl.value = srcEl.value.slice(0, s) + demo.insert + srcEl.value.slice(e);
  srcEl.selectionStart = srcEl.selectionEnd = s + demo.insert.length;
  srcEl.focus();
  if (typeof updateHighlight === 'function') updateHighlight();
  if (typeof scheduleRender  === 'function') scheduleRender();
  _closePanel();
}

function _openPanel() {
  if (!_demoPanel) {
    _demoPanel = _buildDemoPanel();
    document.getElementById('ep').appendChild(_demoPanel);
  }
  _demoPanel.style.display = 'flex';
  _renderDemo(_currentDemoId);
}

function _closePanel() {
  if (_demoPanel) _demoPanel.style.display = 'none';
}

function _togglePanel() {
  if (!_demoPanel || _demoPanel.style.display === 'none') _openPanel();
  else _closePanel();
}

// ── Wire up the Keywords button ───────────────────────────────────────────────
window.addEventListener('load', function initDemoPanel() {
  // Clear any stale cached panel so section layout always reflects current code
  const stale = document.getElementById('ivx-demo-panel');
  if (stale) stale.remove();
  _demoPanel = null;

  const btn = document.getElementById('help-menu-btn');
  const oldMenu = document.getElementById('help-menu');
  if (!btn) return;

  if (oldMenu) oldMenu.remove();

  // Clone to strip any lingering listeners
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);

  fresh.textContent = 'Keywords';

  fresh.addEventListener('click', e => {
    e.stopPropagation();
    _togglePanel();
    fresh.classList.toggle('on', _demoPanel?.style.display !== 'none');
  });

  document.addEventListener('click', e => {
    if (_demoPanel && _demoPanel.style.display !== 'none') {
      if (!_demoPanel.contains(e.target) && e.target !== fresh) {
        _closePanel();
        fresh.classList.remove('on');
      }
    }
  });
});
