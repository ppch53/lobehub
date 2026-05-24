import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import type { AgentStreamEvent } from '@lobechat/heterogeneous-agents/spawn/gemini';
import { GeminiStreamPipeline } from '@lobechat/heterogeneous-agents/spawn/gemini';
import debug from 'debug';

import type {
  HeterogeneousAgentService,
  HeterogeneousFinishResult,
} from '@/server/services/heterogeneousAgent';

const log = debug('lobe-server:hetero-local-runner');

const DEFAULT_LOCAL_CWD = '/workspace';
const DEFAULT_LOCAL_CWD_ALLOWLIST = '/workspace:/app';
const POSIX_PATH_SEPARATOR = '/';

const ENV_ALLOWLIST = new Set([
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'GEMINI_CLI_TRUST_WORKSPACE',
  'PATH',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'USERPROFILE',
  'WINDIR',
]);

const DENIED_AGENT_ENV_PATTERNS = [
  /^AGENT_GATEWAY_SERVICE_TOKEN$/i,
  /^AUTH_SECRET$/i,
  /^BETTER_AUTH_SECRET$/i,
  /^DATABASE_URL$/i,
  /^DAYTONA_API_KEY$/i,
  /^DEVICE_GATEWAY_SERVICE_TOKEN$/i,
  /^KEY_VAULTS_SECRET$/i,
  /^LOBEHUB_JWT$/i,
  /^POSTGRES_PASSWORD$/i,
  /^REDIS_URL$/i,
  /^RUSTFS_/i,
  /^S3_/i,
] as const;

const activeOperations = new Set<string>();
const LOCAL_STREAM_FLUSH_INTERVAL_MS = 250;
const LOCAL_STREAM_MAX_BATCH_SIZE = 4;

export interface LocalRunParams {
  agentType: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  heterogeneousAgentService: HeterogeneousAgentService;
  operationId: string;
  prompt: string;
  resumeSessionId?: string;
  systemContext?: string;
  topicId: string;
}

const getMaxConcurrentLocalRuns = (): number => {
  const raw = Number(process.env.HETERO_LOCAL_MAX_CONCURRENT ?? 1);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
};

const splitAllowlist = (): string[] => {
  const raw =
    process.env.HETERO_LOCAL_CWD_ALLOWLIST ??
    process.env.HETERO_LOCAL_WORKDIR_ALLOWLIST ??
    DEFAULT_LOCAL_CWD_ALLOWLIST;

  return raw
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeAbsolutePosixPath = (value: string): string => {
  if (!value.startsWith(POSIX_PATH_SEPARATOR)) {
    throw new Error(`Local heterogeneous agent cwd must be an absolute path: ${value}`);
  }

  const segments: string[] = [];
  for (const part of value.split(POSIX_PATH_SEPARATOR)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  return `${POSIX_PATH_SEPARATOR}${segments.join(POSIX_PATH_SEPARATOR)}`;
};

const isSameOrChildPath = (candidate: string, parent: string): boolean => {
  return candidate === parent || candidate.startsWith(`${parent}${POSIX_PATH_SEPARATOR}`);
};

const resolveAllowedCwd = (cwd?: string): string => {
  const target = normalizeAbsolutePosixPath(
    cwd || process.env.HETERO_LOCAL_DEFAULT_CWD || DEFAULT_LOCAL_CWD,
  );
  const allowed = splitAllowlist().map((item) => normalizeAbsolutePosixPath(item));

  if (!allowed.some((base) => isSameOrChildPath(target, base))) {
    throw new Error(
      `Local heterogeneous agent cwd is outside allowlist: ${target}. Configure HETERO_LOCAL_CWD_ALLOWLIST.`,
    );
  }

  return target;
};

const buildFilteredEnv = (agentEnv: Record<string, string> | undefined): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(agentEnv ?? {})) {
    if (DENIED_AGENT_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }

  return env;
};

const buildGeminiPrompt = (prompt: string, systemContext?: string): string =>
  systemContext ? `${systemContext}\n\n${prompt}` : prompt;

const buildGeminiArgs = (
  prompt: string,
  resumeSessionId: string | undefined,
  extraArgs: string[] | undefined,
): string[] => [
  '--output-format',
  'stream-json',
  '--approval-mode',
  'yolo',
  '--skip-trust',
  ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
  '--prompt',
  prompt,
  ...(extraArgs ?? []),
];

const makeErrorEvent = (
  agentType: string,
  operationId: string,
  message: string,
  type = 'local_spawn_error',
): AgentStreamEvent => ({
  data: {
    agentType,
    clearEchoedContent: true,
    error: message,
    message,
    stderr: message,
    type,
  },
  operationId,
  stepIndex: 0,
  timestamp: Date.now(),
  type: 'error',
});

const summarizeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const collectStderr = (proc: ChildProcessWithoutNullStreams): { get: () => string } => {
  let stderr = '';

  proc.stderr.on('data', (chunk) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  return { get: () => stderr };
};

const createExitPromise = (
  proc: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({ code, signal }),
    );
    proc.on('error', (err: Error) => reject(err));
  });

const spawnGeminiLocal = (params: {
  args?: string[];
  cwd: string;
  env: Record<string, string>;
  operationId: string;
  prompt: string;
  resumeSessionId?: string;
}) => {
  const env = params.env as NodeJS.ProcessEnv;
  const proc: ChildProcessWithoutNullStreams = spawn(
    'gemini',
    buildGeminiArgs(params.prompt, params.resumeSessionId, params.args),
    {
      cwd: params.cwd,
      detached: process.platform !== 'win32',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  proc.stdin.end();

  const pipeline = new GeminiStreamPipeline({ operationId: params.operationId });
  const stderr = collectStderr(proc);
  const exit = createExitPromise(proc);
  const queue: AgentStreamEvent[] = [];
  let streamEnded = false;
  let streamError: Error | undefined;
  let wakeup: (() => void) | undefined;

  const wake = () => {
    if (!wakeup) return;
    const w = wakeup;
    wakeup = undefined;
    w();
  };

  proc.stdout.on('data', (chunk) => {
    try {
      queue.push(...pipeline.push(chunk));
    } catch (err) {
      streamError = err instanceof Error ? err : new Error(String(err));
      streamEnded = true;
    }
    wake();
  });

  proc.stdout.on('end', () => {
    try {
      queue.push(...pipeline.flush());
    } catch (err) {
      streamError = err instanceof Error ? err : new Error(String(err));
    } finally {
      streamEnded = true;
      wake();
    }
  });

  proc.stdout.on('error', (err: Error) => {
    streamError = err;
    streamEnded = true;
    wake();
  });

  proc.on('error', (err: Error) => {
    streamError = err;
    streamEnded = true;
    wake();
  });

  const events: AsyncIterable<AgentStreamEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AgentStreamEvent>> {
          while (true) {
            if (queue.length > 0) return { done: false, value: queue.shift()! };
            if (streamError) throw streamError;
            if (streamEnded) return { done: true, value: undefined };
            await new Promise<void>((res) => {
              wakeup = res;
            });
          }
        },
      };
    },
  };

  return {
    events,
    exit,
    get sessionId() {
      return pipeline.sessionId;
    },
    stderr,
  };
};

export async function spawnHeteroLocal(params: LocalRunParams): Promise<void> {
  const {
    agentType,
    heterogeneousAgentService,
    operationId,
    prompt,
    resumeSessionId,
    systemContext,
    topicId,
  } = params;

  if (activeOperations.size >= getMaxConcurrentLocalRuns()) {
    const message = 'Local heterogeneous agent concurrency limit reached';
    await heterogeneousAgentService.heteroIngest({
      agentType,
      events: [makeErrorEvent(agentType, operationId, message, 'local_concurrency_limit')],
      operationId,
      topicId,
    });
    await heterogeneousAgentService.heteroFinish({
      agentType,
      error: { message, type: 'local_concurrency_limit' },
      operationId,
      result: 'error',
      topicId,
    });
    return;
  }

  activeOperations.add(operationId);
  let result: HeterogeneousFinishResult = 'success';
  let errorPayload: { message: string; type: string } | undefined;
  let sessionId: string | undefined;

  const ingestBatch = async (events: AgentStreamEvent[]): Promise<void> => {
    if (events.length === 0) return;
    await heterogeneousAgentService.heteroIngest({ agentType, events, operationId, topicId });
  };

  try {
    const handle = spawnGeminiLocal({
      args: params.args,
      cwd: resolveAllowedCwd(params.cwd),
      env: buildFilteredEnv(params.env),
      operationId,
      prompt: buildGeminiPrompt(prompt, systemContext),
      resumeSessionId,
    });

    const batch: AgentStreamEvent[] = [];
    let flushTimer: NodeJS.Timeout | undefined;

    const flushBatch = async (): Promise<void> => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (batch.length === 0) return;
      await ingestBatch(batch.splice(0));
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushBatch().catch((error) => {
          log('spawnHeteroLocal: timed flush failed op=%s err=%O', operationId, error);
        });
      }, LOCAL_STREAM_FLUSH_INTERVAL_MS);
    };

    for await (const event of handle.events) {
      batch.push(event);
      if (batch.length >= LOCAL_STREAM_MAX_BATCH_SIZE) {
        await flushBatch();
      } else {
        scheduleFlush();
      }
    }
    await flushBatch();

    const exit = await handle.exit;
    sessionId = handle.sessionId;
    if (exit.code && exit.code !== 0) {
      result = 'error';
      const message = handle.stderr.get().trim() || `Local agent exited with code ${exit.code}`;
      errorPayload = { message, type: 'local_process_exit' };
    }
  } catch (error) {
    result = 'error';
    const message = summarizeError(error);
    errorPayload = { message, type: 'local_spawn_error' };
    log('spawnHeteroLocal failed op=%s type=%s err=%O', operationId, agentType, error);
    await ingestBatch([makeErrorEvent(agentType, operationId, message)]);
  } finally {
    activeOperations.delete(operationId);
    await heterogeneousAgentService.heteroFinish({
      agentType,
      ...(errorPayload ? { error: errorPayload } : {}),
      operationId,
      result,
      sessionId,
      topicId,
    });
  }
}
