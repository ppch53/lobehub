import { describe, expect, it } from 'vitest';

import { CodexAppServerPipeline } from './codexAppServerPipeline';

describe('CodexAppServerPipeline', () => {
  it('maps app-server lifecycle, text deltas, and usage into stream events', () => {
    const pipeline = new CodexAppServerPipeline({ operationId: 'op-1' });

    const threadEvents = pipeline.pushMessage({
      method: 'thread/started',
      params: { thread: { id: 'thread-1' } },
    });
    expect(threadEvents).toEqual([]);
    expect(pipeline.sessionId).toBe('thread-1');

    const started = pipeline.pushMessage({
      method: 'turn/started',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(started).toMatchObject([
      {
        data: { provider: 'codex' },
        operationId: 'op-1',
        stepIndex: 0,
        type: 'stream_start',
      },
    ]);

    const text = pipeline.pushMessage({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'READY',
        itemId: 'msg-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });
    expect(text).toMatchObject([
      {
        data: { chunkType: 'text', content: 'READY' },
        operationId: 'op-1',
        stepIndex: 0,
        type: 'stream_chunk',
      },
    ]);

    const duplicateFinalMessage = pipeline.pushMessage({
      method: 'item/completed',
      params: {
        item: {
          id: 'msg-1',
          memoryCitation: null,
          phase: null,
          text: 'READY',
          type: 'agentMessage',
        },
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    });
    expect(duplicateFinalMessage).toEqual([]);

    pipeline.pushMessage({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          last: {
            cachedInputTokens: 4,
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        },
      },
    });

    const completed = pipeline.pushMessage({
      method: 'turn/completed',
      params: { turn: { status: 'completed' } },
    });
    expect(completed).toMatchObject([
      {
        data: {
          phase: 'turn_metadata',
          provider: 'codex',
          usage: {
            inputCachedTokens: 4,
            inputCacheMissTokens: 6,
            totalInputTokens: 10,
            totalOutputTokens: 2,
            totalTokens: 12,
          },
        },
        operationId: 'op-1',
        stepIndex: 0,
        type: 'step_complete',
      },
    ]);
    expect(pipeline.turnCompleted).toBe(true);
  });

  it('streams plan and command-output deltas on the current step', () => {
    const pipeline = new CodexAppServerPipeline({ operationId: 'op-2' });

    pipeline.pushMessage({ method: 'turn/started', params: { turnId: 'turn-1' } });
    const plan = pipeline.pushMessage({
      method: 'item/plan/delta',
      params: { delta: 'Check the repo.', itemId: 'plan-1' },
    });
    expect(plan).toMatchObject([
      {
        data: { chunkType: 'reasoning', reasoning: 'Check the repo.' },
        stepIndex: 0,
        type: 'stream_chunk',
      },
    ]);

    const duplicatePlan = pipeline.pushMessage({
      method: 'item/completed',
      params: { item: { id: 'plan-1', text: 'Check the repo.', type: 'plan' } },
    });
    expect(duplicatePlan).toEqual([]);

    pipeline.pushMessage({ method: 'turn/started', params: { turnId: 'turn-2' } });
    const output = pipeline.pushMessage({
      method: 'item/commandExecution/outputDelta',
      params: { delta: 'done\n', itemId: 'cmd-1' },
    });
    expect(output).toMatchObject([
      {
        data: { chunkType: 'text', content: 'done\n' },
        operationId: 'op-2',
        stepIndex: 1,
        type: 'stream_chunk',
      },
    ]);
  });
});
