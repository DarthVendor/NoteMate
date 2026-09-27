import { useCallback, useEffect, useState } from 'react';
import { readJson, writeJson } from '../ui/storage';
import { DEFAULT_PRESET, presetLayout, sanitize, type Layout, type PresetId } from './layout';

const KEY = 'notemate.layout.v1';

function load(): Layout {
  const saved = readJson<unknown>(KEY);
  return saved ? sanitize(saved) : presetLayout(DEFAULT_PRESET);
}

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(load);
  useEffect(() => writeJson(KEY, layout), [layout]);
  const edit = useCallback((fn: (l: Layout) => Layout) => setLayout((l) => fn(l)), []);
  const applyPreset = useCallback((id: PresetId) => setLayout(presetLayout(id)), []);
  const reset = useCallback(() => setLayout(presetLayout(DEFAULT_PRESET)), []);
  return { layout, edit, applyPreset, reset };
}

export type LayoutApi = ReturnType<typeof useLayout>;
