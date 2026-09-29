#!/usr/bin/env node
// cm-chat: chat with / experiment on ChessMind models through NoteMate's in-browser product path (int8 ONNX,
// onnxruntime-web, KV cache) in ONE headless Chromium page, driven via the dev hook (src/chessmind/devHook.ts,
// window.__chessmind). No PyTorch, no model files touched outside the browser: safe to run on the Mac.
//
//   node scripts/cm-chat.mjs "Show me the Najdorf"                                  # default model, JSON out
//   node scripts/cm-chat.mjs --model v5-250m-s30k --moves "e4 c5 Nf3 d6" --think off --seed 3 --pretty "What now?"
//   node scripts/cm-chat.mjs --fen "8/8/8/4k3/8/8/4P3/4K3 w - - 0 1" --pretty "How do I win this?"
//   node scripts/cm-chat.mjs --history h.json --save-history h.json "No, the other one"   # multi-turn from a file
//   node scripts/cm-chat.mjs --repl --model v5-250m-s95k                              # interactive, keeps state
//   node scripts/cm-chat.mjs --predict --moves "e4 e5 Nf3"   |  --predict --fen F      # move chips (top moves)
//   node scripts/cm-chat.mjs --batch scripts/cm-battery.jsonl --models v5-250m-s95k,v5-250m-s30k --seeds 1 \
//        --out /tmp/run.jsonl                              # + /tmp/run.md (side-by-side summary)
//   node scripts/cm-chat.mjs --think-game chain.jsonl --model v5-250m-v6-s20k --keep both --out /tmp/chain.jsonl
//        # think-then-move along given games (teacher-forced) at consecutive own plies, with the earlier thinks in the
//        # prompt (--keep on), without (off) or both; items {id, moves: [uci...], plies: [...]} (ChessMind's
//        # scripts/think_chain_eval.py battery writes them and scores the output)
//   node scripts/cm-chat.mjs --summarize a.jsonl,b.jsonl [--summary out.md]          # markdown from results files
//   node scripts/cm-chat.mjs --daemon &                     # keep one browser + loaded model; later calls reuse it
//   node scripts/cm-chat.mjs --stop-daemon
//
// Other options: --temp T (0.8) --top-k K (50) --max-tokens N (512, the answer; the think comes on top) --max-think N (2560) --context auto|auto!|"<text>"
// --engine-context --tools on|force|off|engine,notes --notes '{"4":"my note on 2...Nc6"}' --about-position
// --timeout S (per answer, 300) --url http://localhost:4173 --no-host-start --build --full (raw parts) --no-daemon
// --headed. The host (npm run host: app :4173 + engine server :4174) is started in the background when not running
// (log: $TMPDIR/notemate-host.log) and left running for the next call. The served build must include the dev hook
// (`--build` runs `vite build` first). Browser profile (model cache): ~/.cache/notemate-cm-chat.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_PORT = Number(process.env.CM_CHAT_PORT ?? 4175);
const DEFAULT_MODEL = 'v5-250m-s95k';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    models: { type: 'string' },
    fen: { type: 'string' },
    moves: { type: 'string' },
    'about-position': { type: 'boolean' },
    think: { type: 'string' },
    seed: { type: 'string' },
    seeds: { type: 'string' },
    temp: { type: 'string' },
    'top-k': { type: 'string' },
    'max-tokens': { type: 'string' },
    'max-think': { type: 'string' },
    context: { type: 'string' },
    'engine-context': { type: 'boolean' },
    tools: { type: 'string' },
    notes: { type: 'string' },
    history: { type: 'string' },
    'save-history': { type: 'string' },
    repl: { type: 'boolean' },
    batch: { type: 'string' },
    only: { type: 'string' },
    out: { type: 'string' },
    summary: { type: 'string' },
    summarize: { type: 'string' },
    predict: { type: 'boolean' },
    'think-game': { type: 'string' },
    keep: { type: 'string' },
    top: { type: 'string' },
    pretty: { type: 'boolean' },
    full: { type: 'boolean' },
    timeout: { type: 'string' },
    url: { type: 'string' },
    'no-host-start': { type: 'boolean' },
    build: { type: 'boolean' },
    daemon: { type: 'boolean' },
    'stop-daemon': { type: 'boolean' },
    'no-daemon': { type: 'boolean' },
    headed: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (opt.help) {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const APP = (opt.url ?? 'http://localhost:4173').replace(/\/$/, '');
const log = (...a) => console.error('[cm-chat]', ...a);
const num = (v, d) => (v === undefined ? d : Number(v));

// ------------------------------------------------------------------------------------------------ host
async function ok(url, ms = 2000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureHost() {
  if (opt.build) {
    log('vite build …');
    execSync('npx vite build', { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (await ok(`${APP}/chessmind/models.json`)) return;
  if (opt['no-host-start']) throw new Error(`NoteMate is not served at ${APP} (npm run host)`);
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    log('no dist/: vite build …');
    execSync('npx vite build', { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const logFile = join(tmpdir(), 'notemate-host.log');
  log(`starting the host (node scripts/host.mjs, log ${logFile}) …`);
  const fd = openSync(logFile, 'a');
  spawn('node', ['scripts/host.mjs'], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] }).unref();
  for (let i = 0; i < 60; i++) {
    if (await ok(`${APP}/chessmind/models.json`)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the host did not come up (see ${logFile})`);
}

// --------------------------------------------------------------------------------------------- browser
async function chromium() {
  try {
    return (await import('playwright-core')).chromium;
  } catch {
    return (await import('playwright')).chromium;
  }
}

/** One headless page with the dev hook; `call(fn, arg)` runs window.__chessmind[fn](arg). */
async function openBrowser() {
  await ensureHost();
  const profile = join(homedir(), '.cache', 'notemate-cm-chat');
  mkdirSync(profile, { recursive: true });
  const ctx = await (await chromium()).launchPersistentContext(profile, { headless: !opt.headed, viewport: { width: 800, height: 600 } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => log('page error:', e.message));
  page.on('console', (m) => m.type() === 'error' && log('console:', m.text().slice(0, 300)));
  await page.goto(`${APP}/?dev=1`);
  try {
    await page.waitForFunction(() => !!window.__chessmind, null, { timeout: 30000 });
  } catch {
    await ctx.close();
    throw new Error('the served build has no dev hook (window.__chessmind): rebuild with --build (or npm run host)');
  }
  const call = (fn, arg) =>
    page.evaluate(
      async ([fn, arg]) => {
        try {
          return { ok: true, value: await window.__chessmind[fn](...(arg === undefined ? [] : [arg])) };
        } catch (e) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },
      [fn, arg],
    ).then((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.value;
    });
  const close = async () => {
    try {
      await page.evaluate(() => window.__chessmind?.unload());
    } catch {
      /* closing anyway */
    }
    await ctx.close();
  };
  return { call, close, remote: false };
}

async function daemonAlive() {
  return ok(`http://127.0.0.1:${DAEMON_PORT}/health`, 1000);
}

/** The daemon's browser when one is running (unless --no-daemon), else a browser of our own. */
async function session() {
  if (!opt['no-daemon'] && (await daemonAlive())) {
    const call = async (fn, arg) => {
      const r = await fetch(`http://127.0.0.1:${DAEMON_PORT}/call`, { method: 'POST', body: JSON.stringify({ fn, arg }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      return j.value;
    };
    return { call, close: async () => {}, remote: true };
  }
  return openBrowser();
}

async function ensureModel(s, model) {
  const cur = await s.call('current');
  if (cur.model === model) return null;
  log(`loading ${model} …`);
  const info = await s.call('loadModel', model);
  log(`${model} ready in ${(info.loadMs / 1000).toFixed(1)} s (${info.cached ? 'cached' : 'downloaded'}, ${info.backend}, ${info.threads ?? '?'} threads)`);
  return info;
}

// --------------------------------------------------------------------------------------------- options
function askOptions(extra = {}) {
  const o = {
    fen: opt.fen,
    moves: opt.moves,
    aboutPosition: opt['about-position'],
    think: opt.think,
    temperature: opt.temp !== undefined ? Number(opt.temp) : undefined,
    topK: opt['top-k'] !== undefined ? Number(opt['top-k']) : undefined,
    seed: opt.seed !== undefined ? Number(opt.seed) : undefined,
    maxTokens: opt['max-tokens'] !== undefined ? Number(opt['max-tokens']) : undefined,
    maxThinkTokens: opt['max-think'] !== undefined ? Number(opt['max-think']) : undefined,
    contextText: opt.context,
    engineContext: opt['engine-context'],
    tools: opt.tools ? (/,/.test(opt.tools) || !['on', 'off', 'force'].includes(opt.tools) ? opt.tools.split(',') : opt.tools) : undefined,
    notes: opt.notes ? JSON.parse(opt.notes) : undefined,
    timeoutMs: num(opt.timeout, 300) * 1000,
    ...extra,
  };
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** The result without the bulky fields (history, raw parts) unless --full. */
function slim(r, full = opt.full) {
  if (full) return r;
  const { history: _h, parts: _p, ...rest } = r;
  return rest;
}

// ---------------------------------------------------------------------------------------------- pretty
const C = process.stdout.isTTY ? { dim: '\x1b[2m', b: '\x1b[1m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', x: '\x1b[0m' } : { dim: '', b: '', y: '', r: '', c: '', x: '' };
function pretty(r) {
  const out = [];
  if (r.think) out.push(`${C.dim}think (${r.think.tokens} tok${r.think.open ? ', cut off' : ''}): ${r.think.text}${C.x}`);
  out.push(`${C.b}${r.answer || '(empty)'}${C.x}`);
  for (const l of r.lines) out.push(`${C.c}  line[${l.where}] ${l.san}  (${l.plies} plies, ${l.reason}${l.pEnd !== undefined ? ` p=${l.pEnd}` : ''}${l.finished ? `, ${l.finished}` : ''}${l.mark ? `, <${l.mark}>` : ''})${C.x}`);
  for (const t of r.tools) out.push(`${C.y}  tool[${t.where}] ${t.name}${t.line ? ` ${t.line}` : ''} -> ${t.result ?? '…'}${C.x}`);
  for (const f of r.flags) out.push(`${C.r}  flag[${f.where}] "${f.text.slice(0, 120)}": ${f.claim ?? f.evalNote}${C.x}`);
  out.push(`${C.dim}  ${r.model} seed=${r.seed ?? '-'} · ${r.tokens} tok · ${(r.ms / 1000).toFixed(1)} s · ${r.msPerToken} ms/tok · prefill ${r.prefillMs ?? '?'} ms · prompt ${r.promptTokens ?? '?'} tok · stop ${r.stop}${C.x}`);
  return out.join('\n');
}

// ------------------------------------------------------------------------------------------------ modes
async function single(s) {
  const prompt = positionals.join(' ').trim();
  const model = opt.model ?? DEFAULT_MODEL;
  await ensureModel(s, model);
  if (opt.predict) {
    const r = await s.call('predict', { fen: opt.fen, moves: opt.moves, top: num(opt.top, 5) });
    if (opt.pretty) console.log(`${r.model} · ${r.fen}\n` + r.moves.map((m) => `  ${m.san.padEnd(7)} ${(m.p * 100).toFixed(1).padStart(5)}%  ${m.uci}`).join('\n') + `\n  ${r.ms} ms`);
    else console.log(JSON.stringify(r));
    return;
  }
  if (!prompt) throw new Error('no question (or use --repl / --batch / --predict)');
  const history = opt.history && existsSync(opt.history) ? JSON.parse(readFileSync(opt.history, 'utf8')) : undefined;
  const r = await s.call('ask', askOptions({ prompt, history }));
  if (opt['save-history']) writeFileSync(opt['save-history'], JSON.stringify(r.history, null, 1));
  console.log(opt.pretty ? pretty(r) : JSON.stringify(slim(r)));
}

async function repl(s) {
  let model = opt.model ?? DEFAULT_MODEL;
  await ensureModel(s, model);
  let history = opt.history && existsSync(opt.history) ? JSON.parse(readFileSync(opt.history, 'utf8')) : [];
  const state = askOptions();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.b}you>${C.x} ` });
  console.log(`${C.dim}ChessMind REPL (${model}). /help for commands. Conversation state is kept between questions.${C.x}`);
  const help = `/model ID · /fen FEN|- · /moves "e4 c5 …"|- · /about on|off · /think auto|on|off · /seed N|- · /temp T · /tools on|off|force · /context auto|-|TEXT · /predict · /reset · /history · /save FILE · /json on|off · /quit`;
  let json = false;
  // A queue, not `for await`: piped input may close while an answer is still generating
  const queue = [];
  let closed = false;
  let wake = null;
  rl.on('line', (l) => (queue.push(l), wake?.()));
  rl.on('close', () => ((closed = true), wake?.()));
  const prompt = () => !closed && rl.prompt();
  prompt();
  for (;;) {
    if (!queue.length) {
      if (closed) break;
      await new Promise((r) => (wake = r));
      wake = null;
      continue;
    }
    const line = queue.shift().trim();
    if (!line) {
      prompt();
      continue;
    }
    try {
      if (line.startsWith('/')) {
        const [cmd, ...rest] = line.slice(1).split(' ');
        const arg = rest.join(' ').trim();
        const clear = arg === '-' || arg === '';
        if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') break;
        else if (cmd === 'help') console.log(help);
        else if (cmd === 'model') {
          model = arg;
          await ensureModel(s, model);
        } else if (cmd === 'fen') state.fen = clear ? undefined : arg;
        else if (cmd === 'moves') state.moves = clear ? undefined : arg.replace(/^"|"$/g, '');
        else if (cmd === 'about') state.aboutPosition = arg === 'on';
        else if (cmd === 'think') state.think = arg;
        else if (cmd === 'seed') state.seed = clear ? undefined : Number(arg);
        else if (cmd === 'temp') state.temperature = Number(arg);
        else if (cmd === 'tools') state.tools = arg;
        else if (cmd === 'context') state.contextText = clear ? undefined : arg;
        else if (cmd === 'json') json = arg !== 'off';
        else if (cmd === 'reset') {
          history = [];
          console.log('(conversation cleared)');
        } else if (cmd === 'history') console.log(JSON.stringify(history, null, 1));
        else if (cmd === 'save') {
          writeFileSync(arg, JSON.stringify(history, null, 1));
          console.log(`(saved ${history.length} turns to ${arg})`);
        } else if (cmd === 'predict') {
          const r = await s.call('predict', { fen: state.fen, moves: state.moves, top: 5 });
          console.log(r.moves.map((m) => `${m.san} ${(m.p * 100).toFixed(1)}%`).join(' · '));
        } else console.log(`unknown command. ${help}`);
      } else {
        const r = await s.call('ask', { ...state, prompt: line, history });
        history = r.history;
        console.log(json ? JSON.stringify(slim(r)) : pretty(r));
      }
    } catch (e) {
      console.log(`${C.r}error: ${e.message}${C.x}`);
    }
    prompt();
  }
  rl.close();
}

function memoryFree() {
  try {
    const m = /free percentage: (\d+)%/.exec(execSync('memory_pressure', { encoding: 'utf8', timeout: 10000 }));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function batch(s) {
  const items = readFileSync(opt.batch, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('#'))
    .map((l, i) => ({ id: `p${i + 1}`, ...JSON.parse(l) }))
    .filter((it) => !opt.only || new RegExp(opt.only).test(`${it.id} ${(it.tags ?? []).join(' ')}`));
  const models = (opt.models ?? opt.model ?? DEFAULT_MODEL).split(',').map((m) => m.trim()).filter(Boolean);
  const base = num(opt.seed, 1);
  const seeds = Array.from({ length: num(opt.seeds, 1) }, (_, i) => base + i);
  const out = opt.out ?? join(tmpdir(), `cm-batch-${Date.now()}.jsonl`);
  const summaryPath = opt.summary ?? out.replace(/\.jsonl?$/, '') + '.md';
  writeFileSync(out, '');
  const results = [];
  const mem = [];
  const common = askOptions();
  delete common.seed;
  log(`${items.length} prompts × ${models.length} models × ${seeds.length} seeds -> ${out}`);
  for (const model of models) {
    const info = await ensureModel(s, model);
    mem.push({ model, when: 'loaded', freePct: memoryFree(), loadMs: info?.loadMs });
    for (const it of items) {
      for (const seed of seeds) {
        const turns = it.turns ?? [it.prompt];
        let history = it.history ?? [];
        const answers = [];
        for (const prompt of turns) {
          const { id: _id, prompt: _p, turns: _t, tags: _tags, note: _n, expect: _e, ...rest } = it;
          let r;
          try {
            r = await s.call('ask', { ...common, ...rest, prompt, history, seed });
          } catch (e) {
            // record and go on (a later turn has no history to build on)
            r = { model, prompt, seed, think: null, answer: '', tokens: 0, ms: 0, msPerToken: 0, stop: `error: ${e.message}`, lines: [], tools: [], flags: [], history, error: e.message };
          }
          history = r.history;
          answers.push(slim(r, false));
          if (r.error) break;
        }
        const rec = { id: it.id, tags: it.tags ?? [], model, seed, ...(it.fen ? { fen: it.fen } : {}), ...(it.moves ? { moves: it.moves } : {}), ...(it.expect ? { expect: it.expect } : {}), turns: answers };
        results.push(rec);
        appendFileSync(out, JSON.stringify(rec) + '\n');
        const a = answers[answers.length - 1];
        log(`${model} ${it.id} s${seed}: ${a.tokens} tok ${(a.ms / 1000).toFixed(1)} s | ${a.answer.slice(0, 90).replace(/\n/g, ' ')}`);
      }
    }
    mem.push({ model, when: 'done', freePct: memoryFree() });
  }
  writeFileSync(summaryPath, summarize(results, mem));
  log(`results: ${out}\n[cm-chat] summary: ${summaryPath}`);
  console.log(JSON.stringify({ results: out, summary: summaryPath, n: results.length, memory: mem }));
}

const esc = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
/** Markdown summary of result records (any source with the cm-chat schema, e.g. ChessMind's chat_batch.py). */
function summarize(results, mem = []) {
  const uniq = (xs) => [...new Set(xs)];
  const models = uniq(results.map((r) => r.model));
  const seeds = uniq(results.map((r) => r.seed));
  const items = uniq(results.map((r) => r.id)).map((id) => {
    const r = results.find((x) => x.id === id);
    const prompts = r.turns.map((t) => t.prompt);
    return { id, tags: r.tags, fen: r.fen, moves: r.moves, expect: r.expect, ...(prompts.length > 1 ? { turns: prompts } : { prompt: prompts[0] }) };
  });
  const md = [`# cm-chat batch`, '', `${new Date().toISOString()} · models ${models.join(', ')} · seeds ${seeds.join(', ')} · ${items.length} prompts`, ''];
  // Per model aggregates
  md.push('| model | answers | mean s | ms/tok | thinks | mean think tok | lines (rule/threshold/model/open) | flagged answers | tool calls | stops |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const model of models) {
    const turns = results.filter((r) => r.model === model).flatMap((r) => r.turns);
    const n = turns.length || 1;
    const thinks = turns.filter((t) => t.think);
    const reasons = { rule: 0, threshold: 0, model: 0, open: 0 };
    for (const t of turns) for (const l of t.lines) reasons[l.reason] = (reasons[l.reason] ?? 0) + 1;
    const stops = {};
    for (const t of turns) stops[t.stop] = (stops[t.stop] ?? 0) + 1;
    md.push(
      `| ${model} | ${turns.length} | ${(turns.reduce((a, t) => a + t.ms, 0) / n / 1000).toFixed(1)} | ${(turns.reduce((a, t) => a + (t.msPerToken ?? 0), 0) / n).toFixed(0)} | ${thinks.length} | ${thinks.length ? Math.round(thinks.reduce((a, t) => a + t.think.tokens, 0) / thinks.length) : 0} | ${reasons.rule}/${reasons.threshold}/${reasons.model}/${reasons.open} | ${turns.filter((t) => t.flags.length).length} | ${turns.reduce((a, t) => a + t.tools.length, 0)} | ${Object.entries(stops).map(([k, v]) => `${k} ${v}`).join(', ')} |`,
    );
  }
  if (mem.length) md.push('', `Memory (system free %): ${mem.map((m) => `${m.model} ${m.when} ${m.freePct ?? '?'}%`).join(' · ')}`);
  md.push('');
  for (const it of items) {
    md.push(`## ${it.id}${it.tags?.length ? ` [${it.tags.join(', ')}]` : ''}`, '');
    const q = it.turns ?? [it.prompt];
    md.push(q.map((p, i) => `> ${q.length > 1 ? `(${i + 1}) ` : ''}${p}`).join('\n>\n'));
    const ctx = [it.fen && `fen \`${it.fen}\``, it.moves && `moves \`${it.moves}\``, it.think && `think ${it.think}`, it.tools && `tools ${it.tools}`, it.expect && `expect: ${it.expect}`].filter(Boolean);
    if (ctx.length) md.push('', ctx.join(' · '));
    md.push('', '| model | seed | turn | think | answer | lines | flags | tok · s |', '|---|---|---|---|---|---|---|---|');
    for (const r of results.filter((x) => x.id === it.id)) {
      r.turns.forEach((t, k) => {
        const think = t.think ? `${t.think.tokens} tok${t.think.open ? ' (cut)' : ''}` : '–';
        const lines = t.lines.map((l) => `${l.where === 'think' ? 'T:' : ''}${l.san} (${l.reason})`).join('<br>') || '–';
        const flags = t.flags.map((f) => (f.claim ? 'claim' : 'eval') + `: ${f.text.slice(0, 60)}`).join('<br>') || '–';
        const tools = t.tools.length ? `<br>tools: ${t.tools.map((x) => `${x.name} -> ${String(x.result ?? '').slice(0, 60)}`).join('; ')}` : '';
        md.push(`| ${r.model} | ${r.seed} | ${k + 1} | ${think} | ${esc(t.answer.slice(0, 400))}${esc(tools)} | ${esc(lines)} | ${esc(flags)} | ${t.tokens ?? '?'} · ${(t.ms / 1000).toFixed(1)} |`);
      });
    }
    md.push('');
  }
  return md.join('\n');
}

async function daemon() {
  if (await daemonAlive()) throw new Error(`a daemon is already running on :${DAEMON_PORT}`);
  const s = await openBrowser();
  if (opt.model) await ensureModel(s, opt.model);
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/health') return send(200, { ok: true });
    if (req.url === '/stop') {
      send(200, { ok: true });
      return shutdown();
    }
    if (req.url !== '/call' || req.method !== 'POST') return send(404, { ok: false, error: 'not found' });
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      // one request at a time on the page
      queue = queue.then(async () => {
        try {
          const { fn, arg } = JSON.parse(body);
          send(200, { ok: true, value: await s.call(fn, arg) });
        } catch (e) {
          send(200, { ok: false, error: String(e?.message ?? e) });
        }
      });
    });
  });
  const shutdown = async () => {
    server.close();
    await s.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.listen(DAEMON_PORT, '127.0.0.1', () => log(`daemon on http://127.0.0.1:${DAEMON_PORT} (stop: --stop-daemon)`));
}

// -------------------------------------------------------------------------------------------------- main
/** --think-game: every item at every --keep mode, one JSON line per (item, mode) in --out (or stdout). */
async function thinkGames(s) {
  const items = readFileSync(opt['think-game'], 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const modes = (opt.keep ?? 'on') === 'both' ? [true, false] : [(opt.keep ?? 'on') !== 'off'];
  const models = (opt.models ?? opt.model ?? DEFAULT_MODEL).split(',').map((m) => m.trim());
  if (opt.out) writeFileSync(opt.out, '');
  for (const model of models) {
    await ensureModel(s, model);
    for (const it of items) {
      for (const keep of modes) {
        const t0 = Date.now();
        let r;
        try {
          r = await s.call('thinkGame', { moves: it.moves, plies: it.plies, keep, seed: num(opt.seed, 1), temperature: num(opt.temp, 0),
            maxThinkTokens: opt['max-think'] ? num(opt['max-think'], 384) : undefined, timeoutMs: num(opt.timeout, 300) * 1000 });
        } catch (e) {
          r = { model, error: e.message, rows: [] };
        }
        const line = JSON.stringify({ id: it.id, model, keep, ...r, ms: Date.now() - t0 });
        if (opt.out) appendFileSync(opt.out, line + '\n');
        else console.log(line);
        log(`${model} ${it.id} keep=${keep}: ${r.rows?.length ?? 0} thinks in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
    }
  }
}

async function main() {
  if (opt['stop-daemon']) {
    const up = await daemonAlive();
    if (up) await fetch(`http://127.0.0.1:${DAEMON_PORT}/stop`).catch(() => undefined);
    console.log(up ? 'daemon stopped' : 'no daemon running');
    return;
  }
  if (opt.daemon) return daemon();
  if (opt.summarize) {
    // Summary of existing results (comma-separated JSONL files: e.g. a browser run + a PC fp32 run, side by side)
    const results = opt.summarize.split(',').flatMap((f) => readFileSync(f.trim(), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
    const md = summarize(results);
    if (opt.summary) writeFileSync(opt.summary, md);
    console.log(opt.summary ? JSON.stringify({ summary: opt.summary, n: results.length }) : md);
    return;
  }
  const s = await session();
  const stop = async () => {
    await s.close();
    process.exit(130);
  };
  process.on('SIGINT', stop);
  try {
    if (opt['think-game']) await thinkGames(s);
    else if (opt.batch) await batch(s);
    else if (opt.repl) await repl(s);
    else await single(s);
  } finally {
    await s.close();
  }
}

main().catch((e) => {
  log('error:', e.message);
  process.exit(1);
});
