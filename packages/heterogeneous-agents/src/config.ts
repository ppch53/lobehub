export type HeterogeneousCliAgentType = 'claude-code' | 'codex' | 'codex-app' | 'gemini-cli';

export type HeterogeneousAgentMenuLabelKey =
  | 'newClaudeCodeAgent'
  | 'newCodexAppAgent'
  | 'newCodexAgent'
  | 'newGeminiCliAgent';

export interface HeterogeneousAgentConfig {
  command: string;
  iconId: string;
  menuKey: string;
  menuLabelKey: HeterogeneousAgentMenuLabelKey;
  protocol?: string;
  spawnLocal?: boolean;
  title: string;
  type: HeterogeneousCliAgentType;
}

export const HETEROGENEOUS_AGENT_CONFIGS = [
  {
    command: 'claude',
    iconId: 'ClaudeCode',
    menuKey: 'newClaudeCodeAgent',
    menuLabelKey: 'newClaudeCodeAgent',
    title: 'Claude Code',
    type: 'claude-code',
  },
  {
    command: 'codex',
    iconId: 'Codex',
    menuKey: 'newCodexAgent',
    menuLabelKey: 'newCodexAgent',
    title: 'Codex',
    type: 'codex',
  },
  {
    command: 'codex',
    iconId: 'Codex',
    menuKey: 'newCodexAppAgent',
    menuLabelKey: 'newCodexAppAgent',
    protocol: 'codex-app-server',
    title: 'Codex App Server',
    type: 'codex-app',
  },
  {
    command: 'gemini',
    iconId: 'Gemini',
    menuKey: 'newGeminiCliAgent',
    menuLabelKey: 'newGeminiCliAgent',
    spawnLocal: true,
    title: 'Gemini CLI',
    type: 'gemini-cli',
  },
] as const satisfies readonly HeterogeneousAgentConfig[];

export const getHeterogeneousAgentConfig = (type: string) =>
  HETEROGENEOUS_AGENT_CONFIGS.find((config) => config.type === type);
