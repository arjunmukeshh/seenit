// The hook fires on every write an agent makes, so the cases that matter most
// are the ones where it must stay silent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

import { extractWrite, reviewWrite } from '../lib/hook.js'
import { clearCache, syncShadow } from '../lib/shadow.js'

const execFile = promisify(execFileCb)

const ORIGINAL = `function calculateOrderTotal(items, taxRate) {
  let subtotal = 0
  for (const item of items) {
    subtotal += item.price * item.quantity
  }
  const discount = subtotal > 100 ? subtotal * 0.1 : 0
  const taxed = (subtotal - discount) * (1 + taxRate)
  const rounded = Math.round(taxed * 100) / 100
  return rounded
}
`

// Same function, every name and number changed, comments added.
const COPY = `// Work out what the basket costs once everything is applied.
function computeBasketSum(lines, vatFraction) {
  let running = 0
  for (const line of lines) {
    running += line.cost * line.count
  }
  const rebate = running > 250 ? running * 0.2 : 0
  const withVat = (running - rebate) * (1 + vatFraction)
  const finalValue = Math.round(withVat * 1000) / 1000
  const logged = finalValue
  console.log(logged)
  return finalValue
}
`

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-hook-'))
  await execFile('git', ['-C', dir, 'init', '-q'])
  await writeFile(join(dir, 'orders.js'), ORIGINAL)
  await execFile('git', ['-C', dir, 'add', '-A'])
  // Every test below assumes the hook is past the cold-cache warning, which
  // fires once and would otherwise be the first thing each one sees.
  await syncShadow(dir, ['orders.js'])
  return dir
}

// ------------------------------------------------------------------ payloads

test('only Write and Edit carry code', () => {
  assert.deepEqual(extractWrite({ tool_name: 'Write', tool_input: { file_path: 'a.js', content: 'x' } }), {
    path: 'a.js',
    content: 'x',
  })
  // Edit puts the new code in new_string, not content.
  assert.deepEqual(extractWrite({ tool_name: 'Edit', tool_input: { file_path: 'a.js', new_string: 'y' } }), {
    path: 'a.js',
    content: 'y',
  })
  for (const name of ['Read', 'Bash', 'Grep', undefined]) {
    assert.equal(extractWrite({ tool_name: name, tool_input: {} }), null)
  }
  assert.equal(extractWrite(null), null)
})

// -------------------------------------------------------------- staying quiet

test('short writes, non-source writes and empty writes say nothing', async () => {
  const dir = await repo()
  try {
    const quiet = [
      { path: 'a.js', content: 'const x = 1\n' }, // under the line threshold
      { path: 'package-lock.json', content: COPY }, // not source
      { path: 'notes.md', content: COPY },
      { path: 'a.js', content: '' },
      { path: '', content: COPY },
    ]
    for (const w of quiet) {
      assert.equal(await reviewWrite({ ...w, cwd: dir, minTokens: 20 }), null, `${w.path} must be silent`)
    }
  } finally {
    await clearCache(dir)
    await rm(dir, { recursive: true, force: true })
  }
})

test('genuinely new code says nothing', async () => {
  const dir = await repo()
  try {
    const novel = `export function slerp(a, b, t) {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  const theta = Math.acos(Math.min(1, Math.abs(dot)))
  const sinTheta = Math.sin(theta)
  if (sinTheta < 1e-6) return a
  const wa = Math.sin((1 - t) * theta) / sinTheta
  const wb = Math.sin(t * theta) / sinTheta
  const x = a.x * wa + b.x * wb
  const y = a.y * wa + b.y * wb
  const z = a.z * wa + b.z * wb
  return { x, y, z }
}
`
    assert.equal(await reviewWrite({ path: 'math.js', content: novel, cwd: dir, minTokens: 20 }), null)
  } finally {
    await clearCache(dir)
    await rm(dir, { recursive: true, force: true })
  }
})

// Editing a long function resends code that is already on disk. Without
// excluding the file being written, every such edit reports the function as a
// duplicate of itself — which would make the hook noise and get it turned off.
test('editing a file does not match that file against itself', async () => {
  const dir = await repo()
  try {
    const msg = await reviewWrite({ path: 'orders.js', content: ORIGINAL, cwd: dir, minTokens: 20 })
    assert.equal(msg, null, 'a file must not be reported as a duplicate of itself')
  } finally {
    await clearCache(dir)
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ speaking

test('a renamed copy of existing code is reported, with a location', async () => {
  const dir = await repo()
  try {
    const msg = await reviewWrite({ path: 'basket.js', content: COPY, cwd: dir, minTokens: 20 })
    assert.ok(msg, 'the copy must be reported')
    assert.match(msg, /orders\.js:\d+-\d+/, 'the message must name a file and line range')
    assert.doesNotMatch(msg, /basket\.js/, 'the file being written is not the answer')
  } finally {
    await clearCache(dir)
    await rm(dir, { recursive: true, force: true })
  }
})

// The quietest failure mode: an unprimed hook and a clean repository produce
// byte-identical silence. Someone installs the hook, sees nothing for a week,
// and concludes their code has no duplication.
test('an unprimed repository says so, once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-hook-'))
  try {
    await execFile('git', ['-C', dir, 'init', '-q'])
    await writeFile(join(dir, 'orders.js'), ORIGINAL)
    await execFile('git', ['-C', dir, 'add', '-A'])

    const first = await reviewWrite({ path: 'basket.js', content: COPY, cwd: dir, minTokens: 20 })
    assert.match(first ?? '', /not primed/, 'the first write must say the cache is cold')
    assert.match(first ?? '', /seenit prime/, 'and must say what to do about it')

    // Repeating it on every write is how a hook gets uninstalled.
    const second = await reviewWrite({ path: 'other.js', content: COPY, cwd: dir, minTokens: 20 })
    assert.equal(second, null, 'the warning must not repeat')
  } finally {
    await clearCache(dir)
    await rm(dir, { recursive: true, force: true })
  }
})
