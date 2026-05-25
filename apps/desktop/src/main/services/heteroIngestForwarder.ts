import type { AgentStreamEvent } from '@lobechat/heterogeneous-agents/spawn';

import { createLogger } from '@/utils/logger';
import { netFetch } from '@/utils/net-fetch';

const logger = createLogger('services:HeteroIngestForwarder');

const MAX_BATCH = 50;
const FLUSH_INTERVAL_MS = 250;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 500;

export interface HeteroIngestForwarderOptions {
  agentType: string;
  jwt: string;
  operationId: string;
  serverUrl: string;
  topicId: string;
}

/**
 * Buffers AgentStreamEvents and POSTs them to the server's tRPC
 * `aiAgent.heteroIngest` mutation. Mirrors the CLI's BatchIngester
 * logic (flush at 50 events or every 250ms, retry with backoff).
 *
 * Used by GatewayConnectionCtr to forward events from desktop-spawned
 * CLIs back to the server so the browser SSE stream receives them.
 */
export class HeteroIngestForwarder {
  private readonly agentType: string;
  private readonly jwt: string;
  private readonly operationId: string;
  private readonly serverUrl: string;
  private readonly topicId: string;

  private buffer: AgentStreamEvent[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private inflightFlush: Promise<void> = Promise.resolve();
  private fatalError: Error | undefined;

  constructor(options: HeteroIngestForwarderOptions) {
    this.agentType = options.agentType;
    this.jwt = options.jwt;
    this.operationId = options.operationId;
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.topicId = options.topicId;
  }

  push(event: AgentStreamEvent): void {
    if (this.fatalError) return;

    this.buffer.push(event);

    if (this.buffer.length >= MAX_BATCH) {
      this.triggerFlush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.triggerFlush(), FLUSH_INTERVAL_MS);
    }
  }

  async drain(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.triggerFlush();
    await this.inflightFlush;
    if (this.fatalError) throw this.fatalError;
  }

  async finish(params: {
    error?: { message: string; type: string };
    result: 'cancelled' | 'error' | 'success';
    sessionId?: string;
  }): Promise<void> {
    await this.drain();
    await this.postWithRetry(`${this.serverUrl}/trpc/lambda/aiAgent.heteroFinish`, {
      json: {
        agentType: this.agentType,
        error: params.error,
        operationId: this.operationId,
        result: params.result,
        sessionId: params.sessionId,
        topicId: this.topicId,
      },
    });
  }

  private triggerFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    const batch = this.buffer.splice(0);
    if (batch.length === 0) return;

    this.inflightFlush = this.inflightFlush
      .then(() => this.sendBatch(batch))
      .catch((err) => {
        this.fatalError = err instanceof Error ? err : new Error(String(err));
        logger.error('Fatal ingest error — dropping further events:', this.fatalError.message);
      });
  }

  private async sendBatch(events: AgentStreamEvent[]): Promise<void> {
    await this.postWithRetry(`${this.serverUrl}/trpc/lambda/aiAgent.heteroIngest`, {
      json: {
        agentType: this.agentType,
        events,
        operationId: this.operationId,
        topicId: this.topicId,
      },
    });
  }

  private async postWithRetry(url: string, body: unknown): Promise<void> {
    let backoff = INITIAL_BACKOFF_MS;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await netFetch(url, {
          body: JSON.stringify(body),
          headers: {
            'Content-Type': 'application/json',
            'Oidc-Auth': this.jwt,
          },
          method: 'POST',
        });

        if (res.ok) return;

        const text = await res.text().catch(() => '');
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`Ingest rejected (${res.status}): ${text.slice(0, 200)}`);
        }

        if (attempt === MAX_RETRIES) {
          throw new Error(
            `Ingest failed after ${MAX_RETRIES} retries (${res.status}): ${text.slice(0, 200)}`,
          );
        }
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('Ingest rejected')) throw err;
      }

      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 8000);
    }
  }
}
