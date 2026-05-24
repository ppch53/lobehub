// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearDaytonaSandboxCacheForTests,
  DaytonaSandboxService,
  isDaytonaSandboxConfigured,
} from './daytonaSandboxService';

const labels = {
  'lobehub-service': 'lobehub',
  'lobehub-topic': 'topic-1',
  'lobehub-user': 'user-1',
};

const makeService = (fetchMock: ReturnType<typeof vi.fn>, cache = new Map<string, string>()) => {
  vi.stubGlobal('fetch', fetchMock);

  return new DaytonaSandboxService({
    apiKey: 'daytona-key',
    apiUrl: 'https://app.daytona.test/api',
    fileService: { createFileRecord: vi.fn() } as any,
    proxyUrl: 'https://proxy.daytona.test/toolbox',
    sandboxCache: cache,
    snapshot: 'daytonaio/sandbox:0.8.0',
    topicId: 'topic-1',
    userId: 'user-1',
  });
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

const emptyResponse = (status = 200) => new Response(null, { status });

const getBody = (init?: RequestInit) => JSON.parse(String(init?.body || '{}'));

describe('DaytonaSandboxService', () => {
  beforeEach(() => {
    clearDaytonaSandboxCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.DAYTONA_API_KEY;
  });

  it('detects Daytona configuration from env', () => {
    expect(isDaytonaSandboxConfigured()).toBe(false);
    process.env.DAYTONA_API_KEY = 'daytona-key';
    expect(isDaytonaSandboxConfigured()).toBe(true);
  });

  it('creates a labeled sandbox and executes Python code through toolbox proxy', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || 'GET';

      if (method === 'GET' && url.pathname === '/api/sandbox') {
        return jsonResponse([]);
      }

      if (method === 'POST' && url.pathname === '/api/sandbox') {
        return jsonResponse({
          id: 'sb-new',
          labels,
          state: 'starting',
          toolboxProxyUrl: 'https://proxy.daytona.test/toolbox',
        });
      }

      if (method === 'GET' && url.pathname === '/api/sandbox/sb-new') {
        return jsonResponse({
          id: 'sb-new',
          labels,
          state: 'started',
          toolboxProxyUrl: 'https://proxy.daytona.test/toolbox',
        });
      }

      if (method === 'POST' && url.pathname === '/toolbox/sb-new/process/session') {
        return emptyResponse();
      }

      if (
        method === 'POST' &&
        url.pathname.startsWith('/toolbox/sb-new/process/session/') &&
        url.pathname.endsWith('/exec')
      ) {
        return jsonResponse({ cmdId: 'cmd-1', exitCode: 0, output: '3.12.0\n' });
      }

      if (method === 'DELETE' && url.pathname.startsWith('/toolbox/sb-new/process/session/')) {
        return emptyResponse();
      }

      throw new Error(`unexpected request: ${method} ${url.href}`);
    });

    const service = makeService(fetchMock);
    const result = await service.callTool('executeCode', {
      code: 'import sys; print(sys.version.split()[0])',
      language: 'python',
    });

    expect(result).toMatchObject({
      result: { exitCode: 0, output: '3.12.0\n', stdout: '3.12.0\n' },
      success: true,
    });

    const createCall = fetchMock.mock.calls.find(([input, init]) => {
      const url = new URL(String(input));
      return init?.method === 'POST' && url.pathname === '/api/sandbox';
    });
    expect(createCall).toBeTruthy();
    expect(getBody(createCall?.[1])).toMatchObject({
      autoStopInterval: 15,
      env: { SHELL: '/bin/bash' },
      labels,
      name: 'lobehub-topic-topic-1',
      snapshot: 'daytonaio/sandbox:0.8.0',
    });

    const sessionCreateCall = fetchMock.mock.calls.find(([input, init]) => {
      const url = new URL(String(input));
      return init?.method === 'POST' && url.pathname === '/toolbox/sb-new/process/session';
    });
    expect(getBody(sessionCreateCall?.[1])).toMatchObject({
      cwd: '/workspace',
      envs: { SHELL: '/bin/bash', TERM: 'xterm-256color' },
    });

    const executeCall = fetchMock.mock.calls.find(([input, init]) => {
      const url = new URL(String(input));
      return (
        init?.method === 'POST' &&
        url.pathname.startsWith('/toolbox/sb-new/process/session/') &&
        url.pathname.endsWith('/exec')
      );
    });
    expect(getBody(executeCall?.[1])).toMatchObject({
      command: expect.stringContaining('python3 -'),
      runAsync: false,
      timeout: 120,
    });
  });

  it('starts and reuses an existing topic sandbox', async () => {
    const cache = new Map<string, string>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || 'GET';

      if (method === 'GET' && url.pathname === '/api/sandbox') {
        return jsonResponse([
          {
            id: 'sb-existing',
            labels,
            state: 'stopped',
            toolboxProxyUrl: 'https://proxy.daytona.test/toolbox',
          },
        ]);
      }

      if (method === 'POST' && url.pathname === '/api/sandbox/sb-existing/start') {
        return jsonResponse({ id: 'sb-existing', labels, state: 'starting' });
      }

      if (method === 'GET' && url.pathname === '/api/sandbox/sb-existing') {
        return jsonResponse({
          id: 'sb-existing',
          labels,
          state: 'started',
          toolboxProxyUrl: 'https://proxy.daytona.test/toolbox',
        });
      }

      if (method === 'POST' && url.pathname === '/toolbox/sb-existing/process/session') {
        return emptyResponse();
      }

      if (
        method === 'POST' &&
        url.pathname.startsWith('/toolbox/sb-existing/process/session/') &&
        url.pathname.endsWith('/exec')
      ) {
        return jsonResponse({ cmdId: 'cmd-1', exitCode: 0, output: 'ok\n' });
      }

      if (method === 'DELETE' && url.pathname.startsWith('/toolbox/sb-existing/process/session/')) {
        return emptyResponse();
      }

      throw new Error(`unexpected request: ${method} ${url.href}`);
    });

    const service = makeService(fetchMock, cache);

    await expect(service.callTool('runCommand', { command: 'echo ok' })).resolves.toMatchObject({
      result: { output: 'ok\n' },
      success: true,
    });
    await service.callTool('runCommand', { command: 'echo ok' });

    const listCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(String(input));
      return (init?.method || 'GET') === 'GET' && url.pathname === '/api/sandbox' && url.search;
    });
    const startCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url = new URL(String(input));
      return init?.method === 'POST' && url.pathname === '/api/sandbox/sb-existing/start';
    });

    expect(listCalls).toHaveLength(1);
    expect(startCalls).toHaveLength(1);
    expect(cache.get('user-1:topic-1')).toBe('sb-existing');
  });

  it('returns unsupported for Daytona background commands', async () => {
    const service = makeService(vi.fn());
    await expect(
      service.callTool('runCommand', { background: true, command: 'sleep 30' }),
    ).resolves.toMatchObject({
      error: { message: 'Daytona sandbox background commands are not supported yet' },
      success: false,
    });
  });
});
