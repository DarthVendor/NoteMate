import type { DialoguePart, DialogueTurn } from './tokenizer';

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
  chunks: { size: number; parts: string[] };
  files: { tokenizer: string; chess_vocab: string; parts: string };
}

export interface MovePrediction {
  uci: string;
  /** Probability among legal moves. */
  p: number;
}

export type ToWorker =
  | { type: 'load'; base: string; backend: Backend }
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
    }
  | { type: 'explain'; id: number; moves: string[]; maxTokens: number; temperature: number; topK: number; top: number; contextPlies: number | null }
  | { type: 'stop'; id: number }
  /** Choose one move for the position after `moves` (legal-masked): argmax when temperature is 0, else sampled. Not coalesced like predict. */
  | { type: 'pick'; id: number; moves: string[]; temperature: number; contextPlies: number | null };

export type FromWorker =
  | { type: 'progress'; loaded: number; total: number; phase: 'download' | 'compile' }
  | { type: 'ready'; manifest: ModelManifest; backend: string; loadMs: number; cached: boolean; hasText: boolean; thinking: boolean }
  | { type: 'prediction'; id: number; moves: MovePrediction[]; ms: number; tokens: number }
  | { type: 'chat-update'; id: number; parts: DialoguePart[]; tokens: number; msPerToken: number; done: boolean; stopped?: boolean; prefillMs?: number; predictions?: MovePrediction[] }
  | { type: 'picked'; id: number; uci: string | null; p: number; ms: number; tokens: number }
  | { type: 'error'; id?: number; message: string };
