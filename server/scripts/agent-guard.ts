import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { guardDecision, guardLogFile, initialGuardState, parseApplyMode } from '../plugins/agent-guard-rules.js';
import type { GuardDecision } from '../plugins/agent-guard-rules.js';
import { emptyRefIndex, responseText, updateRefIndex } from '../plugins/agent-snapshot-refs.js';
import type { RefIndex } from '../plugins/agent-snapshot-refs.js';

/**
 * PreToolUse and PostToolUse hook of the browser agent (the event comes in `hook_event_name`) (wired by plugins/claude-agent.ts into the agent's
 * .claude/settings.json). Input: the tool call as JSON on stdin. Environment: APPLY_MODE=fill|submit
 * (anything else counts as fill), APPLY_GUARD_DIR, the folder of this attempt, and APPLY_UPLOAD_DIR,
 * the only folder uploads may come from (without it every upload is denied).
 *
 * Writes one JSON line per call to $APPLY_GUARD_DIR/guard-log.jsonl. The one allowed submit click is
 * claimed by creating $APPLY_GUARD_DIR/submit-click exclusively, so parallel calls cannot both pass.
 * On denial prints the hook's deny JSON; on allow prints nothing. Any failure here denies the call.
 *
 * PostToolUse (Playwright tools): reads element refs with their real role and name from the tool
 * response (ARIA snapshot) into $APPLY_GUARD_DIR/refs.json, which PreToolUse uses to judge clicks.
 * It never blocks anything; if it fails, the refs stay unknown and the next click on them is denied.
 */

const submitMarker = 'submit-click';
const refsFile = 'refs.json';
const maxLoggedArgs = 2000;

function readRefs(dir: string): RefIndex {
  try {
    const data = JSON.parse(readFileSync(path.join(dir, refsFile), 'utf8')) as RefIndex;
    return typeof data === 'object' && data !== null && typeof data.refs === 'object' ? data : emptyRefIndex;
  } catch { return emptyRefIndex; }
}

function writeRefs(dir: string, index: RefIndex): void {
  const temporary = path.join(dir, `${refsFile}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(index));
  renameSync(temporary, path.join(dir, refsFile));
}

/** PostToolUse: remember the refs of this response; log a short form of it. */
function afterTool(dir: string, input: Readonly<{ tool_name?: unknown; tool_response?: unknown }>, log: (entry: Record<string, unknown>) => void): void {
  const tool = String(input.tool_name ?? '');
  if (!tool.startsWith('mcp__playwright__')) return;
  const before = readRefs(dir);
  const after = updateRefIndex(before, tool, input.tool_response);
  writeRefs(dir, after);
  const text = responseText(input.tool_response);
  log({
    event: 'post', tool, page: after.page, refs: Object.keys(after.refs).length,
    response: text.length > maxLoggedArgs ? `${text.slice(0, maxLoggedArgs)}…` : text,
  });
}

function denyOutput(reason: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

function readStdin(): string {
  return readFileSync(0, 'utf8');
}

/** Claims the single submit click; false when it was already taken. */
function claimSubmit(dir: string): boolean {
  try {
    closeSync(openSync(path.join(dir, submitMarker), 'wx'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function logArgs(args: unknown): unknown {
  const text = JSON.stringify(args ?? null);
  return text.length > maxLoggedArgs ? `${text.slice(0, maxLoggedArgs)}…` : args;
}

function main(): void {
  const dir = process.env.APPLY_GUARD_DIR;
  if (!dir || !existsSync(dir)) {
    process.stdout.write(denyOutput('Guard is not configured (APPLY_GUARD_DIR): no tool calls are allowed.'));
    return;
  }
  const log = (entry: Record<string, unknown>) => appendFileSync(path.join(dir, guardLogFile), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

  let tool = '';
  let args: unknown;
  try {
    const input = JSON.parse(readStdin()) as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; tool_response?: unknown };
    if (input.hook_event_name === 'PostToolUse') {
      try { afterTool(dir, input, log); } catch (error) {
        log({ event: 'post', tool: String(input.tool_name ?? ''), error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    tool = String(input.tool_name ?? '');
    args = input.tool_input ?? {};
    const mode = parseApplyMode(process.env.APPLY_MODE);
    const context = { uploadDir: process.env.APPLY_UPLOAD_DIR?.trim() || null, refs: readRefs(dir).refs };
    const state = { submitClicks: existsSync(path.join(dir, submitMarker)) ? 1 : initialGuardState.submitClicks };
    let decision: GuardDecision = guardDecision(mode, tool, args, state, context);
    if (decision.allow && decision.state.submitClicks > state.submitClicks && !claimSubmit(dir)) {
      decision = guardDecision(mode, tool, args, { submitClicks: 1 }, context);
    }
    log({ mode, tool, args: logArgs(args), decision: decision.allow ? 'allow' : 'deny', ...(decision.reason ? { reason: decision.reason } : {}) });
    if (!decision.allow) process.stdout.write(denyOutput(decision.reason!));
  } catch (error) {
    const reason = `Guard failed (${error instanceof Error ? error.message : String(error)}): the call is denied.`;
    try { log({ tool, args: logArgs(args), decision: 'deny', reason }); } catch { /* still deny */ }
    process.stdout.write(denyOutput(reason));
  }
}

main();
