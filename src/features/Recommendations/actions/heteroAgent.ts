import { type HeterogeneousAgentClientConfig } from '@lobechat/heterogeneous-agents/client';
import { ClaudeCode, Codex, Gemini } from '@lobehub/icons';
import { createElement } from 'react';

import type { RecommendedAction } from './types';

const avatarIcons = {
  'claude-code': ClaudeCode.Avatar,
  'codex': Codex.Avatar,
  'codex-app': Codex.Avatar,
  'gemini-cli': Gemini.Avatar,
} as const;

/**
 * Build a "Add <Brand> agent" recommendation card for a heterogeneous CLI agent
 * (Claude Code, Codex, …). Eligible only on desktop, when the local CLI is
 * detected, and when the user hasn't already added an agent of that type.
 */
export const buildHeteroAgentAction = (
  config: HeterogeneousAgentClientConfig,
): RecommendedAction => {
  const Avatar = avatarIcons[config.type as keyof typeof avatarIcons] ?? ClaudeCode.Avatar;

  return {
    ctaKey: 'recommendations.heteroAgent.cta',
    descriptionKey: 'recommendations.heteroAgent.description',
    execute: (ctx) => ctx.createHeteroAgent(config),
    i18nValues: { name: config.title },
    icon: createElement(Avatar, {
      shape: 'square',
      size: 28,
      style: { borderRadius: 8 },
    }),
    id: `hetero-agent:${config.type}`,
    isEligible: (ctx) => {
      if (!ctx.isDesktop) return false;
      if (!ctx.heteroDetections[config.type]?.available) return false;
      return !ctx.agents.some((a) => a.heterogeneousType === config.type);
    },
    priority: 10,
    tagKey: 'recommendations.heteroAgent.tag',
    titleKey: 'recommendations.heteroAgent.title',
  };
};
