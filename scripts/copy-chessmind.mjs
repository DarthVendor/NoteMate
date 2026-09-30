// Copies exported ChessMind models (ChessMind's scripts/export_onnx.py output) into public/chessmind/<name>/
// and writes public/chessmind/models.json, so the app (npm run host / dev / build) serves them from its own origin.
// Source: $CHESSMIND_EXPORT (default ../ChessMind/export/onnx). Pick models with CHESSMIND_MODELS=a,b (default: all).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const src = resolve(process.env.CHESSMIND_EXPORT ?? '../ChessMind/export/onnx');
const dest = 'public/chessmind';
// Listed first = default in the app's model selector.
const CONTEXT_BLOCKS = new Set([]);
const ORDER = ['v5-250m-v6-s235k', 'v5-250m-v6-s200k', 'v5-250m-v6-s150k', 'v5-250m-v6-s75k', 'v5-250m-v6-s45k', 'v5-250m-v6-s20k', 'v5-250m-v6-s10k', 'v5-250m-s95k', 'v5-250m-s30k', 'v5-250m-s20k', 'restart-v3-250m-s90k', 'restart-v3-250m-s50k', 'medium-100m-live-vast', 'exp-small-board', 'exp-small'];
const DESCRIPTIONS = {
  'v5-250m-v6-s235k': 'v6 run, step 235,000 (~4.8B of 5.1B tokens). Since 200k: board re-injection right before the final block (board_inject_last), guard-duty / removing-the-defender drills, castling-legality traps (rights forfeited + through/into/out of check), x-ray drill scale-up + an endgame quiet-move phase-balance fix, sacrifice drills (sound vs. unsound, with compensation type), stalemate drills (recognition, avoid-the-trap, escape-via-stalemate), illegal-move-in-prose catching past a verified line, positional move-rationale facts (outpost / activity / restriction) in game-think candidates. int8, KV cache.',
  'v5-250m-v6-s200k': 'v6 run, step 200,000 (~4.1B of 5.1B tokens). All fixes as of 2026-09-29: eval-number masking (not fabrication), torch.compile, positional board-head targets, positional pairs/quiet-move puzzles, opening-QA v2, repetition filters, role/task-marker tokens, grounding-drills (identity honesty + consistency + tool-call training scaled), material-imbalance narration, scaled chain-chat, scaled general-English + math/stem thinks, hanging-piece drills. int8, KV cache.',
  'v5-250m-v6-s150k': 'v6 run, step 150,000 (~3.07B of 5.1B tokens). Since 100k: prompt roles (<|system|> / <|context|> / <|goal|> / <|plan|>), evaluate / explain markers, positional board-head targets, positional pairs and quiet-move puzzles, opening-QA v2 and repetition filters; torch.compile. int8, KV cache.',
  'v5-250m-v6-s75k': 'v6 run, step 75,000 (~1.54B of 5.1B tokens). 30k steps on the 45k update: chained thinks with plans, thinks that start from the request, puzzle phrasings and long mates, theory sentences, perspective drills, data cleaning. int8, KV cache.',
  'v5-250m-v6-s45k': 'v6 run, step 45,000 (~920M of 5.1B tokens). Trained through the 35k-44k data (Q&A, theory transcripts, rebuilt theory thinks, intent / perspective Q&A live from Mongo); the 45k code update (chained thinks, request-aware thinks, puzzle phrasings, cleaning) starts after this step. int8, KV cache.',
  'v5-250m-v6-s20k': 'v6 restart, step 20,000 (~410M of 5.1B tokens). Same recipe as 10k plus the 10k update (Q&A weights, chat pool, Usenet removed). int8, KV cache.',
  'v5-250m-v6-s10k': 'v6 restart, step 10,000 (~205M of 5.1B tokens). 268M: board input shows the position under discussion, move number / castling / feature planes in the board embedding, board-fact head; prompt blocks, tools, rewind, drills, new puzzles, think-then-move. Early checkpoint. int8, KV cache.',
  'v5-250m-s95k': 'v5 run, step 95,000 (~1.95B of 5.1B tokens). 255M, 2,560 context, hidden reasoning, line markers. Same data recipe as 30k plus openings / puzzles in the games group (35k) and the data-loader fix (40k). Large download (275 MB). int8, KV cache.',
  'v5-250m-s30k': 'v5 run, step 30,000 (~615M of 5.1B tokens), after the transcript boost. 255M, 2,560 context, hidden reasoning, branch / check / draw / mate line markers (tokenizer v4). Large download (275 MB). int8, KV cache.',
  'v5-250m-s20k': 'v5 run, step 20,000 (early: ~410M of 5.1B tokens). 255M, 2,560 context, hidden reasoning (tokenizer v4), trained on games + chess English + general English. Large download (275 MB). int8, KV cache.',
  'restart-v3-250m-s90k': '255M parameters, board embedding, tokenizer v3, step 90,000 of the restart run. Best so far: 43% top-1 (45% among legal moves), CPL 56, and reads written moves into lines (51/60). Large download (275 MB). int8.',
  'restart-v3-250m-s50k': '255M parameters, board embedding, tokenizer v3, step 50,000 of the restart run. Best chess model so far (44% top-1, 99% legal). Large download (275 MB). int8.',
  'medium-100m-live-vast': '105M parameters (d_model 1024), trained live on games, commentary and dialogues. int8.',
  'exp-small': '31M parameter development model (d_model 512). Loads fast. int8.',
  'exp-small-board': '31M parameters with the learned board embedding: sees the current position directly (short move context works). int8.',
};

if (!existsSync(src)) {
  console.log(`chessmind: no exports at ${src} (set CHESSMIND_EXPORT); keeping ${dest} as is`);
  process.exit(0);
}
const wanted = process.env.CHESSMIND_MODELS?.split(',').map((s) => s.trim()).filter(Boolean);
const names = readdirSync(src)
  .filter((n) => existsSync(join(src, n, 'model.json')))
  .filter((n) => !wanted || wanted.includes(n))
  .sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));

mkdirSync(dest, { recursive: true });
const models = [];
let copied = 0;
for (const name of names) {
  const from = join(src, name);
  const to = join(dest, name);
  const manifest = JSON.parse(readFileSync(join(from, 'model.json'), 'utf8'));
  const files = ['model.json', manifest.files.parts, manifest.files.chess_vocab, ...manifest.chunks.parts];
  if (existsSync(join(from, manifest.files.tokenizer))) files.push(manifest.files.tokenizer);
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(to)) if (!files.includes(f)) rmSync(join(to, f)); // stale parts of an older export
  for (const f of files) {
    const a = join(from, f);
    const b = join(to, f);
    if (existsSync(b) && statSync(b).size === statSync(a).size && statSync(b).mtimeMs >= statSync(a).mtimeMs) continue;
    copyFileSync(a, b);
    copied++;
  }
  models.push({
    id: name,
    name: manifest.name ?? name,
    params: manifest.params,
    sizeMb: Math.round(manifest.chunks.size / 1e6),
    step: manifest.step ?? null,
    hasText: files.includes(manifest.files.tokenizer),
    boards: !!manifest.boards,
    // trained on the ctx1 prompt blocks: the manifest says so, or the model is listed here (v5 checkpoints are not)
    contextBlocks: !!manifest.context_blocks || CONTEXT_BLOCKS.has(name),
    description: DESCRIPTIONS[name] ?? `${(manifest.params / 1e6).toFixed(0)}M parameters, ${manifest.quant}.`,
  });
}
for (const d of readdirSync(dest)) {
  if (d !== 'models.json' && !names.includes(d)) rmSync(join(dest, d), { recursive: true, force: true });
}
writeFileSync(join(dest, 'models.json'), JSON.stringify(models, null, 1));
console.log(`chessmind: ${models.length} model(s) [${names.join(', ')}], ${copied} file(s) copied to ${dest}`);
