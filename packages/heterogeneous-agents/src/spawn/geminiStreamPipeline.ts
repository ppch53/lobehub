import type { AgentStreamEvent } from '@lobechat/agent-gateway-client';

import { GeminiAdapter } from '../adapters/gemini';
import { JsonlStreamProcessor } from './jsonlProcessor';
import { toStreamEvent } from './streamEvent';

export interface GeminiStreamPipelineOptions {
  operationId: string;
}

export type { AgentStreamEvent };

export class GeminiStreamPipeline {
  private readonly adapter = new GeminiAdapter();
  private readonly operationId: string;
  private readonly processor = new JsonlStreamProcessor();

  constructor(options: GeminiStreamPipelineOptions) {
    this.operationId = options.operationId;
  }

  get sessionId(): string | undefined {
    return this.adapter.sessionId;
  }

  push(chunk: Buffer | string): AgentStreamEvent[] {
    return this.processPayloads(this.processor.push(chunk));
  }

  flush(): AgentStreamEvent[] {
    return [
      ...this.processPayloads(this.processor.flush()),
      ...this.adapter.flush().map((event) => toStreamEvent(event, this.operationId)),
    ];
  }

  private processPayloads(payloads: unknown[]): AgentStreamEvent[] {
    return payloads.flatMap((payload) =>
      this.adapter.adapt(payload).map((event) => toStreamEvent(event, this.operationId)),
    );
  }
}
