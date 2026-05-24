import type { AgentStreamEvent } from '@lobechat/agent-gateway-client';

import { CodexAdapter } from '../adapters/codex';
import type { HeterogeneousAgentEvent, UsageData } from '../types';
import { JsonlStreamProcessor } from './jsonlProcessor';
import { toStreamEvent } from './streamEvent';

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const toSnakeStatus = (status: unknown): string | undefined => {
  switch (status) {
    case 'completed': {
      return 'completed';
    }
    case 'failed':
    case 'declined': {
      return 'failed';
    }
    case 'inProgress': {
      return 'in_progress';
    }
    default: {
      return typeof status === 'string' ? status : undefined;
    }
  }
};

const toCodexUsage = (raw: any): UsageData | undefined => {
  const usage = raw?.last || raw?.total || raw;
  if (!isRecord(usage)) return;

  const totalInputTokens = Number(usage.inputTokens) || 0;
  const inputCachedTokens = Number(usage.cachedInputTokens) || 0;
  const totalOutputTokens = Number(usage.outputTokens) || 0;

  if (totalInputTokens + totalOutputTokens === 0) return;

  return {
    inputCachedTokens: inputCachedTokens || undefined,
    inputCacheMissTokens: Math.max(totalInputTokens - inputCachedTokens, 0),
    totalInputTokens,
    totalOutputTokens,
    totalTokens: Number(usage.totalTokens) || totalInputTokens + totalOutputTokens,
  };
};

const toCodexAdapterUsage = (usage: UsageData | undefined) =>
  usage
    ? {
        cached_input_tokens: usage.inputCachedTokens ?? 0,
        input_tokens: usage.inputCacheMissTokens,
        output_tokens: usage.totalOutputTokens,
      }
    : undefined;

const normalizeFileChanges = (changes: any[] | undefined) =>
  (changes || []).map((change) => ({
    kind: change?.kind,
    path: change?.path,
  }));

const normalizeReasoningText = (item: any): string | undefined => {
  if (!isRecord(item) || typeof item.id !== 'string') return;

  if (item.type === 'plan') {
    return typeof item.text === 'string' && item.text ? item.text : undefined;
  }

  if (item.type === 'reasoning') {
    const content =
      Array.isArray(item.content) && item.content.length > 0
        ? item.content
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join('')
        : '';
    if (content) return content;

    const summary =
      Array.isArray(item.summary) && item.summary.length > 0
        ? item.summary
            .filter((part): part is string => typeof part === 'string' && part.length > 0)
            .join('')
        : '';
    if (summary) return summary;
  }

  return;
};

const normalizeThreadItem = (item: any): any | undefined => {
  if (!isRecord(item) || typeof item.id !== 'string') return;

  switch (item.type) {
    case 'agentMessage': {
      return {
        id: item.id,
        text: typeof item.text === 'string' ? item.text : '',
        type: 'agent_message',
      };
    }

    case 'plan': {
      return {
        id: item.id,
        text: typeof item.text === 'string' ? item.text : '',
        type: 'plan',
      };
    }

    case 'reasoning': {
      return {
        content: item.content,
        id: item.id,
        summary: item.summary,
        type: 'reasoning',
      };
    }

    case 'commandExecution': {
      return {
        aggregated_output: item.aggregatedOutput ?? '',
        command: item.command ?? '',
        exit_code: item.exitCode ?? null,
        id: item.id,
        status: toSnakeStatus(item.status),
        type: 'command_execution',
      };
    }

    case 'fileChange': {
      return {
        changes: normalizeFileChanges(item.changes),
        id: item.id,
        status: toSnakeStatus(item.status),
        type: 'file_change',
      };
    }

    case 'collabAgentToolCall': {
      return {
        agents_states: item.agentsStates ?? {},
        id: item.id,
        prompt: item.prompt ?? null,
        receiver_thread_ids: item.receiverThreadIds ?? [],
        sender_thread_id: item.senderThreadId,
        status: toSnakeStatus(item.status),
        tool: item.tool,
        type: 'collab_tool_call',
      };
    }

    case 'dynamicToolCall':
    case 'mcpToolCall': {
      return {
        id: item.id,
        status: toSnakeStatus(item.status),
        type: item.type,
        ...item,
      };
    }

    default: {
      return;
    }
  }
};

export interface CodexAppServerPipelineOptions {
  operationId: string;
}

export class CodexAppServerPipeline {
  private readonly adapter = new CodexAdapter();
  private currentModel?: string;
  private readonly deltaBackedAgentItems = new Set<string>();
  private readonly deltaBackedPlanItems = new Set<string>();
  private readonly deltaBackedReasoningItems = new Set<string>();
  private lastUsage?: UsageData;
  private readonly operationId: string;
  private readonly processor = new JsonlStreamProcessor();
  private turnDone = false;
  private currentStepIndex = 0;

  constructor(options: CodexAppServerPipelineOptions) {
    this.operationId = options.operationId;
  }

  get sessionId(): string | undefined {
    return this.adapter.sessionId;
  }

  get turnCompleted(): boolean {
    return this.turnDone;
  }

  flush(): AgentStreamEvent[] {
    return [
      ...this.processPayloads(this.processor.flush()),
      ...this.trackEvents(
        this.adapter.flush().map((event) => toStreamEvent(event, this.operationId)),
      ),
    ];
  }

  push(chunk: Buffer | string): AgentStreamEvent[] {
    return this.processPayloads(this.processor.push(chunk));
  }

  pushMessage(message: unknown): AgentStreamEvent[] {
    return this.processPayloads([message]);
  }

  private adaptCodexRaw(raw: any): AgentStreamEvent[] {
    return this.trackEvents(
      this.adapter.adapt(raw).map((event) => toStreamEvent(event, this.operationId)),
    );
  }

  private directEvent(type: HeterogeneousAgentEvent['type'], data: any): AgentStreamEvent {
    return toStreamEvent(
      {
        data,
        stepIndex: this.currentStepIndex,
        timestamp: Date.now(),
        type,
      },
      this.operationId,
    );
  }

  private trackEvents(events: AgentStreamEvent[]): AgentStreamEvent[] {
    const lastEvent = events.at(-1);
    if (lastEvent) this.currentStepIndex = lastEvent.stepIndex;
    return events;
  }

  private handleMethod(method: string, params: any): AgentStreamEvent[] {
    switch (method) {
      case 'thread/started': {
        const threadId = params?.thread?.id;
        if (typeof threadId !== 'string') return [];
        return this.adaptCodexRaw({ thread_id: threadId, type: 'thread.started' });
      }

      case 'turn/started': {
        return this.adaptCodexRaw({ type: 'turn.started' });
      }

      case 'turn/completed': {
        this.turnDone = true;
        if (params?.turn?.status === 'failed') {
          return this.adaptCodexRaw({
            error: params.turn.error,
            message: params.turn.error?.message,
            type: 'turn.failed',
          });
        }

        return this.adaptCodexRaw({
          model: this.currentModel,
          type: 'turn.completed',
          usage: toCodexAdapterUsage(this.lastUsage),
        });
      }

      case 'item/agentMessage/delta': {
        const itemId = params?.itemId;
        const delta = params?.delta;
        if (typeof itemId !== 'string' || typeof delta !== 'string' || !delta) return [];
        this.deltaBackedAgentItems.add(itemId);
        return this.adaptCodexRaw({
          item: { id: itemId, text: delta, type: 'agent_message' },
          type: 'item.completed',
        });
      }

      case 'item/plan/delta': {
        const itemId = params?.itemId;
        const delta = params?.delta;
        if (typeof itemId !== 'string' || typeof delta !== 'string' || !delta) return [];
        this.deltaBackedPlanItems.add(itemId);
        return [this.directEvent('stream_chunk', { chunkType: 'reasoning', reasoning: delta })];
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const itemId = params?.itemId;
        const delta = params?.delta;
        if (typeof itemId !== 'string' || typeof delta !== 'string' || !delta) return [];
        this.deltaBackedReasoningItems.add(itemId);
        return [this.directEvent('stream_chunk', { chunkType: 'reasoning', reasoning: delta })];
      }

      case 'item/started': {
        const item = normalizeThreadItem(params?.item);
        if (!item) return [];
        if (item.type === 'plan' || item.type === 'reasoning') return [];
        return this.adaptCodexRaw({ item, type: 'item.started' });
      }

      case 'item/completed': {
        const item = normalizeThreadItem(params?.item);
        if (!item) return [];
        if (item.type === 'agent_message' && this.deltaBackedAgentItems.has(item.id)) return [];
        if (item.type === 'plan' && this.deltaBackedPlanItems.has(item.id)) return [];
        if (item.type === 'reasoning' && this.deltaBackedReasoningItems.has(item.id)) return [];
        if (item.type === 'plan' || item.type === 'reasoning') {
          const reasoning = normalizeReasoningText(params?.item);
          if (!reasoning) return [];
          return [this.directEvent('stream_chunk', { chunkType: 'reasoning', reasoning })];
        }
        return this.adaptCodexRaw({ item, type: 'item.completed' });
      }

      case 'item/commandExecution/outputDelta': {
        const delta = params?.delta;
        if (typeof delta !== 'string' || !delta) return [];
        return [this.directEvent('stream_chunk', { chunkType: 'text', content: delta })];
      }

      case 'thread/tokenUsage/updated': {
        this.lastUsage = toCodexUsage(params?.tokenUsage);
        return [];
      }

      case 'error': {
        return this.adaptCodexRaw({
          error: params,
          message: params?.message,
          type: 'error',
        });
      }

      default: {
        return [];
      }
    }
  }

  private handleResponse(message: Record<string, any>): AgentStreamEvent[] {
    if (message.error) {
      return this.adaptCodexRaw({
        error: message.error,
        message: message.error?.message,
        type: 'error',
      });
    }

    const result = message.result;
    if (!isRecord(result)) return [];

    if (typeof result.model === 'string') this.currentModel = result.model;

    const threadId = result.thread?.id;
    if (typeof threadId === 'string') {
      return this.adaptCodexRaw({ thread_id: threadId, type: 'thread.started' });
    }

    return [];
  }

  private processPayloads(payloads: unknown[]): AgentStreamEvent[] {
    return payloads.flatMap((payload) => {
      if (!isRecord(payload)) return [];

      if (typeof payload.method === 'string')
        return this.handleMethod(payload.method, payload.params);
      if ('id' in payload) return this.handleResponse(payload);

      return [];
    });
  }
}
