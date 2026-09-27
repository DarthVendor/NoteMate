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
 *      encoded text span (decoding drops it again).
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

import type { ChatPart } from '../types';

/** One part of dialogue content: plain text, a line of UCI moves, or a board snapshot (FEN). */
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
  }

  get size(): number {
    return this.textOffset + this.textVocabSize;
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
    return i >= this.textOffset && i < this.size;
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

  /** `<|user|> text <|assistant|> text <|line|> m1 m2 <|end_line|> ...` (lines are assumed legal). */
  encodeDialogue(turns: DialogueTurn[]): number[] {
    const ids: number[] = [];
    for (const turn of turns) {
      ids.push(turn.role === 'user' ? this.userId : this.assistantId);
      for (const part of turn.parts) {
        if (part.kind === 'text') ids.push(...this.encodeText(part.text));
        else if (part.kind === 'fen') ids.push(...this.encodeBoard(part.fen));
        else {
          ids.push(this.lineId);
          for (const m of part.moves) ids.push(this.moveToId(m));
          ids.push(this.endLineId);
        }
      }
    }
    return ids;
  }

  /** Generation prefix for the next assistant turn: `<|eos|> <|user|> ... <|assistant|>` (training packs every
   * sequence after the previous one's <|eos|>; ChessTokenizer.chat_prompt in Python). */
  chatPrompt(turns: DialogueTurn[]): number[] {
    return [this.eosId, ...this.encodeDialogue(turns), this.assistantId];
  }

  /** Split assistant output ids into text / line parts (control tokens dropped; an open line is kept). */
  decodeDialogueContent(ids: number[]): DialoguePart[] {
    const parts: DialoguePart[] = [];
    let textRun: number[] = [];
    let line: string[] | null = null;
    const flush = () => {
      if (textRun.length) parts.push({ kind: 'text', text: this.decodeText(textRun).trim() });
      textRun = [];
    };
    for (const t of ids) {
      if (line !== null) {
        if (this.isMoveId(t)) {
          line.push(this.idToMove(t));
          continue;
        }
        parts.push({ kind: 'line', moves: line });
        line = null;
        if (t === this.endLineId) continue;
      }
      if (this.isTextId(t)) {
        textRun.push(t);
        continue;
      }
      flush();
      if (t === this.lineId) line = [];
    }
    flush();
    if (line !== null) parts.push({ kind: 'line', moves: line });
    return parts;
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
      out.push(this.chessTokens[i] ?? `<${i}>`);
    }
    if (run.length) out.push(this.decodeText(run));
    return out.join(' ');
  }
}
