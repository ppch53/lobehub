import { claudeCodeDriver } from './drivers/claudeCode';
import { codexDriver } from './drivers/codex';
import { geminiDriver } from './drivers/gemini';
import type { HeterogeneousAgentDriver } from './types';

const heterogeneousAgentDrivers: Record<string, HeterogeneousAgentDriver> = {
  'claude-code': claudeCodeDriver,
  'codex': codexDriver,
  'gemini-cli': geminiDriver,
};

export const getHeterogeneousAgentDriver = (agentType: string): HeterogeneousAgentDriver => {
  const driver = heterogeneousAgentDrivers[agentType];

  if (!driver) {
    throw new Error(`Unknown heterogeneous agent type: ${agentType}`);
  }

  return driver;
};
