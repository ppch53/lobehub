import type { IconType } from '@lobehub/icons';
import { ClaudeCode, Codex, Gemini, getLobeIconCDN } from '@lobehub/icons';

import {
  getHeterogeneousAgentConfig,
  HETEROGENEOUS_AGENT_CONFIGS,
  type HeterogeneousAgentConfig,
} from '../config';

export interface HeterogeneousAgentClientConfig extends HeterogeneousAgentConfig {
  avatar: string;
  icon: IconType;
}

type KnownHeterogeneousAgentType = (typeof HETEROGENEOUS_AGENT_CONFIGS)[number]['type'];

const heterogeneousAgentIcons = {
  'claude-code': ClaudeCode,
  'codex': Codex,
  'codex-app': Codex,
  'gemini-cli': Gemini,
} as const satisfies Record<KnownHeterogeneousAgentType, IconType>;

const createAgentAvatar = (iconId: string) =>
  getLobeIconCDN(iconId, {
    cdn: 'aliyun',
    format: 'avatar',
  });

const resolveHeterogeneousAgentIcon = (type: string): IconType =>
  heterogeneousAgentIcons[type as KnownHeterogeneousAgentType] ?? ClaudeCode;

export const HETEROGENEOUS_AGENT_CLIENT_CONFIGS = HETEROGENEOUS_AGENT_CONFIGS.map((config) => ({
  ...config,
  avatar: createAgentAvatar(config.iconId),
  icon: resolveHeterogeneousAgentIcon(config.type),
})) as readonly HeterogeneousAgentClientConfig[];

export const getHeterogeneousAgentClientConfig = (type: HeterogeneousAgentConfig['type']) => {
  const config = getHeterogeneousAgentConfig(type);

  if (!config) return undefined;

  return {
    ...config,
    avatar: createAgentAvatar(config.iconId),
    icon: resolveHeterogeneousAgentIcon(config.type),
  } satisfies HeterogeneousAgentClientConfig;
};
