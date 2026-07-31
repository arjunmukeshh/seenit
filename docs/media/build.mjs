// Regenerates every image in the README.
//
//   node docs/media/build.mjs
//
// These are generated rather than hand-made for one reason: the README's sample
// output has already gone stale once, and a stale screenshot is worse than a
// stale paragraph because nobody thinks to doubt it. So the terminal shot is
// rendered from the CLI's real bytes and the recall chart is drawn from
// calibration/results/recall.json. Nothing here is drawn by hand except the
// diagram, which depicts an algorithm rather than a measurement.
//
// Needs a Chrome binary; Firefox's --screenshot fires on the load event and
// captures pages before webfonts settle. Point SEENIT_CHROME at one, or:
//
//   npx @puppeteer/browsers install chrome@stable --path /tmp/browsers

import { execFile as execFileCb } from 'node:child_process'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'node:net'

const execFile = promisify(execFileCb)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const OUT = HERE

// ---------------------------------------------------------------- chrome

async function findChrome() {
  if (process.env.SEENIT_CHROME) return process.env.SEENIT_CHROME
  const fixed = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  for (const p of fixed) if (existsSync(p)) return p

  // Whatever `@puppeteer/browsers install` last dropped in a cache directory.
  for (const base of [join(tmpdir(), 'browsers'), join(process.env.HOME ?? '', '.cache', 'puppeteer')]) {
    const dir = join(base, 'chrome')
    if (!existsSync(dir)) continue
    for (const v of await readdir(dir)) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux64/chrome',
      ]) {
        const p = join(dir, v, rel)
        if (existsSync(p)) return p
      }
    }
  }
  throw new Error(
    'no Chrome found. Set SEENIT_CHROME, or run:\n' +
      `  npx @puppeteer/browsers install chrome@stable --path ${join(tmpdir(), 'browsers')}`,
  )
}

// 2x by default, so the images stay sharp on the displays people actually read
// READMEs on. Full-page overviews pass scale: 1 — at 2x they cost a megabyte to
// show detail nobody reads at that zoom.
async function shoot(chrome, url, out, { width, height, scale = 2 }) {
  await execFile(chrome, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${width},${height}`,
    '--virtual-time-budget=10000',
    `--screenshot=${out}`,
    url,
  ])
}

// ---------------------------------------------------------------- shared css

// encodeURI, because a checkout under a path with a space ("~/My Projects")
// would otherwise produce a broken url() and silently fall back to a system
// font — the images would still build, just wrong.
const FONTS = encodeURI(join(ROOT, 'node_modules'))
const fontCss = `
@font-face {
  font-family: 'Plex Mono';
  src: url('file://${FONTS}/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2') format('woff2');
  font-weight: 400;
}
@font-face {
  font-family: 'Plex Mono';
  src: url('file://${FONTS}/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2') format('woff2');
  font-weight: 500;
}
@font-face {
  font-family: 'Plex Sans';
  src: url('file://${FONTS}/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2') format('woff2');
  font-weight: 100 700;
}
`

// The observatory's dark palette, so the images and the product agree.
const page = (body, css = '') => `<!doctype html><meta charset="utf-8"><style>
${fontCss}
:root {
  --paper: #0e0e0d; --panel: #141413; --rule: #262624;
  --ink: #e8e6e1; --ink-2: #c2bfb6; --ink-3: #8a8780; --ink-4: #5c5a55;
  --good: #7fb069; --warn: #d9a544; --bad: #cf6a5a; --accent: #d9a544;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--paper); font-family: 'Plex Sans', sans-serif; color: var(--ink);
       -webkit-font-smoothing: antialiased; }
.mono { font-family: 'Plex Mono', monospace; }
${css}
</style>${body}`

// ---------------------------------------------------------------- 1. the hero

// Real bytes from the real CLI. FORCE_COLOR because stdout here is a pipe, and
// without it colorsFor() returns the plain palette — the shot would show output
// no user with a terminal ever sees.
async function cliOutput() {
  const { stdout } = await execFile('node', [join(ROOT, 'bin', 'seenit.mjs')], {
    cwd: ROOT,
    maxBuffer: 1 << 24,
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  return stdout.replace(/\r/g, '').replace(/^\n+|\n+$/g, '')
}

const ANSI_CLASS = { 1: 'b', 2: 'd', 31: 'red', 32: 'green', 33: 'yellow' }

// A deliberately small ANSI subset — exactly the five codes lib/format.js emits.
function ansiToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let out = ''
  let open = 0
  for (const chunk of text.split(/\x1b\[(\d+)m/)) {
    if (/^\d+$/.test(chunk)) {
      const code = Number(chunk)
      if (code === 0) {
        out += '</span>'.repeat(open)
        open = 0
      } else if (ANSI_CLASS[code]) {
        out += `<span class="${ANSI_CLASS[code]}">`
        open++
      }
    } else {
      out += esc(chunk)
    }
  }
  return out + '</span>'.repeat(open)
}

async function hero(chrome) {
  const body = ansiToHtml(await cliOutput())
  const html = page(
    `<div class="win">
       <div class="bar"><i></i><i></i><i></i><span class="mono">~/projects/seenit</span></div>
       <pre class="mono"><span class="prompt">$</span> <span class="cmd">npx seenit</span>\n\n${body}</pre>
     </div>`,
    `body { padding: 28px; }
     .win { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; }
     .bar { display: flex; align-items: center; gap: 7px; padding: 11px 14px;
            border-bottom: 1px solid var(--rule); background: #100f0e; }
     .bar i { width: 10px; height: 10px; border-radius: 50%; background: #2e2d2a; }
     .bar span { margin-left: 10px; font-size: 11.5px; color: var(--ink-4); }
     pre { padding: 18px 22px 20px; font-size: 12.5px; line-height: 1.62; color: var(--ink-2);
           white-space: pre-wrap; }
     .prompt { color: var(--good); }
     .cmd { color: var(--ink); font-weight: 500; }
     .b { color: var(--ink); font-weight: 500; }
     .d { color: var(--ink-4); }
     .green { color: var(--good); } .yellow { color: var(--warn); } .red { color: var(--bad); }`,
  )
  const f = join(tmpdir(), 'seenit-hero.html')
  await writeFile(f, html)
  await shoot(chrome, `file://${f}`, join(OUT, 'cli.png'), { width: 760, height: 470 })
}

// ---------------------------------------------------------------- 2. the diagram

// The one hand-drawn image, because it depicts the algorithm rather than a
// measurement. Text and structure only — no numbers that could go stale.
async function pipeline(chrome) {
  const before = [
    ['kw', 'function'], ['id', ' calculateOrderTotal'], ['p', '(items, taxRate) {'],
  ]
  const after = [
    ['cm', '// basket cost'], ['br', ''], ['kw', 'function'], ['id', ' computeBasketSum'], ['p', '(lines, vatFraction) {'],
  ]
  const norm = ['function', 'ID', '(', 'ID', ',', 'ID', ')', '{']

  const snippet = (rows) =>
    `<pre class="mono snip">${rows
      .map(([c, t]) => (c === 'br' ? '\n' : `<span class="${c}">${t}</span>`))
      .join('')}</pre>`

  const html = page(
    `<div class="wrap">
       <div class="row">
         <div class="col">
           <div class="cap">two files, nothing in common to <b>grep</b></div>
           <div class="pair">${snippet(before)}${snippet(after)}</div>
         </div>
       </div>

       <div class="arrow"><span>tree-sitter parses · identifiers, literals and comments normalised away — ours</span></div>

       <div class="row">
         <div class="col">
           <div class="cap">one token stream, twice</div>
           <div class="tokens mono">${norm
             .map((t) => `<span class="tok${t === 'ID' ? ' hot' : ''}">${t}</span>`)
             .join('')}</div>
         </div>
       </div>

       <div class="arrow"><span>jscpd matches the normalised stream · Rabin-Karp, in Rust</span></div>

       <div class="row">
         <div class="col">
           <div class="cap">the shared region comes back with real line numbers</div>
           <div class="align">
             <div class="lane"><span class="lbl mono">A</span>${[0, 1, 2, 3, 4, 5]
               .map((i) => `<span class="fp${[1, 2, 3, 4].includes(i) ? ' on' : ''}"></span>`)
               .join('')}</div>
             <div class="lane"><span class="lbl mono">B</span>${[0, 1, 2, 3, 4, 5]
               .map((i) => `<span class="fp${[2, 3, 4, 5].includes(i) ? ' on' : ''}"></span>`)
               .join('')}</div>
             <div class="note mono">contiguous block &nbsp;·&nbsp; orders.js:41-58</div>
           </div>
         </div>
       </div>
     </div>`,
    `body { padding: 30px 34px; width: 720px; }
     .cap { font-size: 11.5px; color: var(--ink-3); margin-bottom: 9px; letter-spacing: .01em; }
     .cap b { color: var(--ink-2); font-weight: 500; }
     .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
     .snip { background: var(--panel); border: 1px solid var(--rule); border-radius: 7px;
             padding: 12px 13px; font-size: 11.5px; line-height: 1.65; color: var(--ink-2);
             white-space: pre-wrap; min-height: 62px; }
     .kw { color: #9db7c4; } .id { color: var(--bad); font-weight: 500; }
     .p { color: var(--ink-3); } .cm { color: var(--ink-4); font-style: italic; }
     .arrow { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
     .arrow::before, .arrow::after { content: ''; height: 1px; background: var(--rule); flex: 1; }
     .arrow span { font-size: 10.5px; color: var(--ink-4); white-space: nowrap; }
     .tokens { display: flex; flex-wrap: wrap; gap: 6px; }
     .tok { background: var(--panel); border: 1px solid var(--rule); border-radius: 5px;
            padding: 5px 9px; font-size: 11.5px; color: var(--ink-2); }
     .tok.hot { border-color: #4a4127; color: var(--warn); }
     .align { background: var(--panel); border: 1px solid var(--rule); border-radius: 7px; padding: 14px 16px; }
     .lane { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
     .lbl { width: 14px; font-size: 11px; color: var(--ink-4); }
     .fp { width: 54px; height: 9px; border-radius: 2px; background: #232220; }
     .fp.on { background: var(--warn); }
     .note { font-size: 10.5px; color: var(--ink-4); padding-left: 20px; }`,
  )
  const f = join(tmpdir(), 'seenit-pipeline.html')
  await writeFile(f, html)
  await shoot(chrome, `file://${f}`, join(OUT, 'pipeline.png'), { width: 720, height: 415 })
}

// ---------------------------------------------------------------- 3. the chart

// Drawn from the measurement file, never from numbers typed in here, so it
// cannot disagree with the README table or with what the tool ships.
async function recall(chrome) {
  const data = JSON.parse(await readFile(join(ROOT, 'calibration', 'results', 'recall.json'), 'utf8'))
  const LABELS = {
    verbatim: 'pasted\nunchanged',
    rename: 'identifiers\nrenamed',
    'rename+literals': 'literals\nchanged',
    '+reformat': 'reformatted',
    '+comments': 'comments\nchurned',
    '+reorder': 'statements\nreordered',
    '+extract': 'variable\nextracted',
  }
  const levels = Object.keys(LABELS)
  // One line per threshold. The interesting result is how FLAT they are: the bar
  // is nearly irrelevant to recall until statements move, and only then do they
  // separate. A single series would hide that.
  const SERIES = [
    { p: '30', name: 'shipped (k=30)', color: 'var(--warn)' },
    { p: '20', name: 'wider (k=20)', color: 'var(--good)' },
    { p: '75', name: 'stricter (k=75)', color: 'var(--bad)', faint: true },
  ]

  const W = 680
  const H = 260
  const PAD = { l: 42, r: 136, t: 16, b: 52 }
  const x = (i) => PAD.l + (i * (W - PAD.l - PAD.r)) / (levels.length - 1)
  const y = (v) => PAD.t + (1 - (v - 0.5) / 0.5) * (H - PAD.t - PAD.b)

  const grid = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
    .map(
      (v) =>
        `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--rule)" stroke-width="1"/>
         <text x="${PAD.l - 9}" y="${y(v) + 3.5}" class="ax" text-anchor="end">${v.toFixed(1)}</text>`,
    )
    .join('')

  const lines = SERIES.map(({ p, color, faint }) => {
    const pts = levels.map((l, i) => `${x(i)},${y(data.heldOut[p][l].recall)}`).join(' ')
    const dots = levels
      .map((l, i) => `<circle cx="${x(i)}" cy="${y(data.heldOut[p][l].recall)}" r="${faint ? 2 : 3.2}" fill="${color}"/>`)
      .join('')
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${faint ? 1.3 : 2}"
              ${faint ? 'stroke-dasharray="4 3" opacity="0.75"' : ''}/>${dots}`
  }).join('')

  const legend = SERIES.map(({ p, name, color }, i) => {
    const last = data.heldOut[p]['+extract'].recall
    return `<g transform="translate(${W - PAD.r + 14}, ${PAD.t + 12 + i * 34})">
              <rect x="0" y="-7" width="14" height="2.5" fill="${color}" rx="1"/>
              <text x="21" y="-3" class="lg">${name}</text>
              <text x="21" y="12" class="lgv" fill="${color}">${last.toFixed(2)}</text>
            </g>`
  }).join('')

  const ticks = levels
    .map(
      (l, i) =>
        LABELS[l]
          .split('\n')
          .map((line, j) => `<text x="${x(i)}" y="${H - PAD.b + 20 + j * 12}" class="ax" text-anchor="middle">${line}</text>`)
          .join(''),
    )
    .join('')

  const html = page(
    `<div class="card">
       <div class="head">
         <span class="t">Held-out recall</span>
         <span class="s mono">${data.repos.holdout} repositories · bar chosen on the other ${data.repos.tune}</span>
       </div>
       <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
         ${grid}${lines}${ticks}${legend}
       </svg>
       <div class="foot">Each step keeps every earlier one. A copy is planted, then found or missed — ground truth by construction. The threshold barely matters until statements are reordered.</div>
     </div>`,
    `body { padding: 26px; width: 740px; }
     .card { background: var(--panel); border: 1px solid var(--rule); border-radius: 9px; padding: 18px 20px 16px; }
     .head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
     .t { font-size: 13px; font-weight: 500; color: var(--ink); }
     .s { font-size: 10.5px; color: var(--ink-4); }
     .foot { font-size: 10.5px; color: var(--ink-4); margin-top: 6px; }
     .ax { font-family: 'Plex Mono', monospace; font-size: 9.5px; fill: var(--ink-4); }
     .lg { font-family: 'Plex Sans', sans-serif; font-size: 11px; fill: var(--ink-2); }
     .lgv { font-family: 'Plex Mono', monospace; font-size: 14px; font-weight: 500; }`,
  )
  const f = join(tmpdir(), 'seenit-recall.html')
  await writeFile(f, html)
  await shoot(chrome, `file://${f}`, join(OUT, 'recall.png'), { width: 740, height: 392 })
}

// ---------------------------------------------------------------- 4. the app

// Served from a clone whose directory is named `seenit`, because the header
// shows the checkout's directory name and a screenshot captioned with the old
// name of the project is its own small lie. The ledger is copied across so the
// history rail is real history rather than an empty column.
// ----------------------------------------------------------------------------

const steps = new Map([
  ['cli', hero],
  ['pipeline', pipeline],
  ['recall', recall],
])

// Reject typos instead of silently doing nothing, the same rule bin/seenit.mjs
// applies to its flags: `build.mjs clii` exiting 0 having produced nothing looks
// exactly like success.
const only = process.argv.slice(2)
const unknown = only.filter((n) => !steps.has(n))
if (unknown.length) {
  console.error(`unknown image: ${unknown.join(', ')}`)
  console.error(`Available: ${[...steps.keys()].join(', ')}  (no arguments builds all of them)`)
  process.exit(1)
}
const want = (n) => only.length === 0 || only.includes(n)

const chrome = await findChrome()
await mkdir(OUT, { recursive: true })

for (const [name, fn] of steps) {
  if (!want(name)) continue
  process.stderr.write(`  ${name}… `)
  await fn(chrome)
  process.stderr.write('ok\n')
}
