import { readJson, writeJson } from '../ui/storage';

const KEY = 'notemate.onboarding.v1';
export const onboardingDismissed = () => readJson<{ dismissed: boolean }>(KEY)?.dismissed ?? false;
export const setOnboardingDismissed = (dismissed: boolean) => writeJson(KEY, { dismissed });
