import { kvs } from '@forge/kvs';

export interface AppSettings {
  /** Space keys the admin marked as clinical content for impact mapping. */
  clinicalSpaceKeys: string[];
  /** When true, sync may create Jira work items and page notices. */
  autoCreateResponses: boolean;
  /** Optional openFDA API key (raises rate limits; not required). */
  openfdaApiKey?: string;
  /** Jira project key responses are created in. */
  responseProjectKey?: string;
  /** Setup wizard completed. */
  setupComplete: boolean;
}

const KEY = 'settings';

export const DEFAULT_SETTINGS: AppSettings = {
  clinicalSpaceKeys: [],
  autoCreateResponses: false,
  setupComplete: false,
};

export async function getSettings(): Promise<AppSettings> {
  const stored = (await kvs.get(KEY)) as Partial<AppSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch };
  await kvs.set(KEY, next);
  return next;
}
