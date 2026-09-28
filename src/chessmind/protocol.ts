import type { DialoguePart, DialogueTurn } from './tokenizer';
import type { LineRules } from './lineRules';
import type { ChatLeafPart } from '../types';

/** Default think budget: tokens of hidden reasoning before <|end_think|> is forced (as chat() in generate.py).
 * Training thinks run from ~50 to ~2,000 tokens; a whole training example fits the 2,560-token context. */
export const DEFAULT_MAX_THINK_TOKENS = 2560;
/** Move lines in chat answers are greedy (as chat() in generate.py, line_temperature=0); temperature applies to text. */
export const DEFAULT_LINE_TEMPERATURE = 0;

/**
 * onnxruntime-web CPU build, served from the app's own origin under ort/ (scripts/copy-ort.mjs). The artifact host
 * blocks fetching .wasm from CDNs and caps files at 15 MB, which rules out the 26.8 MB WebGPU runtime; for these int8
 * models WebGPU was slower anyway. Paths are resolved against the page root at load time.
 */
export const ORT_VERSION = '1.30.0';
export const ORT_DIR = 'ort/';
export const ORT_SCRIPT_FILE = 'ort.wasm.min.js';

export type Backend = 'auto' | 'wasm' | 'webgpu';
export type ThinkMode = 'auto' | 'on' | 'off';

/** Contents of <model dir>/model.json written by ChessMind's scripts/export_onnx.py. */
export interface ModelManifest {
  name: string;
  step: number | null;
  params: number;
  vocab: number;
  d_model: number;
  n_layer: number;
  n_head: number;
  max_seq_len: number;
  boards: boolean;
  /** Trained on per-side game instances: game prompts start `<|bos|> <|game|> <side to move>`. */
  perspective_games?: boolean;
  /** Text tokenizer format (2 = GPT-2 split; 3 = chess-notation split + prefix space; 4 = 3 + <|end_think|>). */
  tokenizer_format?: number;
  quant: string;
  inputs: string[];
  /** The graph has a KV cache (see `kv`); absent = the stateless graph (the whole sequence every call). */
  kv_cache?: boolean;
  /** Per layer i: past_key.{i} / past_value.{i} float32[1, P, n_kv_heads, head_dim] in (the cached tokens, token-major),
   * new_key.{i} / new_value.{i} [1, T, n_kv_heads, head_dim] out (the T new tokens' rows, appended by the caller).
   * The new tokens take positions P .. P+T-1. */
  kv?: { n_layer: number; n_kv_heads: number; head_dim: number; past: string[]; new: string[]; rope_theta?: number };
  chunks: { size: number; parts: string[] };
  files: { tokenizer: string; chess_vocab: string; parts: string };
}

/** Think budget of a think-then-move pick (think_move.DEFAULT_THINK_TOKENS in ChessMind). */
export const DEFAULT_THINK_MOVE_TOKENS = 384;
/** Think text sampling of a think-then-move pick (play_move_with_think's defaults). */
export const DEFAULT_THINK_MOVE_TEMPERATURE = 0.8;
export const DEFAULT_THINK_MOVE_TOP_K = 50;

/** The think before a picked move: its parts (text / lines), its tokens, and whether it was cut off (no <|end_think|>). */
export interface PickThink {
  parts: ChatLeafPart[];
  tokens: number;
  open: boolean;
}

export interface MovePrediction {
  uci: string;
  /** Probability among legal moves. */
  p: number;
}

export type ToWorker =
  /** threads: wasm threads (0 / unset = auto: several when the page is cross-origin isolated, else 1). */
  | { type: 'load'; base: string; backend: Backend; threads?: number; debug?: boolean }
  /** contextPlies (board models only): feed <|game|> + the last N moves, the game token carrying the board at the crop. null = full game. */
  | { type: 'predict'; id: number; moves: string[]; top: number; contextPlies: number | null }
  | {
      type: 'chat';
      id: number;
      history: DialogueTurn[];
      prompt: string;
      /** When set, the question is asked about this position (a board snapshot is prepended and lines start here). */
      fen?: string;
      /** Game moves (UCI from the start) appended to the question as a <|line|> so the model sees the position. */
      context?: string[];
      /** The app's context for the position under discussion (promptContext.ts: position note, engine or candidates
       * block), sent as the last text part of the question. */
      contextText?: string;
      /** The game from the initial position when only `fen` is sent: not in the prompt, only boards an answer's
       * snapshot may rewind to (the positions along it; the initial position is always one). */
      gameMoves?: string[];
      /** Answer budget (the think budget comes on top). */
      maxTokens: number;
      /** Text sampling temperature (words only). */
      temperature: number;
      topK: number;
      /** Temperature of move lines, from <|line|> through <|end_line|> (the moves and where the line stops), in the
       * answer and inside the think. Default DEFAULT_LINE_TEMPERATURE = 0: greedy, the top legal choice. */
      lineTemperature?: number;
      /** Hidden reasoning (models whose tokenizer has <|end_think|>): 'on' forces <|think|> first, 'off' forbids it,
       * 'auto' lets the model choose. Ignored by other models. */
      think?: ThinkMode;
      /** Most tokens inside <|think|> ... <|end_think|> before the close is forced (default DEFAULT_MAX_THINK_TOKENS). */
      maxThinkTokens?: number;
      /** Where lines stop (end-line threshold, length cap, finished positions); unset fields: DEFAULT_LINE_RULES. */
      lineRules?: { endP?: Partial<LineRules['endP']>; maxPlies?: Partial<LineRules['maxPlies']>; stopFinished?: boolean };
      /** Tool calling (tokenizers with the tool tokens; tools.ts): the tools offered (announced as `[Tools: ...]`),
       * which take a line, the most calls per answer, a tool whose first call is forced (a demo for models not trained
       * with tools) and how long to wait for each result. The worker asks the app with `tool-call` messages. */
      tools?: { names: string[]; takesLine?: Record<string, boolean>; maxCalls?: number; force?: string | null; timeoutMs?: number };
    }
  /** The app's answer to a `tool-call`: the result text (an error result when `ok` is false). */
  | { type: 'tool-result'; id: number; call: number; text: string; ok: boolean; compact?: string[] }
  | { type: 'explain'; id: number; moves: string[]; maxTokens: number; temperature: number; topK: number; top: number; contextPlies: number | null }
  | { type: 'stop'; id: number }
  /** Choose one move for the position after `moves` (legal-masked): argmax when temperature is 0, else sampled. Not coalesced like predict.
   * Think-then-move (models whose tokenizer has <|end_think|>; thinkMove.ts): `think` 'on' writes `<|think|> <side>
   * text / lines <|end_think|>` before the move, 'auto' lets the model choose, 'off' (default) picks directly. The
   * think streams as `chat-update` messages with this id (one think part); `temperature` is the move's. */
  | {
      type: 'pick';
      id: number;
      moves: string[];
      temperature: number;
      contextPlies: number | null;
      think?: ThinkMode;
      /** Most think tokens before the close is forced (default DEFAULT_THINK_MOVE_TOKENS). */
      maxThinkTokens?: number;
      /** Think text sampling (default 0.8 / 50). */
      thinkTemperature?: number;
      thinkTopK?: number;
      /** Think lines (default DEFAULT_LINE_TEMPERATURE = 0: greedy). */
      lineTemperature?: number;
      lineRules?: { endP?: Partial<LineRules['endP']>; maxPlies?: Partial<LineRules['maxPlies']>; stopFinished?: boolean };
    };

export type FromWorker =
  | { type: 'progress'; loaded: number; total: number; phase: 'download' | 'compile' }
  | { type: 'ready'; manifest: ModelManifest; backend: string; loadMs: number; cached: boolean; hasText: boolean; thinking: boolean; threads?: number; kvCache?: boolean }
  | { type: 'prediction'; id: number; moves: MovePrediction[]; ms: number; tokens: number }
  /** msPerToken: mean of the steps after the first (the first, which reads the prompt, is prefillMs). */
  | { type: 'chat-update'; id: number; parts: DialoguePart[]; tokens: number; msPerToken: number; done: boolean; stopped?: boolean; prefillMs?: number; predictions?: MovePrediction[] }
  /** `think`: the think written before the move (think picks only; absent when the model moved without one). */
  | { type: 'picked'; id: number; uci: string | null; p: number; ms: number; tokens: number; think?: PickThink }
  | { type: 'error'; id?: number; message: string }
  /** The model called a tool (generation is paused): run `name` on `fen` (the position asked about: the call's line
   * `moves` played from `baseFen`, or the current position) and answer with `tool-result`. `numbers`: move numbers of
   * `fen` are real. */
  | { type: 'tool-call'; id: number; call: number; name: string; fen: string; moves: string[]; baseFen?: string; numbers: boolean }
  /** Debug mode only: one forward pass (see worker debugCheck). */
  | { type: 'debug'; data: Record<string, unknown> };
