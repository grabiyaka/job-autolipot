import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { allowedTools, browseTools, denyReasons, disallowedTools } from '../plugins/agent-guard-rules.js';
import {
  agentArgs, AgentResponseError, AgentTimeoutError, AgentUnavailableError, agentUploadPath, costMicros, createClaudeAgent, resultTokens, syncAgentFiles,
} from '../plugins/claude-agent.js';
import type { AgentError, ClaudeAgentConfig } from '../plugins/claude-agent.js';
import { agentBackendFromEnv, applySettingsFromEnv, claudeAgentConfigFromEnv } from '../plugins/environment.js';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'claude-agent-'));
const settingsPath = path.join(root, 'claude-settings.json');
writeFileSync(settingsPath, '{"env":{}}');
const record = path.join(root, 'record.json');
// Stands in for /srv/agent-files: one CV, a note that is not copied, a subfolder that is ignored.
const filesSource = path.join(root, 'agent-files');
mkdirSync(path.join(filesSource, 'old'), { recursive: true });
writeFileSync(path.join(filesSource, 'CV.pdf'), 'pdf');
writeFileSync(path.join(filesSource, 'notes.txt'), 'x');
writeFileSync(path.join(filesSource, 'old', 'old.pdf'), 'old');
// DeepSeek-like prices, USD per 1M tokens.
const prices = { input: 0.27, cacheRead: 0.07, output: 1.1 };
const schema = { type: 'object', properties: { outcome: { type: 'string' } } };

let counter = 0;
const config = (overrides: Partial<ClaudeAgentConfig> = {}): ClaudeAgentConfig => ({
  claudeBin: fakeClaude, settingsPath, mcpUrl: 'http://127.0.0.1:8931/mcp', workDir: path.join(root, `work-${++counter}`),
  agentCwd: path.join(root, `cwd-${counter}`), filesSource, timeoutMs: 10_000, prices, ...overrides,
});
const request = { prompt: 'Apply to this job: https://www.linkedin.com/jobs/view/1/', systemPrompt: 'You fill in job applications.', schema, mode: 'fill' as const };

const saved = { ...process.env };
afterEach(() => {
  for (const key of ['FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_RECORD', 'FAKE_CLAUDE_TOOL', 'CLAUDECODE', 'APPLY_START_URL']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fake(mode: string, extra: Record<string, string> = {}) {
  Object.assign(process.env, { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RECORD: record, ...extra });
}
const recorded = () => JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; cwd: string; env: Record<string, string | null> };
async function failure(promise: Promise<unknown>): Promise<AgentError> {
  try { await promise; } catch (error) { return error as AgentError; }
  throw new Error('expected the run to fail');
}

describe('claude agent plugin', () => {
  it('runs claude with the probe arguments and returns the structured answer with our own cost', async () => {
    fake('success');
    process.env.CLAUDECODE = '1';
    const cfg = config();
    const result = await createClaudeAgent(cfg).run(request);

    expect(result).toMatchObject({
      output: { outcome: 'ready_to_submit', summary: 'ok', filled: [], questions: [] },
      subtype: 'success', sessionId: 'session-1', turns: 18,
      tokens: { input: 31_000, cacheRead: 327_000, output: 5000 },
      // 31k × 0.27 + 327k × 0.07 + 5k × 1.1 = 8370 + 22890 + 5500 µ$ ≈ 3.7 cents (not $0.43 of claude).
      costMicros: 36_760,
      guardLog: [],
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const { argv, cwd, env } = recorded();
    expect(cwd).toBe(cfg.agentCwd);
    expect(path.dirname(result.runDir)).toBe(path.join(cfg.workDir, 'runs'));
    expect(env).toEqual({ APPLY_MODE: 'fill', APPLY_GUARD_DIR: result.runDir, APPLY_UPLOAD_DIR: path.join(cfg.agentCwd, 'files'), APPLY_START_URL: null, CLAUDECODE: null, APPLY_ALLOWED_HOSTS: null });
    expect(readdirSync(path.join(cfg.agentCwd, 'files'))).toEqual(['CV.pdf']);
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(argv.slice(0, 2)).toEqual(['-p', request.prompt]);
    expect(flag('--settings')).toBe(settingsPath);
    expect(flag('--setting-sources')).toBe('project');
    expect(flag('--mcp-config')).toBe(path.join(cfg.agentCwd, 'mcp.json'));
    expect(flag('--system-prompt-file')!.startsWith(result.runDir)).toBe(true);
    expect(argv).toContain('--strict-mcp-config');
    expect(readFileSync(flag('--system-prompt-file')!, 'utf8')).toBe(request.systemPrompt);
    expect(flag('--allowedTools')).toBe(allowedTools.join(','));
    expect(flag('--disallowedTools')).toBe(disallowedTools.join(','));
    expect(flag('--permission-mode')).toBe('dontAsk');
    expect(JSON.parse(flag('--json-schema')!)).toEqual(schema);
    expect(flag('--output-format')).toBe('json');
    expect(argv).not.toContain('--resume');

    expect(JSON.parse(readFileSync(path.join(cfg.agentCwd, 'mcp.json'), 'utf8')))
      .toEqual({ mcpServers: { playwright: { type: 'http', url: 'http://127.0.0.1:8931/mcp' } } });
    const settings = JSON.parse(readFileSync(path.join(cfg.agentCwd, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toMatchObject([{ matcher: '*', hooks: [{ type: 'command' }] }]);
    expect(settings.hooks.PostToolUse).toMatchObject([{ matcher: 'mcp__playwright__.*', hooks: [{ type: 'command', command: settings.hooks.PreToolUse[0].hooks[0].command }] }]);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(/scripts\/agent-guard\.ts' \|\| exit 2$/);
  });

  it('continues a session with --resume and passes the submit mode', async () => {
    fake('success');
    await createClaudeAgent(config()).run({ ...request, mode: 'submit', resumeSessionId: 'session-1' });
    const { argv, env } = recorded();
    expect(argv.slice(-2)).toEqual(['--resume', 'session-1']);
    expect(env.APPLY_MODE).toBe('submit');
  });

  it('passes submit_fresh and startUrl to the guard; drops an inherited APPLY_START_URL', async () => {
    fake('success');
    const startUrl = 'https://boards.greenhouse.io/acme/jobs/1';
    await createClaudeAgent(config()).run({ ...request, mode: 'submit_fresh', startUrl });
    expect(recorded().env).toMatchObject({ APPLY_MODE: 'submit_fresh', APPLY_START_URL: startUrl });
    expect(recorded().argv).not.toContain('--resume');

    process.env.APPLY_START_URL = 'https://evil.test/';
    await createClaudeAgent(config()).run(request);
    expect(recorded().env.APPLY_START_URL).toBeNull();
  });

  it('rejects a start URL that is not https', async () => {
    fake('success');
    for (const startUrl of ['http://acme.test/jobs/1', 'acme.test', 'javascript:alert(1)']) {
      await expect(createClaudeAgent(config()).run({ ...request, startUrl })).rejects.toThrow('https');
    }
  });

  it('the generated hook lets the start URL host through and denies other hosts', async () => {
    const navigate = (url: string) => JSON.stringify({ tool_name: 'mcp__playwright__browser_navigate', tool_input: { url } });
    fake('hook', { FAKE_CLAUDE_TOOL: navigate('https://careers.acme.test/jobs/1') });
    const allowed = await createClaudeAgent(config()).run({ ...request, startUrl: 'https://careers.acme.test/jobs/1' });
    expect(allowed.output).toEqual({ hook: '', status: 0 });
    fake('hook', { FAKE_CLAUDE_TOOL: navigate('https://other.test/') });
    const denied = await createClaudeAgent(config()).run({ ...request, startUrl: 'https://careers.acme.test/jobs/1' });
    expect(JSON.parse((denied.output as { hook: string }).hook).hookSpecificOutput.permissionDecisionReason).toBe(denyReasons.foreignSite);
  });

  it('browse (the collector agent): read-only tools, --max-turns, the site hosts to the guard, no upload copies', async () => {
    fake('success');
    process.env.APPLY_ALLOWED_HOSTS = 'evil.test';
    const cfg = config({ filesSource: path.join(root, 'missing-files') });
    const browse = { ...request, mode: 'browse' as const, allowedHosts: ['djinni.co', 'www.djinni.co'], maxTurns: 40 };
    const result = await createClaudeAgent(cfg).run(browse);
    delete process.env.APPLY_ALLOWED_HOSTS;
    const { argv, env } = recorded();
    expect(env).toMatchObject({ APPLY_MODE: 'browse', APPLY_GUARD_DIR: result.runDir, APPLY_UPLOAD_DIR: null, APPLY_ALLOWED_HOSTS: 'djinni.co,www.djinni.co' });
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(flag('--max-turns')).toBe('40');
    expect(flag('--allowedTools')!.split(',')).toEqual(browseTools);
    expect(flag('--disallowedTools')).toContain('mcp__playwright__browser_file_upload');
    expect(flag('--allowedTools')).not.toContain('browser_file_upload');
    await expect(createClaudeAgent(cfg).run({ ...browse, allowedHosts: [] })).rejects.toThrow('хосты');

    const navigate = (url: string) => JSON.stringify({ tool_name: 'mcp__playwright__browser_navigate', tool_input: { url } });
    fake('hook', { FAKE_CLAUDE_TOOL: navigate('https://djinni.co/jobs/') });
    expect((await createClaudeAgent(cfg).run(browse)).output).toEqual({ hook: '', status: 0 });
    fake('hook', { FAKE_CLAUDE_TOOL: navigate('https://www.linkedin.com/jobs/') });
    const denied = await createClaudeAgent(cfg).run(browse);
    expect(JSON.parse((denied.output as { hook: string }).hook).hookSpecificOutput.permissionDecisionReason).toBe(denyReasons.browseSite);
  });

  it('the generated hook blocks Submit in fill and logs it into the result', async () => {
    fake('hook', { FAKE_CLAUDE_TOOL: JSON.stringify({ tool_name: 'mcp__playwright__browser_click', tool_input: { element: 'Submit application', ref: 'e1' } }) });
    const result = await createClaudeAgent(config()).run(request);
    const output = result.output as { hook: string; status: number };
    expect(output.status).toBe(0);
    // No snapshot was taken in this run, so the ref is unknown: denied before its name even matters.
    expect(JSON.parse(output.hook).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: denyReasons.unknownRef });
    expect(result.guardLog).toMatchObject([{ mode: 'fill', tool: 'mcp__playwright__browser_click', decision: 'deny' }]);
  });

  it('a hook that cannot start exits with 2, which blocks the call', async () => {
    fake('hook');
    const result = await createClaudeAgent(config({ guardCommand: "'/nonexistent/node' guard.js || exit 2" })).run(request);
    expect((result.output as { status: number }).status).toBe(2);
  });

  it('error_max_turns: AgentResponseError carrying tokens and cost', async () => {
    fake('max_turns');
    const error = await failure(createClaudeAgent(config()).run(request));
    expect(error).toBeInstanceOf(AgentResponseError);
    expect(error.message).toContain('error_max_turns');
    expect(error).toMatchObject({ subtype: 'error_max_turns', sessionId: 'session-1', turns: 18, tokens: { input: 31_000 }, costMicros: 36_760 });
  });

  it('garbage output and a crash are AgentResponseError', async () => {
    fake('garbage');
    expect(await failure(createClaudeAgent(config()).run(request))).toBeInstanceOf(AgentResponseError);
    fake('crash');
    const crash = await failure(createClaudeAgent(config()).run(request));
    expect(crash).toBeInstanceOf(AgentResponseError);
    expect(crash.message).toContain('код 3');
  });

  it('a hanging run is killed after the timeout, even when it ignores SIGTERM', async () => {
    fake('hang');
    const started = Date.now();
    const error = await failure(createClaudeAgent(config({ timeoutMs: 300, killGraceMs: 200 })).run(request));
    expect(error).toBeInstanceOf(AgentTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('the signal stops a run', async () => {
    fake('hang');
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stopped by test')), 200);
    await expect(createClaudeAgent(config({ killGraceMs: 100 })).run({ ...request, signal: controller.signal })).rejects.toThrow('stopped by test');
  });

  it('no source of files to upload: AgentUnavailableError', async () => {
    fake('success');
    expect(await failure(createClaudeAgent(config({ filesSource: path.join(root, 'nowhere') })).run(request))).toBeInstanceOf(AgentUnavailableError);
  });

  it('no claude or no settings file: AgentUnavailableError', async () => {
    fake('success');
    expect(await failure(createClaudeAgent(config({ claudeBin: path.join(root, 'no-claude') })).run(request))).toBeInstanceOf(AgentUnavailableError);
    expect(await failure(createClaudeAgent(config({ settingsPath: path.join(root, 'missing.json') })).run(request))).toBeInstanceOf(AgentUnavailableError);
  });

  it('refuses a prompt that claude would read as a flag', async () => {
    await expect(createClaudeAgent(config()).run({ ...request, prompt: '--help' })).rejects.toThrow('«-»');
  });
});

describe('files for upload', () => {
  /** A setgid parent like /srv/agent-files; in tmp our own group stands in for agent. */
  function setgidParent(name: string): string {
    const parent = path.join(root, name);
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o2750);
    return parent;
  }

  it('copies new top-level documents, skips unchanged ones and ignores subfolders and other files', async () => {
    const source = path.join(root, 'sync-source');
    const target = path.join(setgidParent('sync-target'), 'files');
    mkdirSync(path.join(source, 'nested'), { recursive: true });
    writeFileSync(path.join(source, 'CV.pdf'), 'v1');
    writeFileSync(path.join(source, 'Letter.DOCX'), 'docx');
    writeFileSync(path.join(source, 'photo.png'), 'png');
    writeFileSync(path.join(source, 'nested', 'deep.pdf'), 'deep');

    expect((await syncAgentFiles(source, target)).sort()).toEqual(['CV.pdf', 'Letter.DOCX']);
    expect(readdirSync(target).sort()).toEqual(['CV.pdf', 'Letter.DOCX']);
    expect(statSync(target).mode & 0o7777).toBe(0o2750);
    expect(statSync(path.join(target, 'CV.pdf')).mode & 0o777).toBe(0o640);
    expect(statSync(path.join(target, 'CV.pdf')).gid).toBe(statSync(target).gid);
    expect(await syncAgentFiles(source, target)).toEqual([]);
    expect(statSync(target).mode & 0o2000).toBe(0o2000);

    writeFileSync(path.join(source, 'CV.pdf'), 'version 2');
    utimesSync(path.join(source, 'CV.pdf'), new Date('2026-11-05T00:00:00Z'), new Date('2026-11-05T00:00:00Z'));
    expect(await syncAgentFiles(source, target)).toEqual(['CV.pdf']);
    expect(readFileSync(path.join(target, 'CV.pdf'), 'utf8')).toBe('version 2');
  });

  const source = path.join(root, 'repair-source');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'CV.pdf'), 'cv');
  /** stat that reports another group for `file` while `foreign()` says so. */
  const statWithGroup = (file: string, foreign: () => boolean) => (async (target: string) => {
    const info = await stat(target);
    return target === file && foreign() ? { ...info, gid: info.gid + 1 } : info;
  }) as unknown as typeof stat;

  it('repairs a folder that lost setgid (chmod by a non-member of the group drops it) and copies again', async () => {
    const target = path.join(setgidParent('repair-folder'), 'files');
    mkdirSync(target);
    chmodSync(target, 0o750); // the broken state of live run 3
    writeFileSync(path.join(target, 'CV.pdf'), 'cv');
    expect(statSync(target).mode & 0o2000).toBe(0);
    // Like Linux for a non-member: chmod of the folder silently loses setgid.
    const lossyChmod = (async (file: string, mode: number) => chmod(file, file === target ? mode & ~0o2000 : mode)) as typeof chmod;

    expect(await syncAgentFiles(source, target, { stat, chmod: lossyChmod })).toEqual(['CV.pdf']);
    expect(statSync(target).mode & 0o7777).toBe(0o2750); // recreated: setgid inherited from the parent
    expect(statSync(path.join(target, 'CV.pdf')).mode & 0o777).toBe(0o640);
  });

  it('copies again an unchanged copy with a foreign group, and fails when the group stays wrong', async () => {
    const target = path.join(setgidParent('repair-group'), 'files');
    const copy = path.join(target, 'CV.pdf');
    expect(await syncAgentFiles(source, target)).toEqual(['CV.pdf']);

    let checks = 0;
    expect(await syncAgentFiles(source, target, { stat: statWithGroup(copy, () => checks++ === 0), chmod })).toEqual(['CV.pdf']);
    expect(checks).toBeGreaterThan(1);

    await expect(syncAgentFiles(source, target, { stat: statWithGroup(copy, () => true), chmod })).rejects.toThrow('группу папки');
    expect(readdirSync(target)).toEqual([]);
  });

  it('agentUploadPath names the copy and refuses paths', () => {
    expect(agentUploadPath('Illia Herasymets - Current Resume.pdf'))
      .toBe('/srv/agent-files/agent-run/files/Illia Herasymets - Current Resume.pdf');
    expect(agentUploadPath('CV.pdf', '/tmp/run')).toBe('/tmp/run/files/CV.pdf');
    expect(() => agentUploadPath('../CV.pdf')).toThrow();
    expect(() => agentUploadPath('')).toThrow();
  });
});

describe('agent tokens, cost and settings', () => {
  it('sums modelUsage over models and falls back to usage', () => {
    expect(resultTokens({
      modelUsage: { a: { inputTokens: 10, cacheReadInputTokens: 100, outputTokens: 5 }, b: { inputTokens: 1, cacheCreationInputTokens: 2, outputTokens: 1 } },
    })).toEqual({ input: 13, cacheRead: 100, output: 6 });
    expect(resultTokens({ usage: { input_tokens: 7, cache_read_input_tokens: 70, output_tokens: 3 } })).toEqual({ input: 7, cacheRead: 70, output: 3 });
    expect(costMicros({ input: 1_000_000, cacheRead: 0, output: 0 }, prices)).toBe(270_000);
  });

  it('reads APPLY_TIMEOUT_MS, DEEPSEEK_SETTINGS, PLAYWRIGHT_MCP_URL and requires the prices', () => {
    const env = { DEEPSEEK_PRICE_INPUT: '0.27', DEEPSEEK_PRICE_CACHE_READ: '0.07', DEEPSEEK_PRICE_OUTPUT: '1.1' };
    expect(claudeAgentConfigFromEnv(env)).toMatchObject({
      claudeBin: 'claude', timeoutMs: 600_000, mcpUrl: 'http://127.0.0.1:8931/mcp', prices,
      settingsPath: expect.stringMatching(/\/\.config\/deepseek\/claude-settings\.json$/),
      workDir: expect.stringMatching(/server\/data\/agent$/),
      agentCwd: '/srv/agent-files/agent-run',
    });
    expect(claudeAgentConfigFromEnv({ ...env, AGENT_CWD: '/tmp/agent-cwd' }).agentCwd).toBe('/tmp/agent-cwd');
    expect(claudeAgentConfigFromEnv({ ...env, APPLY_TIMEOUT_MS: '1000', DEEPSEEK_SETTINGS: '/x.json', PLAYWRIGHT_MCP_URL: 'http://h:1/mcp' }))
      .toMatchObject({ timeoutMs: 1000, settingsPath: '/x.json', mcpUrl: 'http://h:1/mcp' });
    expect(() => claudeAgentConfigFromEnv({ ...env, DEEPSEEK_PRICE_OUTPUT: '' })).toThrow('DEEPSEEK_PRICE_OUTPUT');
    expect(() => claudeAgentConfigFromEnv({ ...env, DEEPSEEK_PRICE_INPUT: 'cheap' })).toThrow('DEEPSEEK_PRICE_INPUT');
    expect(() => claudeAgentConfigFromEnv({ ...env, APPLY_TIMEOUT_MS: '-1' })).toThrow('APPLY_TIMEOUT_MS');
  });

  it('runs on the Claude account with APPLY_AGENT=claude: no DeepSeek settings or prices, --model, cost from total_cost_usd', () => {
    const cfg = claudeAgentConfigFromEnv({ APPLY_AGENT: 'claude' });
    expect(cfg).toMatchObject({ settingsPath: null, prices: null, model: 'sonnet' });
    expect(claudeAgentConfigFromEnv({ APPLY_CLAUDE_MODEL: 'opus' }, 'claude').model).toBe('opus');
    expect(() => agentBackendFromEnv({ APPLY_AGENT: 'gpt' })).toThrow('APPLY_AGENT');
    const argv = agentArgs({ mcpConfig: 'm.json', systemPromptFile: 's.md' }, cfg, { prompt: 'p', systemPrompt: 's', schema: {}, mode: 'fill' });
    expect(argv).not.toContain('--settings');
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(applySettingsFromEnv({}, 'claude').maxUsdPerDay).toBe(10);
    expect(applySettingsFromEnv({ APPLY_CLAUDE_MAX_USD_PER_DAY: '3' }, 'claude').maxUsdPerDay).toBe(3);
    expect(applySettingsFromEnv({ APPLY_CLAUDE_MAX_USD_PER_DAY: '3' }, 'deepseek').maxUsdPerDay).toBe(0.5);
  });

  it('APPLY_AUTO_SUBMIT is off unless it is exactly true', () => {
    expect(applySettingsFromEnv({}).autoSubmit).toBe(false);
    expect(applySettingsFromEnv({ APPLY_AUTO_SUBMIT: ' TRUE ' }).autoSubmit).toBe(true);
    expect(applySettingsFromEnv({ APPLY_AUTO_SUBMIT: 'false' }).autoSubmit).toBe(false);
    expect(() => applySettingsFromEnv({ APPLY_AUTO_SUBMIT: 'yes' })).toThrow('APPLY_AUTO_SUBMIT');
  });
});
