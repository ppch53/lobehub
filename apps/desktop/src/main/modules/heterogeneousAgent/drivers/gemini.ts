import type { HeterogeneousAgentBuildPlanParams, HeterogeneousAgentDriver } from '../types';

const GEMINI_REQUIRED_ARGS = ['--output-format', 'stream-json', '--approval-mode', 'yolo'] as const;

const collectText = (prompt: string) => prompt;

export const geminiDriver: HeterogeneousAgentDriver = {
  async buildSpawnPlan({ args, prompt, resumeSessionId }: HeterogeneousAgentBuildPlanParams) {
    return {
      args: [
        ...GEMINI_REQUIRED_ARGS,
        ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        '--prompt',
        collectText(prompt),
        ...args,
      ],
    };
  },
};
