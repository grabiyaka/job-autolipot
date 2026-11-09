#!/usr/bin/env node
// Stand-in for `claude -p` in tests of plugins/claude-agent.ts. Never talks to a model.
// FAKE_CLAUDE_MODE: success | max_turns | garbage | hang | crash | hook
// FAKE_CLAUDE_RECORD: file to write {argv, cwd, env markers} to.
// hook: runs the PreToolUse command from ./.claude/settings.json with FAKE_CLAUDE_TOOL as stdin
// and returns the hook's stdout as structured_output.hook.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'success';
if (process.env.FAKE_CLAUDE_RECORD) {
  writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: { APPLY_MODE: process.env.APPLY_MODE ?? null, APPLY_GUARD_DIR: process.env.APPLY_GUARD_DIR ?? null, APPLY_UPLOAD_DIR: process.env.APPLY_UPLOAD_DIR ?? null, APPLY_START_URL: process.env.APPLY_START_URL ?? null, CLAUDECODE: process.env.CLAUDECODE ?? null, APPLY_ALLOWED_HOSTS: process.env.APPLY_ALLOWED_HOSTS ?? null },
  }));
}

const result = (extra) => JSON.stringify({
  type: 'result', is_error: false, duration_ms: 1234, num_turns: 18, session_id: 'session-1',
  total_cost_usd: 0.43, result: '',
  usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: {
    'deepseek-flash[1m]': { inputTokens: 30000, cacheCreationInputTokens: 1000, cacheReadInputTokens: 327000, outputTokens: 5000, costUSD: 0.43 },
  },
  ...extra,
});

switch (mode) {
  case 'success':
    process.stdout.write(result({ subtype: 'success', structured_output: { outcome: 'ready_to_submit', summary: 'ok', filled: [], questions: [] } }));
    break;
  case 'max_turns':
    process.stdout.write(result({ subtype: 'error_max_turns', is_error: true }));
    process.exitCode = 1;
    break;
  case 'garbage':
    process.stdout.write('this is not json');
    break;
  case 'crash':
    process.stderr.write('boom');
    process.exitCode = 3;
    break;
  case 'hang':
    process.on('SIGTERM', () => {}); // ignore TERM: the plugin must follow up with KILL
    setInterval(() => {}, 1000);
    break;
  case 'hook': {
    const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    let out = '';
    let status = 0;
    try {
      out = execFileSync('sh', ['-c', command], { input: process.env.FAKE_CLAUDE_TOOL ?? '{}', encoding: 'utf8' });
    } catch (error) {
      out = error.stdout ?? '';
      status = error.status ?? -1;
    }
    process.stdout.write(result({ subtype: 'success', structured_output: { hook: out, status } }));
    break;
  }
}
