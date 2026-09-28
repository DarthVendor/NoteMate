/*
 * Checkable board-fact claims in English text and their verification against positions: the twin of ChessMind's
 * chessmind/data/claims.py (checked against fixtures/claims.json by scripts/test-context.mjs).
 *
 * A claim is extracted by a regex over one sentence ("Black has doubled pawns on the f-file", "the knight on e5 is
 * hanging", "Material is level", ...) and decided on a board: material in points (P1 N3 B3 R5 Q9), king shelter = own
 * pawns one or two ranks in front on the king's and the adjacent files, mobility = pseudo-legal knight / bishop / rook
 * / queen moves, loose = attacked and undefended or attacked by a cheaper piece (absolute pins respected). verify()
 * decides on the position under discussion first, then on the other positions the dialogue shows: 'true' (holds at
 * the root), 'shifted' (holds at a shown position: text about a line's position), 'false' (holds nowhere), 'unknown'.
 * evalCitations() finds engine-style numbers ("+0.4", "Evaluation: -1.2", "#3").
 *
 * Squares are python-chess indices (a1 = 0, b1 = 1, ..., h8 = 63); colors are booleans (true = White), as there.
 */

export type ClaimKind = 'material' | 'doubled' | 'isolated' | 'passed' | 'piece_on' | 'check' | 'shield' | 'bishops' | 'to_move' | 'mobility' | 'hanging' | 'open_file';
export type Verdict = 'true' | 'shifted' | 'false' | 'unknown';
type Color = boolean;
type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

export interface Claim {
  kind: ClaimKind;
  /** The matched span. */
  text: string;
  sentence: string;
  /** true = White, false = Black, null = either. */
  side: Color | null;
  args: (string | number | null)[];
  negated: boolean;
}

export interface ClaimVerdict {
  claim: Claim;
  verdict: Verdict;
}

// ------------------------------------------------------------------------------------------------------ board
const WHITE = true;
const BLACK = false;
const FILE_NAMES = 'abcdefgh';
const sqFile = (s: number) => s & 7;
const sqRank = (s: number) => s >> 3;
const square = (f: number, r: number) => r * 8 + f;
const parseSquare = (name: string) => square(FILE_NAMES.indexOf(name[0]), Number(name[1]) - 1);

const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export interface Piece {
  type: PieceType;
  color: Color;
}

/** Just enough of a chess position for the claims: pieces, side to move, attacks, pins. */
export class Board {
  readonly pieces: (Piece | null)[] = new Array(64).fill(null);
  turn: Color;

  constructor(fen: string) {
    const [placement, turn] = fen.trim().split(/\s+/);
    let r = 7;
    let f = 0;
    for (const ch of placement) {
      if (ch === '/') {
        r--;
        f = 0;
      } else if (/\d/.test(ch)) f += Number(ch);
      else {
        const lower = ch.toLowerCase();
        if (!'pnbrqk'.includes(lower) || f > 7 || r < 0) throw new Error(`bad FEN: ${fen}`);
        this.pieces[square(f, r)] = { type: lower as PieceType, color: ch !== lower };
        f++;
      }
    }
    this.turn = turn !== 'b';
  }

  at(s: number): Piece | null {
    return this.pieces[s];
  }

  squares(type: PieceType, color: Color): number[] {
    const out: number[] = [];
    this.pieces.forEach((p, s) => {
      if (p && p.type === type && p.color === color) out.push(s);
    });
    return out;
  }

  /** The king square (the highest one, as python-chess msb), or null. */
  king(color: Color): number | null {
    const ks = this.squares('k', color);
    return ks.length ? ks[ks.length - 1] : null;
  }

  /** Squares the piece on `s` attacks (sliders stop at the first piece, which is included). */
  attacks(s: number): number[] {
    const p = this.pieces[s];
    if (!p) return [];
    const f0 = sqFile(s);
    const r0 = sqRank(s);
    const out: number[] = [];
    const step = (dirs: number[][], slide: boolean) => {
      for (const [df, dr] of dirs) {
        let f = f0 + df;
        let r = r0 + dr;
        while (f >= 0 && f < 8 && r >= 0 && r < 8) {
          out.push(square(f, r));
          if (!slide || this.pieces[square(f, r)]) break;
          f += df;
          r += dr;
        }
      }
    };
    if (p.type === 'p') step(p.color === WHITE ? [[1, 1], [-1, 1]] : [[1, -1], [-1, -1]], false);
    else if (p.type === 'n') step(KNIGHT_D, false);
    else if (p.type === 'k') step(KING_D, false);
    else if (p.type === 'b') step(BISHOP_D, true);
    else if (p.type === 'r') step(ROOK_D, true);
    else step([...ROOK_D, ...BISHOP_D], true);
    return out;
  }

  /** `color`'s pieces attacking `target`. */
  attackers(color: Color, target: number): number[] {
    const out: number[] = [];
    this.pieces.forEach((p, s) => {
      if (p && p.color === color && s !== target && this.attacks(s).includes(target)) out.push(s);
    });
    return out;
  }

  /** python-chess pin_mask: the whole line through `color`'s king and the pinning slider when the piece on `s` is
   * pinned to its king, else null (not pinned). */
  pin(color: Color, s: number): Set<number> | null {
    const k = this.king(color);
    if (k === null) return null;
    const kf = sqFile(k);
    const kr = sqRank(k);
    const sf = sqFile(s);
    const sr = sqRank(s);
    const groups: { on: boolean; dirs: number[][]; sliders: PieceType[] }[] = [
      { on: sf === kf && s !== k, dirs: [[0, 1], [0, -1]], sliders: ['r', 'q'] },
      { on: sr === kr && s !== k, dirs: [[1, 0], [-1, 0]], sliders: ['r', 'q'] },
      { on: s !== k && Math.abs(sf - kf) === Math.abs(sr - kr), dirs: BISHOP_D, sliders: ['b', 'q'] },
    ];
    for (const g of groups) {
      if (!g.on) continue;
      // the slider beyond `s` on the same ray, with nothing but `s` in between
      for (const [df, dr] of g.dirs) {
        let f = kf + df;
        let r = kr + dr;
        let seen = false;
        while (f >= 0 && f < 8 && r >= 0 && r < 8) {
          const q = square(f, r);
          if (q === s) seen = true;
          else {
            const p = this.pieces[q];
            if (p) {
              if (seen && p.color !== color && g.sliders.includes(p.type)) {
                const line = new Set<number>();
                for (const sign of [1, -1]) {
                  let lf = kf;
                  let lr = kr;
                  while (lf >= 0 && lf < 8 && lr >= 0 && lr < 8) {
                    line.add(square(lf, lr));
                    lf += df * sign;
                    lr += dr * sign;
                  }
                }
                return line;
              }
              break;
            }
          }
          f += df;
          r += dr;
        }
      }
      return null;
    }
    return null;
  }

  isCheck(): boolean {
    const k = this.king(this.turn);
    return k !== null && this.attackers(!this.turn, k).length > 0;
  }
}

// ------------------------------------------------------------------------------------------------ board facts
const VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const RANK_VALUES: Record<PieceType, number> = { ...VALUES, k: 100 };
const PIECES: Record<string, PieceType> = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };

export function materialPoints(b: Board, color: Color): number {
  return b.pieces.reduce((n, p) => n + (p && p.color === color ? VALUES[p.type] : 0), 0);
}

export function materialBalance(b: Board): number {
  return materialPoints(b, WHITE) - materialPoints(b, BLACK);
}

const pawnFiles = (b: Board, color: Color) => b.squares('p', color).map(sqFile);

export function doubledFiles(b: Board, color: Color): Set<number> {
  const files = pawnFiles(b, color);
  return new Set(files.filter((f) => files.filter((x) => x === f).length > 1));
}

export function isolatedSquares(b: Board, color: Color): Set<number> {
  const files = new Set(pawnFiles(b, color));
  return new Set(b.squares('p', color).filter((s) => ![...files].some((f) => Math.abs(sqFile(s) - f) === 1)));
}

export function passedSquares(b: Board, color: Color): Set<number> {
  const enemy = new Set(b.squares('p', !color));
  const out = new Set<number>();
  for (const s of b.squares('p', color)) {
    const f = sqFile(s);
    const r = sqRank(s);
    let blocked = false;
    for (let ff = f - 1; ff <= f + 1; ff++) {
      if (ff < 0 || ff > 7) continue;
      for (let rr = color === WHITE ? r + 1 : 0; color === WHITE ? rr < 8 : rr < r; rr++) if (enemy.has(square(ff, rr))) blocked = true;
    }
    if (!blocked) out.add(s);
  }
  return out;
}

export function kingShelter(b: Board, color: Color): number {
  const k = b.king(color);
  if (k === null) return 0;
  const kf = sqFile(k);
  const kr = sqRank(k);
  const step = color === WHITE ? 1 : -1;
  const pawns = new Set(b.squares('p', color));
  let n = 0;
  for (const f of [kf - 1, kf, kf + 1])
    for (const d of [1, 2]) {
      const r = kr + step * d;
      if (f >= 0 && f < 8 && r >= 0 && r < 8 && pawns.has(square(f, r))) n++;
    }
  return n;
}

/** Pseudo-legal knight / bishop / rook / queen moves of `color` (whoever is to move). */
export function mobility(b: Board, color: Color): number {
  let n = 0;
  b.pieces.forEach((p, s) => {
    if (!p || p.color !== color || p.type === 'p' || p.type === 'k') return;
    for (const t of b.attacks(s)) if (b.at(t)?.color !== color) n++;
  });
  return n;
}

function effectiveAttackers(b: Board, color: Color, target: number): number[] {
  return b.attackers(color, target).filter((a) => {
    const pin = b.pin(color, a);
    if (pin && !pin.has(target)) return false;
    if (b.at(a)!.type === 'k' && b.attackers(!color, target).length) return false;
    return true;
  });
}

function defenders(b: Board, target: number): number[] {
  const p = b.at(target);
  if (!p) return [];
  const enemy = effectiveAttackers(b, !p.color, target);
  return b.attackers(p.color, target).filter((a) => {
    const pin = b.pin(p.color, a);
    if (pin && !pin.has(target)) return false;
    if (b.at(a)!.type === 'k' && enemy.length > 1) return false;
    return true;
  });
}

/** `color`'s non-king pieces attacked and undefended, or attacked by a cheaper piece. */
export function looseSquares(b: Board, color: Color): Set<number> {
  const out = new Set<number>();
  b.pieces.forEach((p, s) => {
    if (!p || p.color !== color || p.type === 'k') return;
    const atk = effectiveAttackers(b, !color, s);
    if (!atk.length) return;
    const cheapest = Math.min(...atk.map((a) => RANK_VALUES[b.at(a)!.type]));
    if (!defenders(b, s).length || cheapest < VALUES[p.type]) out.add(s);
  });
  return out;
}

/** [White has a pawn on file f, Black has one]. */
function fileState(b: Board, f: number): [boolean, boolean] {
  return [b.squares('p', WHITE).some((s) => sqFile(s) === f), b.squares('p', BLACK).some((s) => sqFile(s) === f)];
}

// ------------------------------------------------------------------------------------------------ extraction
const SIDE = '(White|Black)';
const SQ = '([a-h][1-8])';
const FILE = '([a-h])';
const NEG = /\b(?:no|not|never|nor|n't|without|neither|nothing|none)\b/i;
const COUNT = '(a|an|one|two|three|four|five|six|seven|eight|nine|\\d+)';
const UNIT = '(minor pieces?|pieces?|pawns?|knights?|bishops?|rooks?|queens?|(?:the )?exchange|points? of material|points?)';
const ITEM =
  '(?:(?:a|an|one|two|three|four|five|six|seven|eight|nine|\\d+) (?:minor pieces?|pieces?|pawns?|knights?|bishops?|' +
  'rooks?|queens?|exchange|points? of material|points?)|the exchange)';
const AMOUNT = `(${ITEM}(?:(?:, and |, | and )${ITEM})*)`;
const ITEM_RE = new RegExp(`${COUNT} ${UNIT}|(the exchange)`, 'gi');

const rx = (s: string) => new RegExp(s, 'gi');
const MATERIAL_UP = rx(`\\b${SIDE} (?:is|was|stays|remains) (?:still |now |already |just |only )?(up|down) ${AMOUNT}`);
const MATERIAL_UP2 = rx(`\\b${SIDE} (?:is|was|stays|remains) (?:still |now |already |just |only )?${AMOUNT} (up|down|ahead|behind)\\b`);
const MATERIAL_EXTRA = rx(`\\b${SIDE} has (?:an extra|${COUNT} extra) (pawns?|pieces?|knights?|bishops?|rooks?|queens?)`);
const MATERIAL_AHEAD = rx(`\\b${SIDE} (?:is|was) (ahead|behind|up|down) (?:in|on) material\\b|\\b${SIDE} has more material\\b`);
const MATERIAL_EQUAL = rx(
  '\\b(?:the )?material (?:is|stays|remains) (?:level|even|equal|balanced)\\b|\\bnobody is up material\\b|' +
    '\\bmaterial is level in points\\b|\\blevel in points\\b|\\bequal material\\b|\\bmaterial is equal\\b',
);
const MATERIAL_POINTS = rx(`\\b(\\d+) points? in ${SIDE}'s favou?r`);

const DOUBLED = [
  rx(`\\b${SIDE} has (?:a pair of |two )?doubled pawns?(?: on the ${FILE}-file)?`),
  rx(`\\b${SIDE}'s doubled ${FILE}-pawns`),
  rx(`\\b${SIDE}'s doubled pawns(?: on the ${FILE}-file)?`),
  rx(`\\bdoubled pawns on the ${FILE}-file`),
  rx(`\\bdoubled ${FILE}-pawns`),
];
const ISOLATED = [
  rx(`\\b${SIDE} has (?:an|one|two|three) isolated pawns?(?: on ${SQ})?`),
  rx(`\\b(?:(White|Black)'s |an |the )?isolated pawn on ${SQ}`),
  rx(`\\b(?:(White|Black)'s |an |the )?isolated ${FILE}-pawn`),
];
const PASSED = [
  rx(`\\b${SIDE} has (?:a |an |two |three )?(?:protected |connected |outside |far-advanced )?pass(?:ed pawns?|ers?)(?: on ${SQ}((?:(?:, | and )${SQ})*))?`),
  rx(`\\b(?:(White|Black)'s |a |an |the )?(?:protected |connected |outside )?(?:passed pawns?|passers?) on ${SQ}((?:(?:, | and )${SQ})*)`),
  rx(`\\b(?:(White|Black)'s |a |an |the )?passed ${FILE}-pawn`),
];
const PIECE_ON = rx(`\\b(?:(White|Black)'s |the |a |an |his |her |its |their )?(king|queen|rook|bishop|knight|pawn)(s?) on ${SQ}((?:(?:, | and | or )${SQ})*)`);
const CHECK = rx(`\\b${SIDE}(?:'s king)? is (?:in check|checked)\\b|\\bthe (White|Black) king is in check\\b`);
const SHIELD = rx(
  `\\b${SIDE}'s king(?: on ${SQ})? has (no pawns|only one pawn|just one pawn|one pawn|only two pawns|two pawns|` + `three pawns|four pawns|\\d+ pawns?) in front of it`,
);
const SHIELD_WHILE = rx(`while ${SIDE}'s king has (\\d+|no|one|two|three|four)\\b`);
const BISHOPS = rx(`\\b${SIDE} has (?:the bishop pair|the two bishops|both bishops)`);
const TO_MOVE = rx(`(?:^|[.:;,(]\\s*|\\b(?:it's|it is|now|puzzle:)\\s+)${SIDE} (?:to (?:move|play)|is to move|moves next)\\b|\\b(?:it's|it is) ${SIDE}'s (?:move|turn)\\b`);
const MOBILITY_PAIR = rx(`\\b(\\d+) moves for (White|Black)'s pieces, (\\d+) for (White|Black)'s`);
const MOBILITY_MORE = rx(`\\b(White|Black)'s pieces are more active, with (\\d+) moves available against (\\d+) for (White|Black)'s`);
const HANGING_NONE = rx(`\\b(?:nothing of ${SIDE}'s is (?:hanging|loose|en prise)|no piece of ${SIDE}'s is (?:loose|hanging|en prise)|${SIDE} has nothing (?:hanging|loose|en prise))`);
const HANGING_ONE = rx(`\\b(?:(White|Black)'s |the )(queen|rook|bishop|knight|pawn) on ${SQ} is (?:hanging|undefended|loose|en prise)\\b`);
const OPEN_FILE = [
  rx(`\\bthe ${FILE}-file is (open|half-open|closed)\\b`),
  rx(`\\bthe ${FILE}- and ${FILE}-files are (open|half-open|closed)\\b`),
  rx(`\\b(?:the |an |on the )(open|half-open) ${FILE}-file\\b`),
];

const SENT_RE = /(?<=[.!?])\s+(?=[A-Z0-9("'])/;

/** Whitespace-normalised sentences (Python's claims.sentences). */
export function sentences(text: string): string[] {
  const norm = String(text).split(/\s+/).filter(Boolean).join(' ');
  return norm.split(SENT_RE).filter(Boolean);
}

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, no: 0 };
const UNIT_POINTS: Record<string, number> = {
  pawn: 1, pawns: 1, piece: 3, pieces: 3, 'minor piece': 3, 'minor pieces': 3, knight: 3, knights: 3, bishop: 3, bishops: 3,
  rook: 5, rooks: 5, queen: 9, queens: 9, exchange: 2, point: 1, points: 1, 'points of material': 1,
};

const sideOf = (word: string | undefined | null): Color | null => {
  if (!word) return null;
  const w = word.toLowerCase();
  return w.startsWith('white') ? WHITE : w.startsWith('black') ? BLACK : null;
};
const count = (word: string | undefined | null): number => {
  if (!word) return 0;
  const w = word.toLowerCase();
  return /^\d+$/.test(w) ? Number(w) : (NUMBERS[w] ?? 0);
};
const unit = (word: string | undefined | null): number => (word ? (UNIT_POINTS[word.toLowerCase().replaceAll('the ', '')] ?? 0) : 0);

/** Points of "a knight, two pawns and the exchange"; [0, true] for "the exchange" alone (composition, not points). */
function parseAmount(text: string | undefined): [number, boolean] {
  const items = [...(text ?? '').matchAll(ITEM_RE)].map((m) => [m[1] ?? '', m[2] ?? '', m[3] ?? '']);
  if (items.length === 1 && (items[0][2] || items[0][1].toLowerCase().includes('exchange'))) return [0, true];
  let total = 0;
  for (const [c, u, exch] of items) total += exch ? 2 : count(c) * unit(u);
  return [total, false];
}

const MODAL =
  /\b(?:would|could|might|may|if|unless|leav(?:e|es|ing)|idea|aims?|plans?|hopes?|tr(?:y|ies|ying)|threat(?:en|ens)?|wants?|can|should|going to|will|instead|suppose|imagine)\b/i;

/** A negation word shortly before `start` (same clause). */
function negated(sentence: string, start: number): boolean {
  const head = sentence.slice(Math.max(0, start - 30), start).split(/[,;:]/).pop() ?? '';
  return NEG.test(head);
}

/** Every checkable claim in `text`, in order. Sentences with a modal / hypothetical word ("would", "if", "leaving",
 * "the idea", "threatens", ...) talk about positions that may never arise: skipped unless `modal`. */
export function extractClaims(text: string, modal = false): Claim[] {
  const out: Claim[] = [];
  for (const s of sentences(text)) {
    if (!modal && MODAL.test(s)) continue;
    out.push(...sentenceClaims(s));
  }
  return out;
}

const all = (re: RegExp, s: string) => [...s.matchAll(re)];
const lower = (x: string | undefined | null) => (x ? x.toLowerCase() : null);

function sentenceClaims(s: string): Claim[] {
  const out: Claim[] = [];
  const add = (kind: ClaimKind, m: RegExpMatchArray | string, side: Color | null, args: Claim['args'], neg = false) =>
    out.push({ kind, text: typeof m === 'string' ? m : m[0], sentence: s, side, args, negated: neg });
  for (const [re, sideG, dirG, amtG] of [
    [MATERIAL_UP, 1, 2, 3],
    [MATERIAL_UP2, 1, 3, 2],
  ] as const) {
    for (const m of all(re, s)) {
      const [pts, exchange] = parseAmount(m[amtG]);
      const sign = ['up', 'ahead'].includes(m[dirG].toLowerCase()) ? 1 : -1;
      if (exchange) add('material', m, sideOf(m[sideG]), ['exchange', sign], negated(s, m.index!));
      else if (pts) add('material', m, sideOf(m[sideG]), ['diff', sign * pts], negated(s, m.index!));
    }
  }
  for (const m of all(MATERIAL_EXTRA, s)) {
    const n = count(m[2]) || 1;
    add('material', m, sideOf(m[1]), ['diff', n * unit(m[3])], negated(s, m.index!));
  }
  for (const m of all(MATERIAL_AHEAD, s)) {
    const side = m[1] || m[3];
    const up = ['ahead', 'up'].includes((m[2] || 'ahead').toLowerCase());
    add('material', m, sideOf(side), ['sign', up ? 1 : -1], negated(s, m.index!));
  }
  for (const m of all(MATERIAL_EQUAL, s)) add('material', m, null, ['equal']);
  for (const m of all(MATERIAL_POINTS, s)) add('material', m, sideOf(m[2]), ['diff', Number(m[1])]);

  const seenDoubled: [Color | null, string | null][] = [];
  for (const re of DOUBLED) {
    for (const m of all(re, s)) {
      const g = m.slice(1);
      const side = g.length === 2 ? sideOf(g[0]) : null;
      const f = g[g.length - 1] ?? null;
      if (seenDoubled.some(([ks, kf]) => kf === f && (ks === side || side === null)) || (f === null && seenDoubled.some(([ks]) => ks === side))) continue;
      seenDoubled.push([side, f]);
      add('doubled', m, side, [lower(f)], negated(s, m.index!));
    }
  }
  let seen = new Set<string | boolean | null>();
  for (const re of ISOLATED) {
    for (const m of all(re, s)) {
      const side = sideOf(m[1]);
      const where = m[2] ?? null;
      if (seen.has(where) || (where === null && seen.has(side))) continue;
      seen.add(where ? where : side);
      add('isolated', m, side, [lower(where)], negated(s, m.index!));
    }
  }
  seen = new Set();
  for (const re of PASSED) {
    for (const m of all(re, s)) {
      const side = sideOf(m[1]);
      const where = m[2] ?? null;
      // "passed pawns on a5 and b4": one claim per square (the file pattern has no list group)
      const more = m.length > 3 ? [...(m[3] ?? '').matchAll(/[a-h][1-8]/g)].map((x) => x[0]) : [];
      for (const w of where ? [where, ...more] : [null]) {
        if (seen.has(w) || (w === null && seen.has(side))) continue;
        seen.add(w ? w : side);
        add('passed', m, side, [lower(w)], negated(s, m.index!));
      }
    }
  }
  for (const m of all(PIECE_ON, s)) {
    const piece = m[2].toLowerCase();
    let squares = [m[4].toLowerCase(), ...[...(m[5] ?? '').matchAll(/[a-h][1-8]/g)].map((x) => x[0].toLowerCase())];
    if (!m[3]) squares = squares.slice(0, 1);
    for (const sq of squares) add('piece_on', m, sideOf(m[1]), [piece, sq]);
  }
  for (const m of all(CHECK, s)) add('check', m, sideOf(m[1] || m[2]), [], negated(s, m.index!));
  for (const m of all(SHIELD, s)) {
    const words = m[3].toLowerCase().replaceAll('only ', '').replaceAll('just ', '');
    add('shield', m, sideOf(m[1]), [count(words.split(/\s+/)[0])]);
    const re = new RegExp(SHIELD_WHILE.source, 'gi');
    re.lastIndex = m.index! + m[0].length;
    const w = re.exec(s);
    if (w) add('shield', w, sideOf(w[1]), [count(w[2])]);
  }
  for (const m of all(BISHOPS, s)) add('bishops', m, sideOf(m[1]), [], negated(s, m.index!));
  for (const m of all(TO_MOVE, s)) add('to_move', m, sideOf(m[1] || m[2]), []);
  for (const m of all(MOBILITY_PAIR, s)) {
    add('mobility', m, sideOf(m[2]), [Number(m[1])]);
    add('mobility', m, sideOf(m[4]), [Number(m[3])]);
  }
  for (const m of all(MOBILITY_MORE, s)) {
    add('mobility', m, sideOf(m[1]), [Number(m[2])]);
    add('mobility', m, sideOf(m[4]), [Number(m[3])]);
  }
  for (const m of all(HANGING_NONE, s)) add('hanging', m, sideOf(m[1] || m[2] || m[3]), ['none']);
  for (const m of all(HANGING_ONE, s)) add('hanging', m, sideOf(m[1]), [m[2].toLowerCase(), m[3].toLowerCase()], negated(s, m.index!));
  for (const re of OPEN_FILE) {
    for (const m of all(re, s)) {
      const g = m.slice(1).filter(Boolean) as string[];
      const state = g.map((x) => x.toLowerCase()).find((x) => x === 'open' || x === 'half-open' || x === 'closed')!;
      for (const f of g.filter((x) => x.length === 1).map((x) => x.toLowerCase())) add('open_file', m, null, [f, state]);
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------- checking
const sidesOf = (c: Claim): Color[] => (c.side !== null ? [c.side] : [WHITE, BLACK]);
const count2 = (b: Board, t: PieceType, c: Color) => b.squares(t, c).length;

function checkRaw(c: Claim, b: Board): boolean | null {
  switch (c.kind) {
    case 'material': {
      const bal = materialBalance(b);
      if (c.args[0] === 'equal') return bal === 0;
      if (c.side === null) return null;
      const mine = c.side === WHITE ? bal : -bal;
      const n = c.args[1] as number;
      if (c.args[0] === 'exchange') {
        const rooks = count2(b, 'r', c.side) - count2(b, 'r', !c.side);
        const minors = count2(b, 'n', c.side) + count2(b, 'b', c.side) - count2(b, 'n', !c.side) - count2(b, 'b', !c.side);
        return rooks * n > 0 && minors * n < 0;
      }
      if (c.args[0] === 'sign') return mine * n > 0;
      return mine === n;
    }
    case 'doubled': {
      const f = c.args[0] as string | null;
      return sidesOf(c).some((s) => (f ? doubledFiles(b, s).has(FILE_NAMES.indexOf(f)) : doubledFiles(b, s).size > 0));
    }
    case 'isolated':
    case 'passed': {
      const where = c.args[0] as string | null;
      for (const s of sidesOf(c)) {
        const set = c.kind === 'isolated' ? isolatedSquares(b, s) : passedSquares(b, s);
        if (where === null && set.size) return true;
        if (where && where.length === 2 && set.has(parseSquare(where))) return true;
        if (where && where.length === 1 && [...set].some((q) => sqFile(q) === FILE_NAMES.indexOf(where))) return true;
      }
      return false;
    }
    case 'piece_on': {
      const [piece, sq] = c.args as [string, string];
      const p = b.at(parseSquare(sq));
      return p !== null && p.type === PIECES[piece] && (c.side === null || p.color === c.side);
    }
    case 'check':
      return b.isCheck() && (c.side === null || b.turn === c.side);
    case 'shield':
      return c.side === null ? null : kingShelter(b, c.side) === c.args[0];
    case 'bishops':
      return sidesOf(c).some((s) => count2(b, 'b', s) >= 2);
    case 'to_move':
      return c.side === null || b.turn === c.side;
    case 'mobility':
      return c.side === null ? null : mobility(b, c.side) === c.args[0];
    case 'hanging': {
      if (c.args[0] === 'none') return sidesOf(c).every((s) => looseSquares(b, s).size === 0);
      const [piece, sq] = c.args as [string, string];
      const at = parseSquare(sq);
      const p = b.at(at);
      if (!p || p.type !== PIECES[piece] || (c.side !== null && p.color !== c.side)) return false;
      return looseSquares(b, p.color).has(at);
    }
    case 'open_file': {
      const [f, state] = c.args as [string, string];
      const [w, bl] = fileState(b, FILE_NAMES.indexOf(f));
      if (state === 'open') return !w && !bl;
      if (state === 'half-open') return w !== bl;
      return w && bl;
    }
  }
  return null;
}

/** Does `claim` hold on `board`? null: not decidable. */
export function checkClaim(claim: Claim, board: Board): boolean | null {
  const r = checkRaw(claim, board);
  if (r === null) return null;
  return claim.negated ? !r : r;
}

export function verify(claim: Claim, root: Board, others: Board[] = []): ClaimVerdict {
  const atRoot = checkClaim(claim, root);
  if (atRoot === null) return { claim, verdict: 'unknown' };
  if (atRoot) return { claim, verdict: 'true' };
  for (const b of others) if (checkClaim(claim, b)) return { claim, verdict: 'shifted' };
  return { claim, verdict: 'false' };
}

export function verifyText(text: string, root: Board, others: Board[] = []): ClaimVerdict[] {
  return extractClaims(text).map((c) => verify(c, root, others));
}

// ------------------------------------------------------------------------------------------ evaluation numbers
const EVAL_RE = new RegExp(
  '(?<![\\w.\\-+])[+\\-\\u2212]\\d{1,2}\\.\\d{1,2}(?!\\w|\\.\\d)' + // +0.4 / -1.25
    '|(?<![\\w.])#-?\\d{1,2}(?!\\w|\\.\\d)' + // #3 / #-2
    '|\\b(?:eval(?:uation)?|score|stockfish|engine|computer)\\b[^.\\n]{0,40}?(?<![\\w.])\\d{1,2}\\.\\d(?!\\w|\\.\\d)' + // Eval 0.0
    '|(?<![\\w.])\\d{1,2}\\.\\d\\s+(?:for|in)\\s+(?:White|Black)\\b' + // 1.3 for White
    '|(?<![\\w.])\\d{1,2}\\.\\d\\s+pawns?\\b|\\babout \\d{1,2} pawns\\b', // about 2.3 pawns (a loss)
  'gi',
);
const ENGINE_RE = /\b(?:stockfish|the engine|engine's|an engine|the computer|leela|lc0|komodo)\b/gi;

export interface Span {
  text: string;
  index: number;
}

/** Engine-style evaluations in `text` ("+0.4", "Eval 0.0", "#3", "1.3 for White") with their offsets. */
export function evalSpans(text: string): Span[] {
  return [...(text ?? '').matchAll(EVAL_RE)].map((m) => ({ text: m[0], index: m.index! }));
}

export function evalCitations(text: string): string[] {
  return evalSpans(text).map((s) => s.text);
}

/** Attributions to an engine ("Stockfish rates ...", "the engine's count"). */
export function engineMentions(text: string): string[] {
  return [...(text ?? '').matchAll(ENGINE_RE)].map((m) => m[0]);
}
