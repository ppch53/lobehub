import { describe, expect, it } from 'vitest';

import { getHeterogeneousAgentConfig, HETEROGENEOUS_AGENT_CONFIGS } from './config';
import { HETEROGENEOUS_TYPE_LABELS } from './labels';

describe('heterogeneous agent config', () => {
  it('defines create config for all registered agent types', () => {
    expect(HETEROGENEOUS_AGENT_CONFIGS.map((config) => config.type)).toEqual([
      'claude-code',
      'codex',
      'codex-app',
      'gemini-cli',
    ]);
  });

  it('resolves config by type', () => {
    expect(getHeterogeneousAgentConfig('claude-code')).toMatchObject({
      command: 'claude',
      title: 'Claude Code',
      type: 'claude-code',
    });
    expect(getHeterogeneousAgentConfig('codex')).toMatchObject({
      command: 'codex',
      title: 'Codex',
      type: 'codex',
    });
    expect(getHeterogeneousAgentConfig('codex-app')).toMatchObject({
      command: 'codex',
      protocol: 'codex-app-server',
      title: 'Codex App Server',
      type: 'codex-app',
    });
    expect(getHeterogeneousAgentConfig('gemini-cli')).toMatchObject({
      command: 'gemini',
      spawnLocal: true,
      title: 'Gemini CLI',
      type: 'gemini-cli',
    });
  });

  it('derives display labels from the shared config source', () => {
    expect(HETEROGENEOUS_TYPE_LABELS).toEqual({
      'claude-code': 'Claude Code',
      'codex': 'Codex',
      'codex-app': 'Codex App Server',
      'gemini-cli': 'Gemini CLI',
    });
  });
});
