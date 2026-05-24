import { randomUUID } from 'node:crypto';

import type {
  ISandboxService,
  SandboxCallToolResult,
  SandboxExportFileResult,
} from '@lobechat/builtin-tool-cloud-sandbox';
import debug from 'debug';
import { sha256 } from 'js-sha256';
import mime from 'mime';

import { FileS3 } from '@/server/modules/S3';
import type { FileService } from '@/server/services/file';

const log = debug('lobe-server:daytona-sandbox-service');

const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api';
const DEFAULT_DAYTONA_PROXY_URL = 'https://proxy.app.daytona.io/toolbox';
const DEFAULT_DAYTONA_SNAPSHOT = 'daytonaio/sandbox:0.8.0';
const DEFAULT_DAYTONA_SHELL = '/bin/bash';
const DEFAULT_AUTO_STOP_INTERVAL_MINUTES = 15;
const DEFAULT_SANDBOX_TARGET = 'us';
const DEFAULT_START_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
const DEFAULT_WORKSPACE = '/workspace';

const MANAGED_LABEL = 'lobehub';
const TOPIC_LABEL_KEY = 'lobehub-topic';
const USER_LABEL_KEY = 'lobehub-user';
const SERVICE_LABEL_KEY = 'lobehub-service';

type DaytonaSandboxState =
  | 'archived'
  | 'archiving'
  | 'build_failed'
  | 'building_snapshot'
  | 'creating'
  | 'destroyed'
  | 'destroying'
  | 'error'
  | 'forking'
  | 'pending_build'
  | 'pulling_snapshot'
  | 'resizing'
  | 'restoring'
  | 'snapshotting'
  | 'started'
  | 'starting'
  | 'stopped'
  | 'stopping'
  | 'unknown';

interface DaytonaSandbox {
  desiredState?: string;
  id: string;
  labels?: Record<string, string>;
  name?: string;
  state?: DaytonaSandboxState;
  toolboxProxyUrl?: string;
}

interface DaytonaConfigResponse {
  defaultSnapshot?: string;
  proxyToolboxUrl?: string;
}

interface DaytonaSandboxPage {
  items?: DaytonaSandbox[];
  nextCursor?: string;
}

interface DaytonaExecuteResponse {
  cmdId?: string;
  exitCode?: number;
  output?: string;
  stderr?: string | null;
  stdout?: string | null;
}

interface DaytonaRuntimeConfig {
  proxyUrl: string;
  snapshot: string;
}

export interface DaytonaSandboxServiceOptions {
  apiKey: string;
  apiUrl?: string;
  autoStopInterval?: number;
  fileService: FileService;
  proxyUrl?: string;
  sandboxCache?: Map<string, string>;
  shell?: string;
  snapshot?: string;
  startTimeoutMs?: number;
  target?: string;
  topicId: string;
  userId: string;
}

export const isDaytonaSandboxConfigured = () => Boolean(process.env.DAYTONA_API_KEY?.trim());

export const createDaytonaSandboxServiceFromEnv = (options: {
  fileService: FileService;
  topicId: string;
  userId: string;
}) =>
  new DaytonaSandboxService({
    apiKey: process.env.DAYTONA_API_KEY || '',
    apiUrl: process.env.DAYTONA_API_URL,
    autoStopInterval: parseOptionalInteger(process.env.DAYTONA_AUTO_STOP_INTERVAL),
    fileService: options.fileService,
    proxyUrl: process.env.DAYTONA_PROXY_URL,
    shell: process.env.DAYTONA_SHELL,
    snapshot: process.env.DAYTONA_SNAPSHOT,
    startTimeoutMs: parseOptionalInteger(process.env.DAYTONA_START_TIMEOUT_MS),
    target: process.env.DAYTONA_TARGET,
    topicId: options.topicId,
    userId: options.userId,
  });

export const clearDaytonaSandboxCacheForTests = () => {
  DaytonaSandboxService.clearCacheForTests();
};

const parseOptionalInteger = (value?: string): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
};

const joinUrl = (base: string, path: string) =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const safeSandboxName = (topicId: string) => {
  const cleaned = topicId.replaceAll(/[^\w.-]/g, '-').slice(0, 48);
  return `lobehub-topic-${cleaned || 'default'}`;
};

const encodePathPayload = (payload: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(payload)).toString('base64');

const buildPythonJsonCommand = (script: string, payload: Record<string, unknown>) => {
  const payloadBase64 = encodePathPayload(payload);

  return [
    "python3 - <<'PY'",
    'import base64, fnmatch, glob, json, os, re, shutil, sys',
    `payload = json.loads(base64.b64decode("${payloadBase64}").decode("utf-8"))`,
    'try:',
    ...script.split('\n').map((line) => `  ${line}`),
    'except Exception as exc:',
    '  print(json.dumps({"__lobehub_error": str(exc)}))',
    'PY',
  ].join('\n');
};

const quoteHereDoc = (code: string, language: string) => {
  const marker = `LOBEHUB_${language.toUpperCase()}_${sha256(code).slice(0, 12)}`;
  return { marker, text: code.replaceAll(`\n${marker}\n`, `\n${marker}_X\n`) };
};

const normalizeError = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
  name: error instanceof Error ? error.name : undefined,
});

const getLastNonEmptyLine = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast(Boolean);

const unwrapSandboxList = (page: DaytonaSandboxPage | DaytonaSandbox[] | null | undefined) => {
  if (Array.isArray(page)) return page;
  return page?.items ?? [];
};

const getFileName = (path: string) => path.split('/').findLast(Boolean) || 'exported_file';

export class DaytonaSandboxService implements ISandboxService {
  private static sandboxCache = new Map<string, string>();

  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly autoStopInterval: number;
  private readonly cache: Map<string, string>;
  private readonly fileService: FileService;
  private readonly shell: string;
  private readonly startTimeoutMs: number;
  private readonly target: string;
  private readonly topicId: string;
  private readonly userId: string;
  private runtimeConfig?: DaytonaRuntimeConfig;

  constructor(options: DaytonaSandboxServiceOptions) {
    if (!options.apiKey?.trim()) {
      throw new Error('DAYTONA_API_KEY is required for Daytona sandbox execution');
    }

    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl || DEFAULT_DAYTONA_API_URL;
    this.autoStopInterval = options.autoStopInterval ?? DEFAULT_AUTO_STOP_INTERVAL_MINUTES;
    this.cache = options.sandboxCache ?? DaytonaSandboxService.sandboxCache;
    this.fileService = options.fileService;
    this.shell = options.shell || DEFAULT_DAYTONA_SHELL;
    this.runtimeConfig =
      options.proxyUrl || options.snapshot
        ? {
            proxyUrl: options.proxyUrl || DEFAULT_DAYTONA_PROXY_URL,
            snapshot: options.snapshot || DEFAULT_DAYTONA_SNAPSHOT,
          }
        : undefined;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.target = options.target || DEFAULT_SANDBOX_TARGET;
    this.topicId = options.topicId;
    this.userId = options.userId;
  }

  static clearCacheForTests() {
    DaytonaSandboxService.sandboxCache.clear();
  }

  async callTool(toolName: string, params: Record<string, any>): Promise<SandboxCallToolResult> {
    log('Calling Daytona sandbox tool: %s, topicId: %s', toolName, this.topicId);

    try {
      switch (toolName) {
        case 'executeCode': {
          return this.executeCode(params);
        }

        case 'runCommand': {
          return this.runCommand(params);
        }

        case 'listFiles':
        case 'listLocalFiles': {
          return this.callPythonJson(listFilesScript, params);
        }

        case 'readFile':
        case 'readLocalFile': {
          return this.callPythonJson(readFileScript, params);
        }

        case 'writeFile':
        case 'writeLocalFile': {
          return this.callPythonJson(writeFileScript, params);
        }

        case 'editFile':
        case 'editLocalFile': {
          return this.callPythonJson(editFileScript, params);
        }

        case 'searchFiles':
        case 'searchLocalFiles': {
          return this.callPythonJson(searchFilesScript, params);
        }

        case 'moveFiles':
        case 'moveLocalFiles': {
          return this.callPythonJson(moveFilesScript, params);
        }

        case 'renameFile':
        case 'renameLocalFile': {
          return this.callPythonJson(renameFileScript, params);
        }

        case 'grepContent': {
          return this.callPythonJson(grepContentScript, params);
        }

        case 'globFiles':
        case 'globLocalFiles': {
          return this.callPythonJson(globFilesScript, params);
        }

        case 'getCommandOutput':
        case 'killCommand': {
          return {
            error: { message: `Daytona sandbox does not support ${toolName} yet` },
            result: null,
            success: false,
          };
        }

        default: {
          return {
            error: { message: `Unsupported Daytona sandbox tool: ${toolName}` },
            result: null,
            success: false,
          };
        }
      }
    } catch (error) {
      log('Daytona sandbox tool %s failed: %O', toolName, error);

      return {
        error: normalizeError(error),
        result: null,
        success: false,
      };
    }
  }

  async exportAndUploadFile(
    path: string,
    filename = getFileName(path),
  ): Promise<SandboxExportFileResult> {
    log('Exporting Daytona sandbox file: %s, topicId: %s', path, this.topicId);

    try {
      const sandbox = await this.getReadySandbox();
      const buffer = await this.downloadToolboxFile(sandbox, path);
      const today = new Date().toISOString().split('T')[0];
      const key = `code-interpreter-exports/${today}/${this.topicId}/${filename}`;
      const mimeType = mime.getType(filename) || 'application/octet-stream';
      const s3 = new FileS3();

      await s3.uploadBuffer(key, buffer, mimeType);

      const metadata = await s3.getFileMetadata(key);
      const fileHash = sha256(key + Date.now().toString());
      const { fileId, url } = await this.fileService.createFileRecord({
        fileHash,
        fileType: metadata.contentType || mimeType,
        name: filename,
        size: metadata.contentLength,
        url: key,
      });

      return {
        fileId,
        filename,
        mimeType: metadata.contentType || mimeType,
        size: metadata.contentLength,
        success: true,
        url,
      };
    } catch (error) {
      log('Exporting Daytona sandbox file failed: %O', error);

      return {
        error: { message: error instanceof Error ? error.message : String(error) },
        filename,
        success: false,
      };
    }
  }

  private async executeCode(params: Record<string, any>): Promise<SandboxCallToolResult> {
    const language = params.language || 'python';
    const code = String(params.code || '');
    let command: string;

    if (language === 'python') {
      const { marker, text } = quoteHereDoc(code, 'python');
      command = `python3 - <<'${marker}'\n${text}\n${marker}`;
    } else if (language === 'javascript') {
      const { marker, text } = quoteHereDoc(code, 'javascript');
      command = `node - <<'${marker}'\n${text}\n${marker}`;
    } else if (language === 'typescript') {
      const { marker, text } = quoteHereDoc(code, 'typescript');
      command = [
        `cat <<'${marker}' > /tmp/lobehub-execute.ts`,
        text,
        marker,
        'npx --yes tsx /tmp/lobehub-execute.ts',
      ].join('\n');
    } else {
      return {
        error: { message: `Unsupported Daytona executeCode language: ${language}` },
        result: null,
        success: false,
      };
    }

    const result = await this.executeProcess(command, params.timeout);

    return {
      result: {
        exitCode: result.exitCode,
        output: result.output,
        stderr: '',
        stdout: result.output,
      },
      success: true,
    };
  }

  private async runCommand(params: Record<string, any>): Promise<SandboxCallToolResult> {
    if (params.background) {
      return {
        error: { message: 'Daytona sandbox background commands are not supported yet' },
        result: null,
        success: false,
      };
    }

    const result = await this.executeProcess(
      String(params.command || ''),
      params.timeout,
      params.cwd,
    );

    return {
      result: {
        exitCode: result.exitCode,
        output: result.output,
        stderr: '',
        stdout: result.output,
      },
      success: true,
    };
  }

  private async callPythonJson(
    script: string,
    params: Record<string, unknown>,
  ): Promise<SandboxCallToolResult> {
    const result = await this.executeProcess(buildPythonJsonCommand(script, params));

    if (result.exitCode !== 0) {
      return {
        error: { message: result.output || `Python helper exited with ${result.exitCode}` },
        result: null,
        success: false,
      };
    }

    const jsonLine = getLastNonEmptyLine(result.output);
    if (!jsonLine) {
      return {
        error: { message: 'Daytona helper returned empty output' },
        result: null,
        success: false,
      };
    }

    const parsed = JSON.parse(jsonLine) as Record<string, unknown>;
    if (parsed.__lobehub_error) {
      return {
        error: { message: String(parsed.__lobehub_error) },
        result: null,
        success: false,
      };
    }

    return { result: parsed, success: true };
  }

  private async executeProcess(command: string, timeout?: number, cwd?: string) {
    const sandbox = await this.getReadySandbox();
    const sessionId = `lobehub-${randomUUID()}`;
    const timeoutSeconds =
      typeof timeout === 'number' && Number.isFinite(timeout)
        ? Math.max(1, Math.ceil(timeout / 1000))
        : DEFAULT_COMMAND_TIMEOUT_SECONDS;

    try {
      await this.postToolboxJson(sandbox, 'process/session', {
        cwd: cwd || DEFAULT_WORKSPACE,
        envs: { SHELL: this.shell, TERM: 'xterm-256color' },
        sessionId,
      });

      const response = await this.postToolboxJson<DaytonaExecuteResponse>(
        sandbox,
        `process/session/${sessionId}/exec`,
        {
          command,
          runAsync: false,
          timeout: timeoutSeconds,
        },
      );

      return {
        exitCode: response.exitCode ?? 0,
        output: response.output || response.stdout || response.stderr || '',
      };
    } finally {
      await this.requestToolboxJson('DELETE', sandbox, `process/session/${sessionId}`).catch(
        (error) => log('Failed to delete Daytona session %s: %O', sessionId, error),
      );
    }
  }

  private async getReadySandbox(): Promise<DaytonaSandbox> {
    const sandboxId = await this.ensureSandbox();
    return this.waitForSandboxReady(sandboxId);
  }

  private async ensureSandbox(): Promise<string> {
    log('DaytonaSandboxService.ensureSandbox: topicId=%s userId=%s', this.topicId, this.userId);

    const cacheKey = this.cacheKey;
    const cachedSandboxId = this.cache.get(cacheKey);

    if (cachedSandboxId) {
      const sandbox = await this.tryGetSandbox(cachedSandboxId);
      if (sandbox && !this.isDestroyed(sandbox)) {
        await this.startIfNeeded(sandbox);
        return sandbox.id;
      }
      this.cache.delete(cacheKey);
    }

    const existing = await this.findExistingSandbox();
    if (existing) {
      await this.startIfNeeded(existing);
      this.cache.set(cacheKey, existing.id);
      return existing.id;
    }

    const created = await this.createSandbox();
    this.cache.set(cacheKey, created.id);
    await this.startIfNeeded(created);
    return created.id;
  }

  private async findExistingSandbox() {
    const labels = this.labels;
    const query = new URLSearchParams({ labels: JSON.stringify(labels) });

    try {
      const page = await this.requestApi<DaytonaSandboxPage>('GET', `sandbox?${query}`);
      return this.pickReusableSandbox(unwrapSandboxList(page));
    } catch (error) {
      log('Label-filtered Daytona sandbox list failed, falling back to full list: %O', error);
      const page = await this.requestApi<DaytonaSandboxPage>('GET', 'sandbox');
      return this.pickReusableSandbox(unwrapSandboxList(page));
    }
  }

  private pickReusableSandbox(sandboxes: DaytonaSandbox[]) {
    return sandboxes.find(
      (sandbox) =>
        !this.isDestroyed(sandbox) &&
        sandbox.labels?.[TOPIC_LABEL_KEY] === this.topicId &&
        sandbox.labels?.[USER_LABEL_KEY] === this.userId &&
        sandbox.labels?.[SERVICE_LABEL_KEY] === MANAGED_LABEL,
    );
  }

  private async createSandbox() {
    const config = await this.getRuntimeConfig();
    const body = {
      autoStopInterval: this.autoStopInterval,
      env: { SHELL: this.shell },
      labels: this.labels,
      name: safeSandboxName(this.topicId),
      networkBlockAll: false,
      public: false,
      snapshot: config.snapshot,
      target: this.target,
      user: 'daytona',
    };

    return this.requestApi<DaytonaSandbox>('POST', 'sandbox', body);
  }

  private async startIfNeeded(sandbox: DaytonaSandbox) {
    if (sandbox.state === 'started') return;
    if (this.isDestroyed(sandbox)) {
      throw new Error(`Daytona sandbox is not reusable: ${sandbox.id} (${sandbox.state})`);
    }
    if (sandbox.state === 'starting' || sandbox.state === 'restoring') return;
    await this.requestApi<DaytonaSandbox>(
      'POST',
      `sandbox/${encodeURIComponent(sandbox.id)}/start`,
    );
  }

  private async waitForSandboxReady(sandboxId: string) {
    const deadline = Date.now() + this.startTimeoutMs;
    let delay = 1000;

    while (Date.now() <= deadline) {
      const sandbox = await this.requestApi<DaytonaSandbox>(
        'GET',
        `sandbox/${encodeURIComponent(sandboxId)}`,
      );

      if (sandbox.state === 'started') return sandbox;
      if (sandbox.state === 'error' || sandbox.state === 'build_failed') {
        throw new Error(`Daytona sandbox failed to start: ${sandbox.id} (${sandbox.state})`);
      }

      await sleep(delay);
      delay = Math.min(5000, Math.round(delay * 1.5));
    }

    throw new Error(`Timed out waiting for Daytona sandbox to start: ${sandboxId}`);
  }

  private async tryGetSandbox(sandboxId: string) {
    try {
      return await this.requestApi<DaytonaSandbox>(
        'GET',
        `sandbox/${encodeURIComponent(sandboxId)}`,
      );
    } catch {
      return undefined;
    }
  }

  private async getRuntimeConfig(): Promise<DaytonaRuntimeConfig> {
    if (this.runtimeConfig) return this.runtimeConfig;

    try {
      const config = await this.requestApi<DaytonaConfigResponse>('GET', 'config');
      this.runtimeConfig = {
        proxyUrl: config.proxyToolboxUrl || DEFAULT_DAYTONA_PROXY_URL,
        snapshot: config.defaultSnapshot || DEFAULT_DAYTONA_SNAPSHOT,
      };
    } catch (error) {
      log('Failed to read Daytona config, using defaults: %O', error);
      this.runtimeConfig = {
        proxyUrl: DEFAULT_DAYTONA_PROXY_URL,
        snapshot: DEFAULT_DAYTONA_SNAPSHOT,
      };
    }

    return this.runtimeConfig;
  }

  private async postToolboxJson<T>(
    sandbox: DaytonaSandbox,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return this.requestToolboxJson<T>('POST', sandbox, path, body);
  }

  private async requestToolboxJson<T>(
    method: string,
    sandbox: DaytonaSandbox,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const proxyUrl = await this.getProxyUrl(sandbox);

    try {
      return await this.requestJson<T>(method, joinUrl(proxyUrl, `${sandbox.id}/${path}`), body);
    } catch (error) {
      log('Daytona toolbox proxy failed, trying API toolbox route: %O', error);
      return this.requestJson<T>(
        method,
        joinUrl(this.apiUrl, `toolbox/${sandbox.id}/toolbox/${path}`),
        body,
      );
    }
  }

  private async downloadToolboxFile(sandbox: DaytonaSandbox, path: string): Promise<Buffer> {
    const proxyUrl = await this.getProxyUrl(sandbox);
    const query = new URLSearchParams({ path });

    try {
      return await this.requestBuffer(
        'GET',
        joinUrl(proxyUrl, `${sandbox.id}/files/download?${query}`),
      );
    } catch (error) {
      log('Daytona toolbox file proxy failed, trying API toolbox route: %O', error);
      return this.requestBuffer(
        'GET',
        joinUrl(this.apiUrl, `toolbox/${sandbox.id}/toolbox/files/download?${query}`),
      );
    }
  }

  private async getProxyUrl(sandbox: DaytonaSandbox) {
    if (sandbox.toolboxProxyUrl) return sandbox.toolboxProxyUrl;
    const config = await this.getRuntimeConfig();
    return config.proxyUrl;
  }

  private async requestApi<T>(method: string, path: string, body?: Record<string, unknown>) {
    return this.requestJson<T>(method, joinUrl(this.apiUrl, path), body);
  }

  private async requestJson<T>(method: string, url: string, body?: Record<string, unknown>) {
    const response = await fetch(url, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      method,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Daytona API ${method} ${new URL(url).pathname} failed: ${response.status} ${errorText}`,
      );
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async requestBuffer(method: string, url: string) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      method,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Daytona API ${method} ${new URL(url).pathname} failed: ${response.status} ${errorText}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  private isDestroyed(sandbox: DaytonaSandbox) {
    return sandbox.state === 'destroyed' || sandbox.state === 'destroying';
  }

  private get cacheKey() {
    return `${this.userId}:${this.topicId}`;
  }

  private get labels() {
    return {
      [SERVICE_LABEL_KEY]: MANAGED_LABEL,
      [TOPIC_LABEL_KEY]: this.topicId,
      [USER_LABEL_KEY]: this.userId,
    };
  }
}

const listFilesScript = `
path = payload.get("directoryPath") or payload.get("path") or "."
entries = []
for name in sorted(os.listdir(path)):
  full = os.path.join(path, name)
  st = os.stat(full)
  entries.append({"name": name, "path": full, "isDirectory": os.path.isdir(full), "size": st.st_size})
print(json.dumps({"files": entries, "totalCount": len(entries)}))
`;

const readFileScript = `
path = payload["path"]
start = payload.get("startLine")
end = payload.get("endLine")
with open(path, "r", encoding="utf-8", errors="replace") as file:
  lines = file.readlines()
line_count = len(lines)
selected = lines[(int(start) - 1 if start else 0):(int(end) if end else line_count)]
content = "".join(selected)
print(json.dumps({
  "content": content,
  "charCount": len(content),
  "filename": os.path.basename(path),
  "fileType": os.path.splitext(path)[1].lstrip("."),
  "loc": [int(start) if start else 1, int(end) if end else line_count],
  "totalCharCount": sum(len(line) for line in lines),
  "totalLineCount": line_count,
}))
`;

const writeFileScript = `
path = payload["path"]
if payload.get("createDirectories"):
  os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
content = payload.get("content") or ""
with open(path, "w", encoding="utf-8") as file:
  written = file.write(content)
print(json.dumps({"bytesWritten": written, "path": path, "success": True}))
`;

const editFileScript = `
path = payload["path"]
search = payload["search"]
replace = payload["replace"]
replace_all = bool(payload.get("all"))
with open(path, "r", encoding="utf-8", errors="replace") as file:
  before = file.read()
count = before.count(search)
if count == 0:
  print(json.dumps({"path": path, "replacements": 0, "diffText": ""}))
else:
  after = before.replace(search, replace) if replace_all else before.replace(search, replace, 1)
  with open(path, "w", encoding="utf-8") as file:
    file.write(after)
  replacements = count if replace_all else 1
  print(json.dumps({"path": path, "replacements": replacements, "linesAdded": 0, "linesDeleted": 0}))
`;

const searchFilesScript = `
directory = payload.get("directory") or "."
keyword = payload.get("keyword") or payload.get("keywords") or ""
file_type = payload.get("fileType")
results = []
for root, dirs, files in os.walk(directory):
  for name in files:
    if keyword and keyword not in name:
      continue
    if file_type and not name.endswith("." + str(file_type).lstrip(".")):
      continue
    full = os.path.join(root, name)
    st = os.stat(full)
    results.append({"name": name, "path": full, "size": st.st_size, "modifiedAt": str(st.st_mtime)})
    if len(results) >= int(payload.get("limit") or 200):
      break
  if len(results) >= int(payload.get("limit") or 200):
    break
print(json.dumps({"results": results, "totalCount": len(results)}))
`;

const moveFilesScript = `
results = []
for op in payload.get("operations", []):
  src = op.get("source")
  dst = op.get("destination")
  try:
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    shutil.move(src, dst)
    results.append({"source": src, "destination": dst, "success": True})
  except Exception as exc:
    results.append({"source": src, "destination": dst, "success": False, "error": str(exc)})
print(json.dumps({"results": results, "successCount": sum(1 for item in results if item.get("success"))}))
`;

const renameFileScript = `
old_path = payload["oldPath"]
new_path = os.path.join(os.path.dirname(old_path), payload["newName"])
os.rename(old_path, new_path)
print(json.dumps({"oldPath": old_path, "newPath": new_path, "success": True}))
`;

const grepContentScript = `
directory = payload.get("directory") or "."
pattern = re.compile(payload["pattern"])
file_pattern = payload.get("filePattern") or "*"
recursive = payload.get("recursive", True)
matches = []
walker = os.walk(directory) if recursive else [(directory, [], os.listdir(directory))]
for root, dirs, files in walker:
  for name in files:
    if not fnmatch.fnmatch(name, file_pattern):
      continue
    full = os.path.join(root, name)
    try:
      with open(full, "r", encoding="utf-8", errors="replace") as file:
        for index, line in enumerate(file, start=1):
          if pattern.search(line):
            matches.append({"path": full, "lineNumber": index, "content": line.rstrip("\\n")})
            if len(matches) >= 200:
              break
    except Exception:
      pass
    if len(matches) >= 200:
      break
  if len(matches) >= 200:
    break
print(json.dumps({"matches": matches, "pattern": payload["pattern"], "totalMatches": len(matches)}))
`;

const globFilesScript = `
directory = payload.get("directory") or "."
pattern = payload["pattern"]
files = glob.glob(os.path.join(directory, pattern), recursive=True)
print(json.dumps({"files": files[:500], "pattern": pattern, "totalCount": len(files)}))
`;
