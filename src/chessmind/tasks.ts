/*
 * Task markers (port of ChessMind chessmind/model/tasks.py, version 1): `<|evaluate|>` / `<|explain|>` open a user turn
 * to say what kind of answer it asks for -- a verdict on the position and why, or the ideas behind a move / line /
 * position (not an engine review). Input only: never trained, never generated (constraint.ts allow-lists).
 *
 * Sent only to models whose manifest has `task_markers >= 1` (worker.ts chat): the request's `task`, else the one its
 * wording asks for (taskOfQuestion: the training rule, question_intent `eval` -> evaluate, an explicit explain request
 * -> explain, never a judgement of a played move or a move / tactic request).
 *
 * The regex sources below are ChessMind's (chessmind/data/think_intent.py INTENTS / CHESS_WORDS / SAN_RE and
 * chessmind/model/tasks.py EXPLAIN_RE / JUDGE_RE / FIND_RE), copied verbatim; scripts/test-tasks.mjs checks them and
 * the classifications against fixtures/tasks.json (ChessMind scripts/tasks_fixture.py).
 */

export const TASK_MARKERS_VERSION = 1;
export const TASKS = ['evaluate', 'explain'] as const;
export type ChatTask = (typeof TASKS)[number];

/** question_intent's intents in order (first match wins), Python sources (re.I). */
export const INTENT_SOURCES: [string, string][] = [
  ["mate", "\\b(?:check)?mate\\b|\\bmating\\b|\\bmate in\\b|#\\d"],
  ["king_safety", "\\bking\\b.*\\b(?:safe|safety|exposed|danger|shelter|weak)|\\b(?:safe|safety)\\b.*\\bking\\b"],
  ["rules", "\\bcan (?:white|black|i|he|she|they|you) (?:still )?castle|\\bcastl\\w+ (?:rights|legal|allowed)|\\ben passant\\b|\\bis (?:this|that|it) (?:legal|stalemate)|\\brules?\\b|\\ballowed to\\b|\\bpromot\\w+\\b.*\\?"],
  ["threats", "\\bhanging\\b|\\bunder attack\\b|\\bthreat\\w*\\b|\\battacked\\b|\\bloose\\b|\\ben prise\\b|\\bin danger\\b"],
  ["material", "\\bmaterial\\b|\\bwho(?:'s| is) up\\b|\\bcount the (?:pieces|material)\\b|\\bpieces? (?:up|down)\\b"],
  ["last_move", "\\blast move\\b|\\bwhy did (?:white|black|he|she|they|my opponent) play\\b|\\bexplain (?:the|that|this) move\\b|\\bwhat (?:did|does) (?:the )?(?:last|previous) move\\b|\\bjust played\\b"],
  ["compare", "\\bcompare\\b|\\bwhich is (?:better|stronger)\\b|\\bas good as\\b|(?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?\\s+or\\s+(?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?|\\bversus\\b|\\bvs\\.?\\b"],
  ["mistake", "\\bwhat does (?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]? allow\\b|\\bis (?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]? (?:ok|okay|good|bad|a mistake|playable|any good|sound)\\b|\\bwhy (?:is|was) .* (?:bad|a mistake|wrong)\\b|\\bmistake\\b|\\bblunder\\b|\\bthinking about\\b"],
  ["plan", "\\bplan\\b|\\baim(?:ing)? (?:for|at)\\b|\\bidea\\b|\\bstrategy\\b|\\bwhat's going on\\b|\\bwhat is going on\\b|\\bmake progress\\b|\\blong[- ]term\\b|\\bhow (?:does|can|do|should) (?:white|black|i|we) (?:win|convert|make progress)\\b"],
  ["eval", "\\beval\\w*\\b|\\bassess\\w*\\b|\\bwho(?:'s| is) (?:better|winning)\\b|\\bis (?:this|it) (?:a )?(?:draw|won|lost|winning|equal)\\b|\\bcan (?:someone|anyone|either side) win\\b|\\bverdict\\b"],
  ["opening", "\\bopening\\b|\\bvariation\\b|\\bdefen[cs]e\\b|\\bgambit\\b|\\bsicilian\\b|\\bfrench\\b|\\bcaro\\b|\\bruy\\b|\\bindian\\b|\\bslav\\b|\\bqueen's gambit\\b|\\bline is this\\b"],
  ["review", "\\banaly[sz]e my game\\b|\\breview\\b|\\bwhere did i go wrong\\b|\\bcritical moments?\\b"],
  ["best", "\\bbest\\b|\\bstrongest\\b|\\bwhat should\\b|\\bwhat would you play\\b|\\bwhat now\\b|\\bwhat next\\b|\\bmy move\\b|\\byour move\\b|\\bfind (?:a|the) move\\b|\\bwhich move\\b|\\bmove for\\b|\\bwhat do i play\\b|\\bhelp me find\\b|\\band now\\b|\\bto move\\b"],
  ["continuation", "\\bcontinu\\w+\\b|\\bshow me how\\b|\\bwhat comes next\\b|\\bhow does (?:it|this) go\\b"],
];
export const CHESS_WORDS_SOURCE = "\\b(?:chess|move|moves|play|played|playing|mate|checkmate|check|castle|castling|king|queen|rook|bishop|knight|pawns?|pieces?|position|board|white|black|opening|endgame|middlegame|gambit|defen[cs]e|variation|attack|threat|hanging|material|eval\\w*|winning|draw|stalemate|en passant|promot\\w*|tactic\\w*|plan|best|blunder|mistake|squares?|files?|ranks?|diagonals?|fork|pin|skewer|sacrifice|trade|exchange|elo|rating|engine|stockfish|win|wins|won|lose|lost|ending|here|this position|continuation|variation|line)\\b";
/** Case-sensitive in Python (SAN_RE has no re.I). */
export const SAN_SOURCE = "(?<![\\w.])(?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?(?![\\w])";
export const EXPLAIN_SOURCE = "\\bexplain\\w*\\b|\\bdescribe the (?:last )?move\\b|\\bwhat(?:'s| is| was) the (?:idea|point|purpose|reasoning)\\b|\\breasoning behind\\b|\\bhow should I understand\\b|\\bcomment on\\b|\\bwhy\\s+(?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?\\s*[?!]|\\bwhy (?:did|does|was|is|would) .{0,50}?\\b(?:play(?:ed)?|go for|choose|chosen)\\b|\\bwhat (?:does|did) (?:(?:white's|black's|the|my opponent's) )?(?:last move|(?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?)(?: (?:do|attack|go after|threaten|aim at|prepare))\\b|\\b(?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?\\s*(?:--|-|:)\\s*what's the (?:idea|purpose|point)\\b";
export const JUDGE_SOURCE = "\\b(?:I|he|she|they|white|black) (?:just )?(?:played|went|chose)\\b|\\bmy (?:last )?move\\b|\\blast move (?:was|:)|\\blast move\\s*:|\\bhow (?:good|bad) (?:was|is) (?:it|that)\\b|\\bverdict\\b.*\\b(?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?|(?:\\d{1,3}\\.(?:\\.\\.)?\\s*)?(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?.*\\bverdict\\b|\\bdid I mess up\\b|\\brate it\\b";
export const FIND_SOURCE = "\\bfind\\b|\\btactic\\b|\\bbest move\\b|\\bsolution\\b|\\bpunish\\b|\\bwhat should\\b|\\bwhat do I play\\b";
/** Intents that win over an explain wording (tasks.NOT_EXPLAIN). */
export const NOT_EXPLAIN = ["mate", "rules", "mistake", "compare", "threats", "material", "king_safety", "off_topic"];

const INTENTS = INTENT_SOURCES.map(([n, s]) => [n, new RegExp(s, 'i')] as const);
const CHESS_WORDS = new RegExp(CHESS_WORDS_SOURCE, 'i');
const SAN = new RegExp(SAN_SOURCE);
const EXPLAIN = new RegExp(EXPLAIN_SOURCE, 'i');
const JUDGE = new RegExp(JUDGE_SOURCE, 'i');
const FIND = new RegExp(FIND_SOURCE, 'i');

/** The question without the ctx1 blocks (think_intent._strip_blocks). */
export function stripBlocks(text: string): string {
  return text.replace(/\[[A-Z][a-z]+:[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
}

/** think_intent.question_intent: the intent name, 'off_topic' (no chess vocabulary) or 'other'. */
export function questionIntent(text: string): string {
  const q = stripBlocks(text);
  for (const [name, rx] of INTENTS) if (rx.test(q)) return name;
  if (!CHESS_WORDS.test(q) && !SAN.test(q)) return 'off_topic';
  return 'other';
}

/** tasks.task_of_question: 'evaluate' / 'explain' / null for a user question (ctx1 blocks ignored). */
export function taskOfQuestion(text: string): ChatTask | null {
  const q = stripBlocks(text ?? '');
  const intent = questionIntent(q);
  if (JUDGE.test(q) || FIND.test(q)) return null;
  if (intent === 'eval') return 'evaluate';
  if (!NOT_EXPLAIN.includes(intent) && EXPLAIN.test(q)) return 'explain';
  return null;
}

/** The prompt turns with `task` first in the LAST user turn (tasks.with_task; one it had is replaced). */
export function withTask<T extends { role: string; parts: { kind: string }[] }>(turns: T[], task: ChatTask | null): T[] {
  if (!task) return turns;
  let i = turns.length - 1;
  while (i >= 0 && turns[i].role !== 'user') i--;
  if (i < 0) return turns;
  const parts = turns[i].parts.filter((p, k) => !(k === 0 && p.kind === 'task'));
  const out = [...turns];
  out[i] = { ...turns[i], parts: [{ kind: 'task', task }, ...parts] };
  return out;
}
