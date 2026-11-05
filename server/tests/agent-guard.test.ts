import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowedTools, denyReasons, disallowedTools, guardDecision, initialGuardState, isLinkedinUrl, isUploadFile, parseApplyMode, uploadDenyReason,
} from '../plugins/agent-guard-rules.js';
import type { ApplyMode } from '../plugins/agent-guard-rules.js';
import { emptyRefIndex, parseSnapshotRefs, responseText, updateRefIndex } from '../plugins/agent-snapshot-refs.js';

const pw = (name: string) => `mcp__playwright__${name}`;
const uploadDir = '/srv/agent-files/agent-run/files';
const cv = `${uploadDir}/Illia Herasymets - Current Resume.pdf`;
const upload = uploadDenyReason(uploadDir);
const button = (name: string) => ({ role: 'button', name, text: '' });
/** What the snapshots of the run showed, by ref. */
const refs = {
  e1: button('Done'), e3: { role: 'textbox', name: 'Phone', text: '' }, e7: button('Send message'), e8: button('Подать заявку'),
  e9: button('SUBMIT'), e12: button('Next'), e40: button('Submit application'),
  e50: button('Review'), e51: { role: 'button', name: '', text: 'Submit' }, e52: button('Bewerbung absenden'),
  e53: button('Envoyer la candidature'), e54: { role: 'combobox', name: 'Country code', text: '' },
};
const context = { uploadDir, refs };
type Expect = 'allow' | string;
type Row = Readonly<{ name: string; tool: string; args: unknown; fill: Expect; submit: Expect }>;

/** Every row is checked in both modes with no submit click made yet. */
const table: Row[] = [
  { name: 'snapshot', tool: pw('browser_snapshot'), args: {}, fill: 'allow', submit: 'allow' },
  { name: 'StructuredOutput (final answer)', tool: 'StructuredOutput', args: { outcome: 'ready_to_submit', summary: 'submit send', filled: [] }, fill: 'allow', submit: 'allow' },
  { name: 'ToolSearch', tool: 'ToolSearch', args: { query: 'select:mcp__playwright__browser_click' }, fill: 'allow', submit: 'allow' },
  { name: 'Read', tool: 'Read', args: { file_path: '/home/elijah/.claude/projects/x/snapshot.md' }, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
  { name: 'Grep', tool: 'Grep', args: { pattern: 'Submit' }, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
  { name: 'click Next', tool: pw('browser_click'), args: { element: 'Next button', ref: 'e12' }, fill: 'allow', submit: 'allow' },
  { name: 'click Submit application', tool: pw('browser_click'), args: { element: 'Submit application', ref: 'e40' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'click Send', tool: pw('browser_click'), args: { element: 'Send message button', ref: 'e7' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'click «Отправить»', tool: pw('browser_click'), args: { element: 'Кнопка «Отправить»', ref: 'e7' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'click «Подать заявку»', tool: pw('browser_click'), args: { element: 'Подать заявку', ref: 'e8' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'agent calls Submit "Primary button"', tool: pw('browser_click'), args: { element: 'Primary button', target: 'e40' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'agent calls a nameless Submit "Continue"', tool: pw('browser_click'), args: { element: 'Continue', target: 'e51' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'German submit, neutral words', tool: pw('browser_click'), args: { element: 'Button', target: 'e52' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'French submit, neutral words', tool: pw('browser_click'), args: { element: 'Button', target: 'e53' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'agent says Submit on a Next ref', tool: pw('browser_click'), args: { element: 'Submit application', target: 'e12' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'click Next by target', tool: pw('browser_click'), args: { element: 'Next button', target: 'e12' }, fill: 'allow', submit: 'allow' },
  { name: 'click Review', tool: pw('browser_click'), args: { element: 'Review button', target: 'e50' }, fill: 'allow', submit: 'allow' },
  { name: 'click unknown ref', tool: pw('browser_click'), args: { element: 'Next button', target: 'e999' }, fill: denyReasons.unknownRef, submit: denyReasons.unknownRef },
  { name: 'click without ref', tool: pw('browser_click'), args: { element: 'Next button' }, fill: denyReasons.unknownRef, submit: denyReasons.unknownRef },
  { name: 'type into unknown ref', tool: pw('browser_type'), args: { element: 'Phone', target: 'e999', text: '1' }, fill: denyReasons.unknownRef, submit: denyReasons.unknownRef },
  { name: 'type an answer with "send"', tool: pw('browser_type'), args: { element: 'Phone', target: 'e3', text: 'I can send references' }, fill: 'allow', submit: 'allow' },
  { name: 'select on a Submit ref', tool: pw('browser_select_option'), args: { element: 'Country', target: 'e40', values: ['IE'] }, fill: denyReasons.submitInFill, submit: denyReasons.submitInFill },
  { name: 'select country code', tool: pw('browser_select_option'), args: { element: 'Country code', target: 'e54', values: ['IE'] }, fill: 'allow', submit: 'allow' },
  { name: 'fill_form known fields', tool: pw('browser_fill_form'), args: { fields: [{ name: 'Phone', type: 'textbox', target: 'e3', value: '1' }] }, fill: 'allow', submit: 'allow' },
  { name: 'fill_form with an unknown field', tool: pw('browser_fill_form'), args: { fields: [{ name: 'Phone', type: 'textbox', target: 'e3', value: '1' }, { name: 'X', type: 'checkbox', target: 'e998', value: 'true' }] }, fill: denyReasons.unknownRef, submit: denyReasons.unknownRef },
  { name: 'fill_form clicking Submit as a checkbox', tool: pw('browser_fill_form'), args: { fields: [{ name: 'Agree', type: 'checkbox', target: 'e40', value: 'true' }] }, fill: denyReasons.submitInFill, submit: denyReasons.submitInFill },
  { name: 'click SUBMIT in upper case', tool: pw('browser_click'), args: { element: 'SUBMIT', ref: 'e9' }, fill: denyReasons.submitInFill, submit: 'allow' },
  { name: 'press Enter', tool: pw('browser_press_key'), args: { key: 'Enter' }, fill: denyReasons.enter, submit: denyReasons.enter },
  { name: 'press NumpadEnter', tool: pw('browser_press_key'), args: { key: 'NumpadEnter' }, fill: denyReasons.enter, submit: denyReasons.enter },
  { name: 'press Tab', tool: pw('browser_press_key'), args: { key: 'Tab' }, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
  { name: 'type', tool: pw('browser_type'), args: { element: 'Phone', ref: 'e3', text: '+353' }, fill: 'allow', submit: 'allow' },
  { name: 'type submit:true', tool: pw('browser_type'), args: { element: 'Phone', ref: 'e3', text: '+353', submit: true }, fill: denyReasons.typeSubmit, submit: denyReasons.typeSubmit },
  { name: 'navigate linkedin', tool: pw('browser_navigate'), args: { url: 'https://www.linkedin.com/jobs/view/1/' }, fill: 'allow', submit: 'allow' },
  { name: 'navigate linkedin.com', tool: pw('browser_navigate'), args: { url: 'https://linkedin.com/feed' }, fill: 'allow', submit: 'allow' },
  { name: 'navigate company site', tool: pw('browser_navigate'), args: { url: 'https://boards.greenhouse.io/acme/jobs/1' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'navigate look-alike host', tool: pw('browser_navigate'), args: { url: 'https://linkedin.com.evil.test/' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'navigate evillinkedin.com', tool: pw('browser_navigate'), args: { url: 'https://evillinkedin.com/' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'navigate http linkedin', tool: pw('browser_navigate'), args: { url: 'http://www.linkedin.com/' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'navigate without url', tool: pw('browser_navigate'), args: {}, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'new tab on another site', tool: pw('browser_tabs'), args: { action: 'new', url: 'https://example.com' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'list tabs', tool: pw('browser_tabs'), args: { action: 'list' }, fill: 'allow', submit: 'allow' },
  { name: 'upload CV', tool: pw('browser_file_upload'), args: { paths: [cv] }, fill: 'allow', submit: 'allow' },
  { name: 'upload outside', tool: pw('browser_file_upload'), args: { paths: ['/home/elijah/.ssh/id_ed25519'] }, fill: upload, submit: upload },
  { name: 'upload original in /srv/agent-files', tool: pw('browser_file_upload'), args: { paths: ['/srv/agent-files/cv.pdf'] }, fill: upload, submit: upload },
  { name: 'upload agent settings', tool: pw('browser_file_upload'), args: { paths: ['/srv/agent-files/agent-run/mcp.json'] }, fill: upload, submit: upload },
  { name: 'upload via ..', tool: pw('browser_file_upload'), args: { paths: [`${uploadDir}/../../../../etc/passwd`] }, fill: upload, submit: upload },
  { name: 'upload via .. to a sibling', tool: pw('browser_file_upload'), args: { paths: [`${uploadDir}/../.claude/settings.json`] }, fill: upload, submit: upload },
  { name: 'upload relative', tool: pw('browser_file_upload'), args: { paths: ['srv/agent-files/agent-run/files/cv.pdf'] }, fill: upload, submit: upload },
  { name: 'upload one good one bad', tool: pw('browser_file_upload'), args: { paths: [cv, '/tmp/x.pdf'] }, fill: upload, submit: upload },
  { name: 'upload prefix look-alike', tool: pw('browser_file_upload'), args: { paths: [`${uploadDir}-evil/cv.pdf`] }, fill: upload, submit: upload },
  { name: 'upload paths not a list', tool: pw('browser_file_upload'), args: { paths: cv }, fill: upload, submit: upload },
  { name: 'cancel file chooser (no paths)', tool: pw('browser_file_upload'), args: {}, fill: 'allow', submit: 'allow' },
  { name: 'evaluate', tool: pw('browser_evaluate'), args: { function: '() => 1' }, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
  { name: 'run code', tool: pw('browser_run_code_unsafe'), args: {}, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
  { name: 'handle dialog', tool: pw('browser_handle_dialog'), args: { accept: true }, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
  { name: 'close browser', tool: pw('browser_close'), args: {}, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
  { name: 'Bash', tool: 'Bash', args: { command: 'ls' }, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
  { name: 'WebFetch', tool: 'WebFetch', args: { url: 'https://example.com' }, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
  { name: 'unknown MCP tool', tool: 'mcp__other__do', args: {}, fill: denyReasons.notAllowed, submit: denyReasons.notAllowed },
];

describe('guardDecision', () => {
  for (const mode of ['fill', 'submit'] as const satisfies readonly ApplyMode[]) {
    describe(mode, () => {
      it.each(table)('$name', (row) => {
        const decision = guardDecision(mode, row.tool, row.args, initialGuardState, context);
        const expected = row[mode];
        if (expected === 'allow') expect(decision).toMatchObject({ allow: true });
        else expect(decision).toMatchObject({ allow: false, reason: expected, state: initialGuardState });
      });
    });
  }

  it('allows one submit click per run in submit mode', () => {
    const click = { element: 'Submit application', ref: 'e40' };
    const first = guardDecision('submit', pw('browser_click'), click, initialGuardState, context);
    expect(first).toMatchObject({ allow: true, state: { submitClicks: 1 } });
    expect(guardDecision('submit', pw('browser_click'), click, first.state, context)).toMatchObject({ allow: false, reason: denyReasons.secondSubmit });
    // Ordinary clicks still pass after it.
    expect(guardDecision('submit', pw('browser_click'), { element: 'Done', ref: 'e1' }, first.state, context)).toMatchObject({ allow: true });
  });

  it('every allowed tool is a Playwright one or a harmless built-in, and none is also disallowed', () => {
    expect(allowedTools.filter((tool) => !tool.startsWith('mcp__playwright__browser_'))).toEqual(['StructuredOutput', 'ToolSearch']);
    expect(allowedTools.filter((tool) => disallowedTools.includes(tool))).toEqual([]);
  });

  it('helpers: mode, hosts, paths', () => {
    expect([parseApplyMode('submit'), parseApplyMode('fill'), parseApplyMode(undefined), parseApplyMode('SUBMIT')]).toEqual(['submit', 'fill', 'fill', 'fill']);
    expect([isLinkedinUrl('https://de.linkedin.com/x'), isLinkedinUrl('about:blank'), isLinkedinUrl(42)]).toEqual([true, false, false]);
    expect([isUploadFile(cv, uploadDir), isUploadFile(`${uploadDir}//x.pdf`, `${uploadDir}/`), isUploadFile(`${uploadDir}/a/../../x`, uploadDir)])
      .toEqual([true, true, false]);
    expect(isUploadFile(cv, 'relative/dir')).toBe(false);
  });

  it('without an upload folder every upload is denied, cancelling the chooser is not', () => {
    expect(guardDecision('fill', pw('browser_file_upload'), { paths: [cv] }, initialGuardState, { ...context, uploadDir: null }))
      .toMatchObject({ allow: false, reason: denyReasons.noUploadDir });
    expect(guardDecision('fill', pw('browser_file_upload'), {}, initialGuardState, { ...context, uploadDir: null })).toMatchObject({ allow: true });
  });
});

describe('refs from ARIA snapshots', () => {
  const real = readFileSync(new URL('./fixtures/linkedin/easy-apply-snapshot.txt', import.meta.url), 'utf8');

  it('reads role and name of every ref of a real LinkedIn Easy Apply snapshot', () => {
    const parsed = parseSnapshotRefs(real);
    expect(parsed.f11e1083).toEqual({ role: 'button', name: 'Next', text: '' });
    expect(parsed.f11e1008).toMatchObject({ role: 'button', name: 'Dismiss' });
    expect(parsed.f11e1014).toMatchObject({ role: 'heading', name: "Apply to It's Prodigy" });
    expect(parsed.f11e1024).toMatchObject({ role: 'paragraph', name: '', text: '1/4 pages' });
    expect(parsed.f11e1079).toMatchObject({ role: 'textbox', name: 'Enter city or location' });
    expect(parsed.f11e930).toMatchObject({ role: 'link', name: 'Post a job', text: '' });
    expect(parsed.f11e1082!.text).toContain('Next');
    expect(Object.keys(parsed)).toHaveLength(19);
  });

  it('nameless elements take their descendant text; YAML-quoted lines and escapes are read', () => {
    const parsed = parseSnapshotRefs([
      '- button [ref=e1] [cursor=pointer]:', '  - generic [ref=e2]:', '    - text: Submit', '- button "Next" [ref=e3]',
      `- 'link "Foo: bar" [ref=e4]'`, '- button "Say \\"hi\\"" [ref=e5]',
    ].join('\n'));
    expect(parsed.e1).toEqual({ role: 'button', name: '', text: 'Submit' });
    expect(parsed.e3!.text).toBe('');
    expect(parsed.e4).toMatchObject({ role: 'link', name: 'Foo: bar' });
    expect(parsed.e5!.name).toBe('Say "hi"');
  });

  it('collects text from MCP content blocks and keeps refs per page', () => {
    expect(responseText([{ type: 'text', text: 'a' }, { type: 'image', data: '' }, 'b'])).toBe('a\nb');
    const first = updateRefIndex(emptyRefIndex, pw('browser_snapshot'), [{ type: 'text', text: real }]);
    expect(first.page).toBe('https://www.linkedin.com/jobs/view/4478980483/');
    const click = updateRefIndex(first, pw('browser_click'), [{ type: 'text', text: '- Page URL: https://www.linkedin.com/jobs/view/4478980483/?x=1' }]);
    expect(click.refs.f11e1083).toBeDefined();
    const other = updateRefIndex(click, pw('browser_click'), [{ type: 'text', text: '- Page URL: https://www.linkedin.com/feed/' }]);
    expect(other).toEqual({ page: 'https://www.linkedin.com/feed/', refs: {} });
  });
});

describe('agent-guard hook script', () => {
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tsx = path.join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(serverDir, 'scripts', 'agent-guard.ts');
  const dirs: string[] = [];
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  const attempt = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-guard-'));
    dirs.push(dir);
    return dir;
  };

  function hook(input: unknown, env: Record<string, string | undefined>): string {
    const { APPLY_MODE: _mode, APPLY_GUARD_DIR: _dir, APPLY_UPLOAD_DIR: _upload, ...base } = process.env;
    return execFileSync(process.execPath, [tsx, script], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      env: { ...base, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) },
      encoding: 'utf8',
    });
  }
  const submitClick = { tool_name: pw('browser_click'), tool_input: { element: 'Submit application', ref: 'e40' } };
  const reviewSnapshot = [
    '### Page', '- Page URL: https://www.linkedin.com/jobs/view/1/', '### Snapshot', '```yaml',
    '- dialog [ref=e30]:', '  - button "Back" [ref=e39]', '  - button "Submit application" [ref=e40] [cursor=pointer]', '```',
  ].join('\n');
  /** PostToolUse of a snapshot, in the content-block form the MCP tools return. */
  const snapshotDone = (text: string) => ({
    hook_event_name: 'PostToolUse', tool_name: pw('browser_snapshot'), tool_input: {}, tool_response: [{ type: 'text', text }],
  });
  /** A fresh attempt folder that has already seen the review page. */
  const attemptAtReview = (mode: string) => {
    const dir = attempt();
    expect(hook(snapshotDone(reviewSnapshot), { APPLY_MODE: mode, APPLY_GUARD_DIR: dir })).toBe('');
    return dir;
  };
  const denied = (out: string) => JSON.parse(out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };

  it('denies submit in fill, prints nothing on allow and logs every call', () => {
    const dir = attemptAtReview('fill');
    expect(denied(hook(submitClick, { APPLY_MODE: 'fill', APPLY_GUARD_DIR: dir }))).toEqual({
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyReasons.submitInFill,
    });
    expect(hook({ tool_name: pw('browser_snapshot'), tool_input: {} }, { APPLY_MODE: 'fill', APPLY_GUARD_DIR: dir })).toBe('');
    const log = readFileSync(path.join(dir, 'guard-log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(log).toMatchObject([
      { event: 'post', tool: pw('browser_snapshot'), page: 'https://www.linkedin.com/jobs/view/1/', refs: 3, response: reviewSnapshot },
      { mode: 'fill', tool: pw('browser_click'), decision: 'deny', reason: denyReasons.submitInFill, args: submitClick.tool_input },
      { mode: 'fill', tool: pw('browser_snapshot'), decision: 'allow' },
    ]);
  });

  it('uploads only from APPLY_UPLOAD_DIR; without it every upload is denied', () => {
    const uploadTool = (paths: string[]) => ({ tool_name: pw('browser_file_upload'), tool_input: { paths } });
    const env = { APPLY_MODE: 'fill', APPLY_GUARD_DIR: attempt(), APPLY_UPLOAD_DIR: uploadDir };
    expect(hook(uploadTool([cv]), env)).toBe('');
    expect(denied(hook(uploadTool(['/srv/agent-files/cv.pdf']), env)).permissionDecisionReason).toBe(upload);
    expect(denied(hook(uploadTool([cv]), { APPLY_MODE: 'fill', APPLY_GUARD_DIR: attempt() })).permissionDecisionReason).toBe(denyReasons.noUploadDir);
  });

  it('treats a missing or unknown APPLY_MODE as fill', () => {
    expect(denied(hook(submitClick, { APPLY_GUARD_DIR: attempt() })).permissionDecision).toBe('deny');
    expect(denied(hook(submitClick, { APPLY_MODE: 'yolo', APPLY_GUARD_DIR: attempt() })).permissionDecision).toBe('deny');
  });

  it('judges a click by the name from the snapshot, not by the agent words', () => {
    const real = readFileSync(new URL('./fixtures/linkedin/easy-apply-snapshot.txt', import.meta.url), 'utf8');
    const dir = attempt();
    const env = { APPLY_MODE: 'fill', APPLY_GUARD_DIR: dir };
    const click = (target: string, element: string) => hook({ tool_name: pw('browser_click'), tool_input: { element, target } }, env);
    expect(denied(click('f11e1083', 'Next button')).permissionDecisionReason).toBe(denyReasons.unknownRef);
    expect(hook(snapshotDone(real), env)).toBe('');
    expect(click('f11e1083', 'Next button')).toBe('');
    // The review page arrives in a later partial snapshot of the same page: refs add up.
    expect(hook(snapshotDone(reviewSnapshot.replace('/jobs/view/1/', '/jobs/view/4478980483/')), env)).toBe('');
    expect(denied(click('e40', 'Primary button')).permissionDecisionReason).toBe(denyReasons.submitInFill);
    expect(click('f11e1083', 'Next button')).toBe('');
    // After navigating, the old refs are gone.
    expect(hook({ hook_event_name: 'PostToolUse', tool_name: pw('browser_navigate'), tool_input: {}, tool_response: [{ type: 'text', text: '- Page URL: https://www.linkedin.com/jobs/view/2/' }] }, env)).toBe('');
    expect(denied(click('f11e1083', 'Next button')).permissionDecisionReason).toBe(denyReasons.unknownRef);
  });

  it('lets one submit click through in submit mode, across hook processes', () => {
    const dir = attemptAtReview('submit');
    expect(hook(submitClick, { APPLY_MODE: 'submit', APPLY_GUARD_DIR: dir })).toBe('');
    expect(existsSync(path.join(dir, 'submit-click'))).toBe(true);
    expect(denied(hook(submitClick, { APPLY_MODE: 'submit', APPLY_GUARD_DIR: dir })).permissionDecisionReason).toBe(denyReasons.secondSubmit);
  });

  it('fails closed: bad input or no attempt folder denies the call', () => {
    expect(denied(hook('not json', { APPLY_MODE: 'submit', APPLY_GUARD_DIR: attempt() })).permissionDecisionReason).toMatch(/^Guard failed/);
    expect(denied(hook(submitClick, { APPLY_MODE: 'submit' })).permissionDecisionReason).toMatch(/APPLY_GUARD_DIR/);
    expect(denied(hook({ tool_name: pw('browser_snapshot') }, { APPLY_MODE: 'fill', APPLY_GUARD_DIR: '/nonexistent/dir' })).permissionDecision).toBe('deny');
  });
});
