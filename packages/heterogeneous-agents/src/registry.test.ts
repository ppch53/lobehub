import { describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter, CodexAdapter, GeminiAdapter } from './adapters';
import { createAdapter, getPreset, listAgentTypes } from './registry';

describe('registry', () => {
  describe('createAdapter', () => {
    it('creates a ClaudeCodeAdapter for "claude-code"', () => {
      const adapter = createAdapter('claude-code');
      expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
    });

    it('creates a CodexAdapter for "codex"', () => {
      const adapter = createAdapter('codex');
      expect(adapter).toBeInstanceOf(CodexAdapter);
    });

    it('creates a CodexAdapter for "codex-app"', () => {
      const adapter = createAdapter('codex-app');
      expect(adapter).toBeInstanceOf(CodexAdapter);
    });

    it('creates a GeminiAdapter for "gemini-cli"', () => {
      const adapter = createAdapter('gemini-cli');
      expect(adapter).toBeInstanceOf(GeminiAdapter);
    });

    it('throws for unknown agent type', () => {
      expect(() => createAdapter('unknown-agent')).toThrow('Unknown agent type: "unknown-agent"');
    });
  });

  describe('getPreset', () => {
    it('returns preset with stream-json args for claude-code', () => {
      const preset = getPreset('claude-code');
      expect(preset.baseArgs).toContain('--input-format');
      expect(preset.baseArgs).toContain('--output-format');
      expect(preset.baseArgs).toContain('stream-json');
      expect(preset.baseArgs).toContain('-p');
      expect(preset.promptMode).toBe('stdin');
    });

    it('preset has resumeArgs function', () => {
      const preset = getPreset('claude-code');
      expect(preset.resumeArgs).toBeDefined();
      const args = preset.resumeArgs!('sess_abc');
      expect(args).toContain('--resume');
      expect(args).toContain('sess_abc');
    });

    it('returns preset with exec args for codex', () => {
      const preset = getPreset('codex');
      expect(preset.baseArgs).toContain('exec');
      expect(preset.baseArgs).toContain('--json');
      expect(preset.promptMode).toBe('stdin');
    });

    it('returns Codex CLI fallback preset for codex-app', () => {
      const preset = getPreset('codex-app');
      expect(preset.baseArgs).toContain('exec');
      expect(preset.baseArgs).toContain('--json');
      expect(preset.promptMode).toBe('stdin');
    });

    it('returns preset with stream-json args for gemini-cli', () => {
      const preset = getPreset('gemini-cli');
      expect(preset.baseArgs).toEqual([
        '--output-format',
        'stream-json',
        '--approval-mode',
        'yolo',
      ]);
      expect(preset.promptMode).toBe('positional');
    });

    it('throws for unknown agent type', () => {
      expect(() => getPreset('nope')).toThrow('Unknown agent type: "nope"');
    });
  });

  describe('listAgentTypes', () => {
    it('includes claude-code', () => {
      const types = listAgentTypes();
      expect(types).toContain('claude-code');
      expect(types).toContain('codex');
      expect(types).toContain('codex-app');
      expect(types).toContain('gemini-cli');
    });
  });
});
