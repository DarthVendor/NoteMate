/*
 * The integrated right-hand panel: engine strip and ChessMind's predicted moves on top, the move tree in the middle,
 * the ChessMind chat below (a draggable divider between them). Everything follows the current position.
 * On a phone the move tree and the chat share the space as two tabs.
 */
import { useEffect, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ListTree, MessageSquareText } from 'lucide-react';
import { useApp } from '../app/AppContext';
import { MoveList } from '../components/MoveList';
import { EraseMenu } from '../components/EraseMenu';
import { ChessMindPanel } from '../chessmind/ChessMindPanel';
import { PredictionChips } from '../chessmind/Predictions';
import { EngineStrip } from './EngineStrip';
import { Segmented } from '../ui/primitives';
import { useMediaQuery } from '../ui/settings';
import { readJson, writeJson } from '../ui/storage';

const KEY = 'notemate.analysis.v1';
/** Event that asks the panel to show the chat (phone tab), e.g. from "Ask ChessMind…". */
export const FOCUS_CHAT_EVENT = 'notemate:focus-chat';

interface Prefs {
  engineExpanded: boolean;
  /** Share of the moves area (percent) when the chat is open. */
  movesSize: number;
  phoneTab: 'moves' | 'chat';
}
const DEFAULTS: Prefs = { engineExpanded: false, movesSize: 40, phoneTab: 'moves' };

function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(() => ({ ...DEFAULTS, ...(readJson<Partial<Prefs>>(KEY) ?? {}) }));
  useEffect(() => writeJson(KEY, prefs), [prefs]);
  return [prefs, (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }))] as const;
}

export function AnalysisPanel() {
  const app = useApp();
  const { state, dispatch, chess, fen, uciMoves, playUci, flip, chessmind, openImport } = app;
  const [prefs, setPref] = usePrefs();
  const phone = useMediaQuery('(max-width: 760px)');

  useEffect(() => {
    const show = () => setPref({ phoneTab: 'chat' });
    window.addEventListener(FOCUS_CHAT_EVENT, show);
    return () => window.removeEventListener(FOCUS_CHAT_EVENT, show);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const moves = (
    <div className="an-moves">
      <MoveList state={state} dispatch={dispatch} onImport={openImport} tools={<EraseMenu />} />
    </div>
  );
  const chat = <ChessMindPanel cm={chessmind} state={state} dispatch={dispatch} chess={chess} fen={fen} uciMoves={uciMoves} onFlip={flip} />;
  const chatOpen = chessmind.settings.enabled;

  let main: React.ReactNode;
  if (phone) {
    main = (
      <>
        <div className="an-tabs">
          <Segmented<'moves' | 'chat'>
            label="Show"
            value={prefs.phoneTab}
            onChange={(phoneTab) => setPref({ phoneTab })}
            options={[
              { value: 'moves', label: <><ListTree size={12} /> Moves</> },
              { value: 'chat', label: <><MessageSquareText size={12} /> ChessMind</> },
            ]}
          />
        </div>
        <div className="an-phone-body">{prefs.phoneTab === 'moves' ? moves : chat}</div>
      </>
    );
  } else if (!chatOpen) {
    // Model not loaded: the moves take the space and the chat is a one-line invitation at the bottom.
    main = (
      <>
        <div className="an-fill">{moves}</div>
        <div className="an-chat an-chat-closed">{chat}</div>
      </>
    );
  } else {
    main = (
      <Group
        className="an-split"
        orientation="vertical"
        defaultLayout={{ moves: prefs.movesSize, chat: 100 - prefs.movesSize }}
        onLayoutChanged={(l, meta) => {
          if (!meta.isUserInteraction) return;
          const r = meta.requestedLayout ?? l;
          if (typeof r.moves === 'number') setPref({ movesSize: Math.round(r.moves * 10) / 10 });
        }}
      >
        <Panel id="moves" minSize="72px">
          {moves}
        </Panel>
        <Separator className="dock-sep an-sep" />
        <Panel id="chat" minSize="200px">
          <div className="an-chat">{chat}</div>
        </Panel>
      </Group>
    );
  }

  return (
    <div className="an" data-testid="analysis-panel">
      <div className="an-top">
        <EngineStrip expanded={prefs.engineExpanded} onToggleExpanded={() => setPref({ engineExpanded: !prefs.engineExpanded })} />
        <PredictionChips cm={chessmind} state={state} dispatch={dispatch} fen={fen} standardStart={uciMoves !== null} onPlayUci={playUci} />
      </div>
      {main}
    </div>
  );
}
