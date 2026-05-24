import { describe, expect, it } from 'vitest';

import { GeminiAdapter } from './gemini';

describe('GeminiAdapter', () => {
  it('captures session id and starts a stream from init', () => {
    const adapter = new GeminiAdapter();

    const events = adapter.adapt({
      model: 'gemini-3-pro',
      session_id: 'gemini-session-1',
      type: 'init',
    });

    expect(adapter.sessionId).toBe('gemini-session-1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      data: { model: 'gemini-3-pro', provider: 'gemini-cli' },
      stepIndex: 0,
      type: 'stream_start',
    });
  });

  it('emits assistant text chunks and ignores user echoes', () => {
    const adapter = new GeminiAdapter();

    expect(adapter.adapt({ content: 'echo', role: 'user', type: 'message' })).toEqual([]);
    const events = adapter.adapt({
      content: 'hello from gemini',
      delta: true,
      role: 'assistant',
      type: 'message',
    });

    expect(events.map((event) => event.type)).toEqual(['stream_start', 'stream_chunk']);
    expect(events[1]).toMatchObject({
      data: { chunkType: 'text', content: 'hello from gemini' },
      type: 'stream_chunk',
    });
  });

  it('maps tool use and tool result events', () => {
    const adapter = new GeminiAdapter();

    const toolUse = adapter.adapt({
      parameters: { command: 'pwd' },
      tool_id: 'tool-1',
      tool_name: 'run_shell_command',
      type: 'tool_use',
    });

    expect(toolUse.map((event) => event.type)).toEqual([
      'stream_start',
      'stream_chunk',
      'tool_start',
    ]);
    expect(toolUse[1].data.toolsCalling).toEqual([
      {
        apiName: 'run_shell_command',
        arguments: '{"command":"pwd"}',
        id: 'tool-1',
        identifier: 'gemini-cli',
        type: 'default',
      },
    ]);

    const toolResult = adapter.adapt({
      output: '/workspace',
      status: 'success',
      tool_id: 'tool-1',
      type: 'tool_result',
    });

    expect(toolResult.map((event) => event.type)).toEqual([
      'tool_result',
      'tool_end',
      'stream_end',
      'stream_start',
    ]);
    expect(toolResult[0]).toMatchObject({
      data: { content: '/workspace', isError: false, toolCallId: 'tool-1' },
      stepIndex: 1,
      type: 'tool_result',
    });
    expect(toolResult[3]).toMatchObject({
      data: { newStep: true, provider: 'gemini-cli' },
      stepIndex: 1,
      type: 'stream_start',
    });
  });

  it('emits usage metadata and terminal end on success result', () => {
    const adapter = new GeminiAdapter();
    adapter.adapt({ model: 'gemini-3-pro', session_id: 's1', type: 'init' });

    const events = adapter.adapt({
      stats: {
        cached: 3,
        duration_ms: 1200,
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
      status: 'success',
      type: 'result',
    });

    expect(events.map((event) => event.type)).toEqual([
      'step_complete',
      'stream_end',
      'agent_runtime_end',
    ]);
    expect(events[0]).toMatchObject({
      data: {
        model: 'gemini-3-pro',
        phase: 'turn_metadata',
        provider: 'gemini-cli',
        usage: {
          inputCachedTokens: 3,
          inputCacheMissTokens: 7,
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalTokens: 15,
        },
      },
      type: 'step_complete',
    });
  });

  it('emits terminal error on error result', () => {
    const adapter = new GeminiAdapter();

    const events = adapter.adapt({
      error: { message: 'auth required', type: 'auth_required' },
      status: 'error',
      type: 'result',
    });

    expect(events.map((event) => event.type)).toEqual(['stream_start', 'stream_end', 'error']);
    expect(events[2]).toMatchObject({
      data: {
        agentType: 'gemini-cli',
        clearEchoedContent: true,
        code: 'auth_required',
        message: 'auth required',
      },
      type: 'error',
    });
  });
});
