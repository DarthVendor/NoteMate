/**
 * Port of ChessMind's ChessTokenizer (chessmind/model/tokenizer.py) for the browser.
 *
 * One id space: [special][UCI moves][squares][pieces][byte-level BPE text], with the
 * chess part read from chess_vocab.json and the text part from a Hugging Face
 * `tokenizers` tokenizer.json (byte-level BPE).
 *
 * Two text formats (chess_vocab.json `format`):
 *   2  GPT-2 ByteLevel split, no prefix space (tokenizer v2 models);
 *   3  the chess-notation Split pattern stored in tokenizer.json (CHESS_PRETOKENIZE_PATTERN in Python:
 *      squares, SAN, castling, move numbers stay single pre-tokens) and a space prepended to every
 *      encoded text span (decoding drops it again);
 *   4  format 3 text + `extra_special` tokens placed AFTER the text ids (ids extra_offset + i, extra_offset =
 *      text_offset + text_vocab_size): `<|end_think|>` closes hidden reasoning `<|think|> ... <|end_think|>`.
 *      Every id below extra_offset is shared with format 3; files without `extra_special` behave as before.
 *      Extras 1-5 were `<|reserved_k|>` placeholders and are now named (same ids): `<|branch|>`, `<|end_branch|>`,
 *      `<|repetition|>`, `<|draw|>`, `<|mate|>` -- line branches and end markers (lines.ts). A file listing the
 *      placeholders loads with the new names, as in Python (LEGACY_EXTRA_NAMES).
 * Checked against Python by scripts/test-chessmind.mjs (fixtures from ChessMind's scripts/tokenizer_fixture.py).
 */

export interface ChessVocabFile {
  special: string[];
  moves: string[];
  squares: string[];
  pieces: string[];
  text_offset: number;
  text_vocab_size: number;
  /** 2 (absent) = GPT-2 split, no prefix space; 3 = chess-notation split + prefix space. */
  format?: number;
  text_prefix_space?: boolean;
  /** Format 4: special tokens after the text ids (`<|end_think|>`, `<|reserved_1|>`, ...). */
  extra_special?: string[];
  /** Format 4: first extra id (= text_offset + text_vocab_size). */
  extra_offset?: number;
}

interface PreTokenizerJson {
  type: string;
  pretokenizers?: PreTokenizerJson[];
  pattern?: { Regex?: string; String?: string };
  behavior?: string;
}

interface BpeFile {
  model: { type: string; vocab: Record<string, number>; merges: (string | [string, string])[] };
  pre_tokenizer?: PreTokenizerJson | null;
}

export type Perspective = 'white' | 'black';

import type { ChatLeafPart, ChatLinePart, ChatPart, LineBranch, LineMark } from '../types';
import { encodeLineTokens } from './lines.ts';

/** Names of the format-4 extras in slot order (tokenizer.EXTRA_SPECIAL_TOKENS); slots 1-5 replace `<|reserved_k|>`. */
export const EXTRA_SPECIAL_TOKENS = ['<|end_think|>', '<|branch|>', '<|end_branch|>', '<|repetition|>', '<|draw|>', '<|mate|>', '<|reserved_6|>', '<|reserved_7|>'];

/** One part of dialogue content: plain text, a line of UCI moves, a board snapshot (FEN) or (format 4) a think. */
export type DialoguePart = ChatPart;
export interface DialogueTurn {
  role: 'user' | 'assistant';
  parts: DialoguePart[];
}

const PIECE_SYMBOLS = 'PNBRQKpnbrqk.';

// GPT-2 / HF ByteLevel: every byte maps to a printable unicode char.
function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const table: string[] = new Array(256);
  bs.forEach((b, i) => (table[b] = String.fromCharCode(cs[i])));
  return table;
}

// The ByteLevel pre-tokenizer's split pattern (use_regex: true), tokenizer v2.
const SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/** The v3 Split pattern from tokenizer.json (Sequence[Split(Regex), ByteLevel(use_regex=false)]), or null. */
function splitPatternOf(pre: PreTokenizerJson | null | undefined): RegExp | null {
  if (!pre) return null;
  const list = pre.type === 'Sequence' ? pre.pretokenizers ?? [] : [pre];
  const split = list.find((p) => p.type === 'Split' && p.pattern?.Regex);
  return split ? new RegExp(split.pattern!.Regex!, 'gu') : null;
}

/** Pieces of `text` under `re` with HF "isolated" semantics: matches and the gaps between them. */
function isolate(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > pos) out.push(text.slice(pos, m.index));
    if (m[0].length) out.push(m[0]);
    pos = m.index! + m[0].length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/** `{ think, answer }` of decoded content (think parts flattened; `thought`: a think part was present).
 * ChessTokenizer.split_think in Python. */
export function splitThink(parts: DialoguePart[]): { think: ChatLeafPart[]; answer: ChatLeafPart[]; thought: boolean } {
  const think: ChatLeafPart[] = [];
  const answer: ChatLeafPart[] = [];
  let thought = false;
  for (const p of parts) {
    if (p.kind === 'think') {
      thought = true;
      think.push(...p.parts);
    } else answer.push(p);
  }
  return { think, answer, thought };
}

export class ChessTokenizer {
  readonly special: string[];
  readonly moves: string[];
  readonly chessTokens: string[];
  readonly moveOffset: number;
  readonly squareOffset: number;
  readonly pieceOffset: number;
  readonly textOffset: number;
  readonly textVocabSize: number;
  /** Tokenizer format (2 or 3, see the file comment). */
  readonly format: number;
  readonly prefixSpace: boolean;
  /** Format 4 extra specials (after the text ids), [] for older tokenizers. */
  readonly extraSpecial: string[];
  private readonly extraBase: number;
  private readonly split: RegExp;
  private readonly chessToId = new Map<string, number>();

  private readonly byteEnc = bytesToUnicode();
  private readonly byteDec = new Map<string, number>();
  private readonly vocab = new Map<string, number>();
  private readonly idToToken: string[] = [];
  private readonly ranks = new Map<string, number>();
  private readonly cache = new Map<string, number[]>();

  constructor(chess: ChessVocabFile, bpe: BpeFile | null) {
    this.special = chess.special;
    this.moves = chess.moves;
    this.chessTokens = [...chess.special, ...chess.moves, ...chess.squares, ...chess.pieces];
    this.chessTokens.forEach((t, i) => this.chessToId.set(t, i));
    this.moveOffset = chess.special.length;
    this.squareOffset = this.moveOffset + chess.moves.length;
    this.pieceOffset = this.squareOffset + chess.squares.length;
    this.textOffset = this.chessTokens.length;
    if (this.textOffset !== chess.text_offset) throw new Error('chess_vocab.json text_offset mismatch');
    this.byteEnc.forEach((c, b) => this.byteDec.set(c, b));
    if (bpe) {
      for (const [tok, id] of Object.entries(bpe.model.vocab)) {
        this.vocab.set(tok, id);
        this.idToToken[id] = tok;
      }
      bpe.model.merges.forEach((m, i) => {
        const [a, b] = typeof m === 'string' ? (m.split(' ') as [string, string]) : m;
        this.ranks.set(`${a} ${b}`, i);
      });
    }
    this.textVocabSize = this.vocab.size;
    this.format = chess.format ?? 2;
    this.prefixSpace = chess.text_prefix_space ?? this.format >= 3;
    const pattern = splitPatternOf(bpe?.pre_tokenizer);
    if (this.format >= 3 && bpe && !pattern) throw new Error('format 3 tokenizer.json without a Split pre-tokenizer');
    this.split = pattern ?? SPLIT;
    // Placeholder names of slots 1-5 load as the names those slots have now (same ids).
    this.extraSpecial = (chess.extra_special ?? []).map((t, i) => (i >= 1 && i <= 5 && t === `<|reserved_${i}|>` ? EXTRA_SPECIAL_TOKENS[i] : t));
    // Without the BPE file (no text model) the extras' position comes from chess_vocab.json; older files: as before.
    this.extraBase =
      bpe || !this.extraSpecial.length ? this.textOffset + this.textVocabSize : (chess.extra_offset ?? this.textOffset + chess.text_vocab_size);
    if (bpe && chess.extra_offset !== undefined && chess.extra_offset !== this.extraBase) {
      throw new Error(`chess_vocab.json extra_offset ${chess.extra_offset} != text_offset + text ids ${this.extraBase}`);
    }
    this.extraSpecial.forEach((t, i) => this.chessToId.set(t, this.extraBase + i));
  }

  /** First id after the text ids: format-4 extra specials start here. */
  get extraOffset(): number {
    return this.extraBase;
  }
  get size(): number {
    return this.extraOffset + this.extraSpecial.length;
  }
  /** `<|end_think|>` (format 4), else null: the model cannot produce hidden reasoning. */
  get endThinkId(): number | null {
    const i = this.extraSpecial.indexOf('<|end_think|>');
    return i < 0 ? null : this.extraOffset + i;
  }
  get supportsThinking(): boolean {
    return this.endThinkId !== null;
  }
  private extraId(name: string): number | null {
    const i = this.extraSpecial.indexOf(name);
    return i < 0 ? null : this.extraOffset + i;
  }
  /** `<|branch|>` / `<|end_branch|>` (named format-4 extras), else null. */
  get branchId(): number | null {
    return this.extraId('<|branch|>');
  }
  get endBranchId(): number | null {
    return this.extraId('<|end_branch|>');
  }
  /** End markers this tokenizer has (`{}` before the named extras). */
  get markerIds(): Partial<Record<LineMark, number>> {
    const out: Partial<Record<LineMark, number>> = {};
    for (const [name, token] of [['mate', '<|mate|>'], ['draw', '<|draw|>'], ['repetition', '<|repetition|>']] as const) {
      const id = this.extraId(token);
      if (id !== null) out[name] = id;
    }
    return out;
  }
  /** Line branches and end markers. */
  get supportsBranches(): boolean {
    return this.branchId !== null && this.endBranchId !== null && Object.keys(this.markerIds).length === 3;
  }
  isExtraId(i: number): boolean {
    return i >= this.extraOffset && i < this.size;
  }
  get hasText(): boolean {
    return this.textVocabSize > 0;
  }

  id(token: string): number {
    const i = this.chessToId.get(token);
    if (i === undefined) throw new Error(`unknown chess token ${token}`);
    return i;
  }
  get gameId() { return this.id('<|game|>'); }
  get bosId() { return this.id('<|bos|>'); }
  get eosId() { return this.id('<|eos|>'); }
  get moveId() { return this.id('<|move|>'); }
  get thinkId() { return this.id('<|think|>'); }
  get fenId() { return this.id('<|fen|>'); }
  get whiteId() { return this.id('<|white|>'); }
  get blackId() { return this.id('<|black|>'); }
  get userId() { return this.id('<|user|>'); }
  get assistantId() { return this.id('<|assistant|>'); }
  get lineId() { return this.id('<|line|>'); }
  get endLineId() { return this.id('<|end_line|>'); }

  moveToId(uci: string): number {
    return this.id(uci);
  }
  isMoveId(i: number): boolean {
    return i >= this.moveOffset && i < this.squareOffset;
  }
  isTextId(i: number): boolean {
    return i >= this.textOffset && i < this.extraOffset;
  }
  idToMove(i: number): string {
    if (!this.isMoveId(i)) throw new Error(`id ${i} is not a move token`);
    return this.moves[i - this.moveOffset];
  }

  // ---------------------------------------------------------------- BPE
  private bpeWord(word: string): number[] {
    const hit = this.cache.get(word);
    if (hit) return hit;
    let parts = Array.from(word);
    while (parts.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      const a = parts[best];
      const b = parts[best + 1];
      // Merge every occurrence of this pair, left to right (as HF does for one rank).
      const next: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) {
          next.push(a + b);
          i++;
        } else next.push(parts[i]);
      }
      parts = next;
    }
    const ids = parts.map((p) => {
      const id = this.vocab.get(p);
      if (id === undefined) throw new Error(`BPE piece ${JSON.stringify(p)} missing from vocab`);
      return id;
    });
    if (this.cache.size < 50000) this.cache.set(word, ids);
    return ids;
  }

  /** BPE-encode plain English into offset text ids. */
  encodeText(text: string): number[] {
    if (!this.hasText) throw new Error('this model has no text tokenizer');
    if (!text) return [];
    if (this.prefixSpace) text = ' ' + text; // v3: every span starts like mid-text
    const utf8 = new TextEncoder();
    const out: number[] = [];
    for (const piece of isolate(text, this.split)) {
      let mapped = '';
      for (const b of utf8.encode(piece)) mapped += this.byteEnc[b];
      for (const id of this.bpeWord(mapped)) out.push(id + this.textOffset);
    }
    return out;
  }

  decodeText(ids: number[]): string {
    const bytes: number[] = [];
    for (const i of ids) {
      const tok = this.idToToken[i - this.textOffset];
      if (tok === undefined) continue;
      for (const ch of tok) {
        const b = this.byteDec.get(ch);
        if (b !== undefined) bytes.push(b);
      }
    }
    const text = new TextDecoder().decode(new Uint8Array(bytes));
    return this.prefixSpace && text.startsWith(' ') ? text.slice(1) : text; // the prefix space encodeText added
  }

  // ---------------------------------------------------------------- chess encodings
  /** `<|white|>` / `<|black|>` for a perspective. */
  perspectiveId(side: Perspective): number {
    return side === 'white' ? this.whiteId : this.blackId;
  }

  /** Side to move after `plies` plies from the initial position. */
  static sideToMove(plies: number): Perspective {
    return plies % 2 === 0 ? 'white' : 'black';
  }

  /**
   * `<|game|> [<|result:..|>] m1 m2 ...`, or with a perspective (models trained on per-side instances,
   * manifest `perspective_games`) `<|bos|> <|game|> <side> [<|result|>] m1 ...`.
   */
  encodeGame(movesUci: string[], result?: '1-0' | '0-1' | '1/2-1/2' | '*', perspective?: Perspective): number[] {
    const ids = perspective ? [this.bosId, this.gameId, this.perspectiveId(perspective)] : [this.gameId];
    if (result) ids.push(this.id({ '1-0': '<|result:1-0|>', '0-1': '<|result:0-1|>', '1/2-1/2': '<|result:1/2|>', '*': '<|result:*|>' }[result]));
    for (const m of movesUci) ids.push(this.moveToId(m));
    return ids;
  }

  /** `<|fen|> <side> <64 piece tokens a8..h1>` from a FEN string. */
  encodeBoard(fen: string): number[] {
    const [placement, side] = fen.split(' ');
    const ids = [this.fenId, side === 'b' ? this.blackId : this.whiteId];
    for (const row of placement.split('/')) {
      for (const ch of row) {
        if (/\d/.test(ch)) for (let k = 0; k < Number(ch); k++) ids.push(this.pieceOffset + PIECE_SYMBOLS.indexOf('.'));
        else ids.push(this.pieceOffset + PIECE_SYMBOLS.indexOf(ch));
      }
    }
    if (ids.length !== 66) throw new Error(`bad FEN ${fen}`);
    return ids;
  }

  /**
   * `<|user|> text <|assistant|> text <|line|> m1 m2 <|end_line|> ...` (lines are assumed legal). Format 4: an
   * assistant turn may start with a think part, `<|think|> parts <|end_think|>`.
   */
  encodeDialogue(turns: DialogueTurn[]): number[] {
    const ids: number[] = [];
    // where lines start: the last fen part (a fen inside a think applies until <|end_think|> only)
    const state: { start?: string } = {};
    for (const turn of turns) {
      ids.push(turn.role === 'user' ? this.userId : this.assistantId);
      turn.parts.forEach((part, i) => {
        if (part.kind !== 'think') return this.encodePart(part, ids, state);
        if (turn.role !== 'assistant' || i !== 0) throw new Error('a think part must be the first part of an assistant turn');
        const endThink = this.endThinkId;
        if (endThink === null) throw new Error('this tokenizer has no <|end_think|> (format 4 needed for think parts)');
        ids.push(this.thinkId);
        const outer = state.start;
        for (const sub of part.parts) {
          if ((sub as DialoguePart).kind === 'think') throw new Error('nested think part');
          this.encodePart(sub, ids, state);
        }
        ids.push(endThink);
        state.start = outer;
      });
    }
    return ids;
  }

  private encodePart(part: ChatLeafPart, ids: number[], state: { start?: string }): void {
    if (part.kind === 'text') ids.push(...this.encodeText(part.text));
    else if (part.kind === 'fen') {
      ids.push(...this.encodeBoard(part.fen));
      state.start = part.fen;
    } else {
      ids.push(this.lineId);
      if (this.supportsBranches) for (const t of encodeLineTokens(part, state.start)) ids.push(this.id(t));
      else {
        if (part.branches?.length) throw new Error('this tokenizer has no <|branch|> (line branches need the named format-4 extras)');
        for (const m of part.moves) ids.push(this.moveToId(m)); // older tokenizers: lines are assumed legal
      }
      ids.push(this.endLineId);
    }
  }

  /** Generation prefix for the next assistant turn: `<|eos|> <|user|> ... <|assistant|>` (training packs every
   * sequence after the previous one's <|eos|>; ChessTokenizer.chat_prompt in Python). */
  chatPrompt(turns: DialogueTurn[]): number[] {
    return [this.eosId, ...this.encodeDialogue(turns), this.assistantId];
  }

  /**
   * Split assistant output ids into text / line / fen parts (control tokens dropped; an open line is kept). A
   * complete `<|fen|> <side> <64 pieces>` snapshot becomes a fen part (placement + side, `- - 0 1`);
   * `<|think|> ... <|end_think|>` becomes one think part (also while still open, for streaming).
   * Port of ChessTokenizer.decode_dialogue_content.
   */
  decodeDialogueContent(ids: number[]): DialoguePart[] {
    const top: DialoguePart[] = [];
    let think: ChatLeafPart[] | null = null;
    let textRun: number[] = [];
    let line: ChatLinePart | null = null;
    /** Open branches of `line`, innermost last. */
    let stack: LineBranch[] = [];
    let fenRun: number[] | null = null;
    const endThink = this.endThinkId;
    const branch = this.branchId;
    const endBranch = this.endBranchId;
    const markers = new Map<number, LineMark>(Object.entries(this.markerIds).map(([k, v]) => [v, k as LineMark]));
    const out = (): (DialoguePart | ChatLeafPart)[] => think ?? top;
    const flush = () => {
      if (textRun.length) {
        const text = this.decodeText(textRun).trim();
        if (text) out().push({ kind: 'text', text });
      }
      textRun = [];
    };
    for (const t of ids) {
      if (fenRun !== null) {
        fenRun.push(t);
        if (fenRun.length === 65) {
          const fen = this.snapshotFen(fenRun);
          if (fen !== null) out().push({ kind: 'fen', fen });
          fenRun = null;
        }
        continue;
      }
      if (line !== null) {
        const cur: ChatLinePart | LineBranch = stack.length ? stack[stack.length - 1] : line;
        if (this.isMoveId(t)) {
          cur.moves.push(this.idToMove(t));
          continue;
        }
        if (branch !== null && t === branch) {
          const sub: LineBranch = { at: cur.moves.length - 1, moves: [] };
          (cur.branches ??= []).push(sub);
          stack.push(sub);
          continue;
        }
        if (endBranch !== null && t === endBranch) {
          stack.pop();
          continue;
        }
        const mark = markers.get(t);
        if (mark) {
          cur.end = mark;
          continue;
        }
        out().push(line);
        line = null;
        stack = [];
        if (t === this.endLineId) continue;
      }
      if (this.isTextId(t)) {
        textRun.push(t);
        continue;
      }
      flush();
      if (t === this.lineId) line = { kind: 'line', moves: [] };
      else if (t === this.fenId) fenRun = [];
      else if (t === this.thinkId && think === null) think = [];
      else if (endThink !== null && t === endThink && think !== null) {
        top.push({ kind: 'think', parts: think });
        think = null;
      }
    }
    flush();
    if (line !== null) out().push(line);
    if (think !== null) top.push({ kind: 'think', parts: think });
    return top;
  }

  /** FEN (placement + side, `- - 0 1`) of `<side> + 64 piece tokens`; null if malformed. */
  snapshotFen(ids: number[]): string | null {
    if (ids.length !== 65 || (ids[0] !== this.whiteId && ids[0] !== this.blackId)) return null;
    const rows: string[] = [];
    for (let r = 0; r < 8; r++) {
      let row = '';
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const k = ids[1 + 8 * r + f] - this.pieceOffset;
        if (k < 0 || k >= PIECE_SYMBOLS.length) return null;
        const sym = PIECE_SYMBOLS[k];
        if (sym === '.') {
          empty++;
          continue;
        }
        if (empty) row += String(empty);
        empty = 0;
        row += sym;
      }
      rows.push(row + (empty ? String(empty) : ''));
    }
    return `${rows.join('/')} ${ids[0] === this.whiteId ? 'w' : 'b'} - - 0 1`;
  }

  /** Chess tokens verbatim, text spans BPE-decoded, joined by spaces (like the Python decode). */
  decode(ids: number[]): string {
    const out: string[] = [];
    let run: number[] = [];
    for (const i of ids) {
      if (this.isTextId(i)) {
        run.push(i);
        continue;
      }
      if (run.length) out.push(this.decodeText(run));
      run = [];
      out.push(this.isExtraId(i) ? this.extraSpecial[i - this.extraOffset] : (this.chessTokens[i] ?? `<${i}>`));
    }
    if (run.length) out.push(this.decodeText(run));
    return out.join(' ');
  }
}
