import type {
  AgentCLIPreset,
  AgentEventAdapter,
  HeterogeneousAgentEvent,
  HeterogeneousTerminalErrorData,
  StepCompleteData,
  ToolCallPayload,
  ToolResultData,
  UsageData,
} from '../types';

const GEMINI_IDENTIFIER = 'gemini-cli';

type GeminiStreamStatus = 'error' | 'success';

interface GeminiStreamStats {
  cached?: number;
  duration_ms?: number;
  input?: number;
  input_tokens?: number;
  models?: Record<
    string,
    {
      cached?: number;
      input?: number;
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    }
  >;
  output_tokens?: number;
  tool_calls?: number;
  total_tokens?: number;
}

export const geminiPreset: AgentCLIPreset = {
  baseArgs: ['--output-format', 'stream-json', '--approval-mode', 'yolo'],
  promptMode: 'positional',
  resumeArgs: (sessionId) => ['--resume', sessionId],
};

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const toUsageData = (stats: GeminiStreamStats | undefined): UsageData | undefined => {
  if (!stats) return undefined;

  const totalInputTokens = stats.input_tokens ?? stats.input ?? 0;
  const inputCachedTokens = stats.cached ?? 0;
  const inputCacheMissTokens = Math.max(totalInputTokens - inputCachedTokens, 0);
  const totalOutputTokens = stats.output_tokens ?? 0;
  const totalTokens = stats.total_tokens ?? totalInputTokens + totalOutputTokens;

  if (totalTokens === 0) return undefined;

  return {
    inputCachedTokens: inputCachedTokens || undefined,
    inputCacheMissTokens,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
  };
};

const firstModelFromStats = (stats: GeminiStreamStats | undefined): string | undefined => {
  const models = stats?.models;
  if (!models) return undefined;
  return Object.keys(models)[0];
};

const toToolPayload = (raw: any): ToolCallPayload => ({
  apiName: getString(raw.tool_name) || 'tool_use',
  arguments: JSON.stringify(raw.parameters ?? {}),
  id: getString(raw.tool_id) || `gemini-tool-${Date.now()}`,
  identifier: GEMINI_IDENTIFIER,
  type: 'default',
});

const toolResultContent = (raw: any): string => {
  if (typeof raw.output === 'string') return raw.output;
  if (raw.error?.message) return String(raw.error.message);
  if (raw.output !== undefined) return JSON.stringify(raw.output);
  return raw.status === 'success' ? 'Tool completed.' : 'Tool failed.';
};

const toToolResultData = (raw: any): ToolResultData => ({
  content: toolResultContent(raw),
  isError: raw.status === 'error',
  toolCallId: getString(raw.tool_id) || '',
});

const toTerminalError = (raw: any): HeterogeneousTerminalErrorData => {
  const message =
    getString(raw.error?.message) ||
    getString(raw.message) ||
    getString(raw.error) ||
    'Gemini CLI execution failed';

  return {
    agentType: GEMINI_IDENTIFIER,
    clearEchoedContent: true,
    code: getString(raw.error?.type),
    error: message,
    message,
    stderr: message,
  };
};

export class GeminiAdapter implements AgentEventAdapter {
  sessionId?: string;

  private currentModel?: string;
  private pendingToolCalls = new Set<string>();
  private started = false;
  private stepIndex = 0;
  private stepToolCallIds = new Set<string>();
  private stepToolCalls: ToolCallPayload[] = [];
  private terminalEmitted = false;

  adapt(raw: any): HeterogeneousAgentEvent[] {
    if (!raw || typeof raw !== 'object') return [];

    switch (raw.type) {
      case 'init': {
        return this.handleInit(raw);
      }
      case 'message': {
        return this.handleMessage(raw);
      }
      case 'tool_use': {
        return this.handleToolUse(raw);
      }
      case 'tool_result': {
        return this.handleToolResult(raw);
      }
      case 'error': {
        return [this.makeEvent('error', toTerminalError(raw))];
      }
      case 'result': {
        return this.handleResult(raw);
      }
      default: {
        return [];
      }
    }
  }

  flush(): HeterogeneousAgentEvent[] {
    const events = [...this.pendingToolCalls].map((toolCallId) =>
      this.makeEvent('tool_end', {
        isSuccess: false,
        toolCallId,
      }),
    );
    this.pendingToolCalls.clear();
    return events;
  }

  private ensureStarted(): HeterogeneousAgentEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      this.makeEvent('stream_start', { model: this.currentModel, provider: GEMINI_IDENTIFIER }),
    ];
  }

  private handleInit(raw: any): HeterogeneousAgentEvent[] {
    this.sessionId = getString(raw.session_id);
    this.currentModel = getString(raw.model) || this.currentModel;
    return this.ensureStarted();
  }

  private handleMessage(raw: any): HeterogeneousAgentEvent[] {
    if (raw.role !== 'assistant') return [];
    const content = getString(raw.content);
    if (!content) return [];

    return [
      ...this.ensureStarted(),
      this.makeEvent('stream_chunk', {
        chunkType: 'text',
        content,
      }),
    ];
  }

  private handleToolUse(raw: any): HeterogeneousAgentEvent[] {
    const tool = toToolPayload(raw);
    if (!tool.id) return [];

    this.pendingToolCalls.add(tool.id);
    if (!this.stepToolCallIds.has(tool.id)) {
      this.stepToolCallIds.add(tool.id);
      this.stepToolCalls.push(tool);
    }

    return [
      ...this.ensureStarted(),
      this.makeEvent('stream_chunk', {
        chunkType: 'tools_calling',
        toolsCalling: [...this.stepToolCalls],
      }),
      this.makeEvent('tool_start', {
        toolCallId: tool.id,
        toolCalling: tool,
      }),
    ];
  }

  private handleToolResult(raw: any): HeterogeneousAgentEvent[] {
    const data = toToolResultData(raw);
    if (!data.toolCallId) return [];

    const isSuccess = raw.status !== 'error';
    this.pendingToolCalls.delete(data.toolCallId);

    this.stepIndex += 1;
    this.stepToolCalls = [];
    this.stepToolCallIds.clear();

    return [
      this.makeEvent('tool_result', data),
      this.makeEvent('tool_end', {
        isSuccess,
        toolCallId: data.toolCallId,
      }),
      this.makeEvent('stream_end', {}),
      this.makeEvent('stream_start', {
        model: this.currentModel,
        newStep: true,
        provider: GEMINI_IDENTIFIER,
      }),
    ];
  }

  private handleResult(raw: any): HeterogeneousAgentEvent[] {
    if (this.terminalEmitted) return [];
    this.terminalEmitted = true;

    const status = raw.status as GeminiStreamStatus | undefined;
    const stats = raw.stats as GeminiStreamStats | undefined;
    const model = this.currentModel || firstModelFromStats(stats);
    if (model) this.currentModel = model;

    const events = [...this.ensureStarted()];
    const usage = toUsageData(stats);
    if (usage || model) {
      events.push(
        this.makeEvent('step_complete', {
          ...(model ? { model } : {}),
          phase: 'turn_metadata',
          provider: GEMINI_IDENTIFIER,
          ...(usage ? { usage } : {}),
        } satisfies StepCompleteData),
      );
    }

    events.push(this.makeEvent('stream_end', {}));
    events.push(
      status === 'error'
        ? this.makeEvent('error', toTerminalError(raw))
        : this.makeEvent('agent_runtime_end', {}),
    );

    return events;
  }

  private makeEvent(type: HeterogeneousAgentEvent['type'], data: any): HeterogeneousAgentEvent {
    return {
      data,
      stepIndex: this.stepIndex,
      timestamp: Date.now(),
      type,
    };
  }
}
