import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowedTools, atsDomains, denyReasons, disallowedTools, guardDecision, initialGuardState, isAllowedUrl, isLinkedinUrl, isUploadFile, parseApplyMode,
  uploadDenyReason,
} from '../plugins/agent-guard-rules.js';
import type { ApplyMode, GuardContext, GuardState } from '../plugins/agent-guard-rules.js';
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
  e60: button('Easy Apply to Acme'), e61: { role: 'link', name: 'Apply on company website', text: '' },
};
/** A LinkedIn Easy Apply page, no start URL, nothing visited yet. */
const linkedinPage = 'https://www.linkedin.com/jobs/view/1/';
const context: GuardContext = { uploadDir, refs, page: linkedinPage, startHost: null, visitedHosts: [] };
type Expect = 'allow' | string;
/** `fresh` (submit_fresh) defaults to the `submit` column. */
type Row = Readonly<{ name: string; tool: string; args: unknown; fill: Expect; submit: Expect; fresh?: Expect }>;

/** Every row is checked in all modes on a LinkedIn page with no submit click and no input made yet. */
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
  { name: 'click Easy Apply on LinkedIn', tool: pw('browser_click'), args: { element: 'Easy Apply button', target: 'e60' }, fill: 'allow', submit: 'allow' },
  { name: 'click Apply (to company site) on LinkedIn', tool: pw('browser_click'), args: { element: 'Apply', target: 'e61' }, fill: 'allow', submit: 'allow' },
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
  { name: 'navigate Greenhouse (ATS)', tool: pw('browser_navigate'), args: { url: 'https://boards.greenhouse.io/acme/jobs/1' }, fill: 'allow', submit: 'allow' },
  { name: 'navigate Lever (ATS)', tool: pw('browser_navigate'), args: { url: 'https://jobs.lever.co/acme/1/apply' }, fill: 'allow', submit: 'allow' },
  { name: 'navigate ATS apex domain', tool: pw('browser_navigate'), args: { url: 'https://personio.de/' }, fill: 'allow', submit: 'allow' },
  { name: 'navigate company site', tool: pw('browser_navigate'), args: { url: 'https://careers.acme.test/jobs/1' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'navigate Workday (account site)', tool: pw('browser_navigate'), args: { url: 'https://acme.wd3.myworkdayjobs.com/en-US/jobs' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'navigate ATS look-alike host', tool: pw('browser_navigate'), args: { url: 'https://greenhouse.io.evil.test/' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'navigate evilgreenhouse.io', tool: pw('browser_navigate'), args: { url: 'https://evilgreenhouse.io/' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'navigate http ATS', tool: pw('browser_navigate'), args: { url: 'http://boards.greenhouse.io/acme/jobs/1' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'navigate userinfo trick', tool: pw('browser_navigate'), args: { url: 'https://www.linkedin.com@evil.test/' }, fill: denyReasons.foreignSite, submit: denyReasons.foreignSite },
  { name: 'new tab on an ATS', tool: pw('browser_tabs'), args: { action: 'new', url: 'https://apply.workable.com/acme/j/1/' }, fill: 'allow', submit: 'allow' },
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
  for (const mode of ['fill', 'submit', 'submit_fresh'] as const satisfies readonly ApplyMode[]) {
    describe(mode, () => {
      it.each(table)('$name', (row) => {
        const decision = guardDecision(mode, row.tool, row.args, initialGuardState, context);
        const expected = mode === 'submit_fresh' ? row.fresh ?? row.submit : row[mode];
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

  it('typing on a LinkedIn page does not make Easy Apply a submit; strong words stay submit', () => {
    const typed = guardDecision('fill', pw('browser_type'), { element: 'Phone', target: 'e3', text: '1' }, initialGuardState, context);
    expect(typed).toMatchObject({ allow: true, state: { inputPages: [linkedinPage] } });
    expect(guardDecision('fill', pw('browser_click'), { element: 'Easy Apply', target: 'e60' }, typed.state, context)).toMatchObject({ allow: true });
    expect(guardDecision('fill', pw('browser_click'), { element: 'Next', target: 'e12' }, typed.state, context)).toMatchObject({ allow: true });
    expect(guardDecision('fill', pw('browser_click'), { element: 'Submit', target: 'e40' }, typed.state, context)).toMatchObject({ allow: false, reason: denyReasons.submitInFill });
  });

  it('every allowed tool is a Playwright one or a harmless built-in, and none is also disallowed', () => {
    expect(allowedTools.filter((tool) => !tool.startsWith('mcp__playwright__browser_'))).toEqual(['StructuredOutput', 'ToolSearch']);
    expect(allowedTools.filter((tool) => disallowedTools.includes(tool))).toEqual([]);
  });

  it('helpers: mode, hosts, paths', () => {
    expect([parseApplyMode('submit'), parseApplyMode('submit_fresh'), parseApplyMode('fill'), parseApplyMode(undefined), parseApplyMode('SUBMIT'), parseApplyMode('submit-fresh')])
      .toEqual(['submit', 'submit_fresh', 'fill', 'fill', 'fill', 'fill']);
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

describe('guardDecision on external sites', () => {
  const formPage = 'https://boards.greenhouse.io/acme/jobs/1';
  const externalRefs = {
    a1: button('Apply for this job'), a2: { role: 'textbox', name: 'First Name', text: '' }, a3: { role: 'combobox', name: 'Country', text: '' },
    a4: button('Submit application'), a5: { role: 'link', name: 'Jetzt bewerben', text: '' }, a6: button('Postuler'),
    a7: { role: 'checkbox', name: 'I agree to the Candidate Privacy Policy', text: '' }, a8: button('Attach resume'),
    a9: { role: 'generic', name: '', text: 'Apply' }, a10: button('Solicitar empleo'), a11: button('Candidater'),
    a12: { role: 'radio', name: 'Yes', text: '' }, a13: { role: 'switch', name: 'Remote', text: '' }, a14: { role: 'option', name: 'Ireland', text: '' },
  };
  const external: GuardContext = { uploadDir, refs: externalRefs, page: formPage, startHost: null, visitedHosts: [] };
  const typedHere: GuardState = { submitClicks: 0, inputPages: [formPage] };
  const click = (target: string, element = 'Button') => [pw('browser_click'), { element, target }] as const;

  type ExternalRow = Readonly<{ name: string; call: readonly [string, unknown]; state: GuardState; fill: Expect; fresh: Expect }>;
  const rows: ExternalRow[] = [
    { name: 'Apply before input opens the form', call: click('a1'), state: initialGuardState, fill: 'allow', fresh: 'allow' },
    { name: 'Jetzt bewerben (link) before input', call: click('a5'), state: initialGuardState, fill: 'allow', fresh: 'allow' },
    { name: 'Apply after input sends the form', call: click('a1'), state: typedHere, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'Apply called "Next" by the agent after input', call: click('a1', 'Next button'), state: typedHere, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'nameless Apply after input', call: click('a9'), state: typedHere, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'Jetzt bewerben after input', call: click('a5'), state: typedHere, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'Postuler after input', call: click('a6'), state: typedHere, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'Candidater after input', call: click('a11'), state: typedHere, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'Solicitar after input', call: click('a10'), state: typedHere, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'agent says Apply on a plain button after input', call: click('a8', 'Apply button'), state: typedHere, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'Submit application before input', call: click('a4'), state: initialGuardState, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'Submit application after input', call: click('a4'), state: typedHere, fill: denyReasons.submitInFill, fresh: 'allow' },
    { name: 'privacy checkbox with "candidate" after input', call: click('a7'), state: typedHere, fill: 'allow', fresh: 'allow' },
    { name: 'Attach resume after input', call: click('a8'), state: typedHere, fill: 'allow', fresh: 'allow' },
    { name: 'input on another page does not count here', call: click('a1'), state: { submitClicks: 0, inputPages: ['https://boards.greenhouse.io/acme/jobs/2'] }, fill: 'allow', fresh: 'allow' },
    { name: 'Apply after the one submit', call: click('a1'), state: { submitClicks: 1, inputPages: [formPage] }, fill: denyReasons.submitInFill, fresh: denyReasons.secondSubmit },
    { name: 'type into an unknown ref', call: [pw('browser_type'), { element: 'Email', target: 'zz', text: 'x' }], state: initialGuardState, fill: denyReasons.unknownRef, fresh: denyReasons.unknownRef },
    { name: 'press Enter', call: [pw('browser_press_key'), { key: 'Enter' }], state: typedHere, fill: denyReasons.enter, fresh: denyReasons.enter },
    { name: 'type submit:true', call: [pw('browser_type'), { element: 'First Name', target: 'a2', text: 'Illia', submit: true }], state: typedHere, fill: denyReasons.typeSubmit, fresh: denyReasons.typeSubmit },
    { name: 'upload outside the folder', call: [pw('browser_file_upload'), { paths: ['/etc/passwd'] }], state: initialGuardState, fill: upload, fresh: upload },
  ];

  for (const mode of ['fill', 'submit_fresh'] as const) {
    it.each(rows)(`${mode}: $name`, (row) => {
      const decision = guardDecision(mode, row.call[0], row.call[1], row.state, external);
      const expected = mode === 'fill' ? row.fill : row.fresh;
      if (expected === 'allow') expect(decision).toMatchObject({ allow: true });
      else expect(decision).toMatchObject({ allow: false, reason: expected, state: row.state });
    });
  }

  it('type, select, fill_form and upload mark the page; snapshots, clicks and cancelled uploads do not', () => {
    const marks = (tool: string, args: unknown) => guardDecision('fill', pw(tool), args, initialGuardState, external).state.inputPages;
    expect(marks('browser_type', { element: 'First Name', target: 'a2', text: 'Illia' })).toEqual([formPage]);
    expect(marks('browser_select_option', { element: 'Country', target: 'a3', values: ['IE'] })).toEqual([formPage]);
    expect(marks('browser_fill_form', { fields: [{ name: 'First Name', type: 'textbox', target: 'a2', value: 'Illia' }] })).toEqual([formPage]);
    expect(marks('browser_file_upload', { paths: [cv] })).toEqual([formPage]);
    expect(marks('browser_file_upload', {})).toEqual([]);
    expect(marks('browser_click', { element: 'Apply', target: 'a1' })).toEqual([]);
    expect(marks('browser_click', { element: 'Attach', target: 'a8' })).toEqual([]);
    // A click on a checkbox, radio, switch or option (role from the snapshot) is input.
    expect(marks('browser_click', { element: 'Consent', target: 'a7' })).toEqual([formPage]);
    expect(marks('browser_click', { element: 'Yes', target: 'a12' })).toEqual([formPage]);
    expect(marks('browser_click', { element: 'Remote', target: 'a13' })).toEqual([formPage]);
    expect(marks('browser_click', { element: 'Ireland', target: 'a14' })).toEqual([formPage]);
    // The agent calling a button a checkbox does not make it one.
    expect(marks('browser_click', { element: 'checkbox', target: 'a8' })).toEqual([]);
    expect(marks('browser_snapshot', {})).toEqual([]);
    // A denied input marks nothing.
    expect(marks('browser_file_upload', { paths: ['/etc/passwd'] })).toEqual([]);
  });

  it('fill: Apply opens the form, then typing, then Apply is denied', () => {
    const open = guardDecision('fill', ...click('a1'), initialGuardState, external);
    expect(open).toMatchObject({ allow: true, state: initialGuardState });
    const typed = guardDecision('fill', pw('browser_type'), { element: 'First Name', target: 'a2', text: 'Illia' }, open.state, external);
    expect(guardDecision('fill', ...click('a1'), typed.state, external)).toMatchObject({ allow: false, reason: denyReasons.submitInFill });
  });

  it('a form filled only by clicks on checkbox and radio: Apply after it is denied in fill, one submit in submit_fresh', () => {
    const clicksOnly = (mode: ApplyMode) => {
      const open = guardDecision(mode, ...click('a1'), initialGuardState, external);
      expect(open).toMatchObject({ allow: true, state: { submitClicks: 0, inputPages: [] } });
      const checked = guardDecision(mode, ...click('a7', 'Consent'), open.state, external);
      const radio = guardDecision(mode, ...click('a12', 'Yes'), checked.state, external);
      expect(radio).toMatchObject({ allow: true, state: { submitClicks: 0, inputPages: [formPage] } });
      return radio.state;
    };
    expect(guardDecision('fill', ...click('a1'), clicksOnly('fill'), external)).toMatchObject({ allow: false, reason: denyReasons.submitInFill });
    const filled = clicksOnly('submit_fresh');
    const sent = guardDecision('submit_fresh', ...click('a1'), filled, external);
    expect(sent).toMatchObject({ allow: true, state: { submitClicks: 1 } });
    expect(guardDecision('submit_fresh', ...click('a1'), sent.state, external)).toMatchObject({ allow: false, reason: denyReasons.secondSubmit });
    expect(guardDecision('submit_fresh', ...click('a4'), sent.state, external)).toMatchObject({ allow: false, reason: denyReasons.secondSubmit });
  });

  it('submit_fresh: open with Apply, fill, one submit; the second is denied', () => {
    const open = guardDecision('submit_fresh', ...click('a1'), initialGuardState, external);
    expect(open).toMatchObject({ allow: true, state: { submitClicks: 0 } });
    const typed = guardDecision('submit_fresh', pw('browser_type'), { element: 'First Name', target: 'a2', text: 'Illia' }, open.state, external);
    const sent = guardDecision('submit_fresh', ...click('a4'), typed.state, external);
    expect(sent).toMatchObject({ allow: true, state: { submitClicks: 1 } });
    expect(guardDecision('submit_fresh', ...click('a4'), sent.state, external)).toMatchObject({ allow: false, reason: denyReasons.secondSubmit });
    expect(guardDecision('submit_fresh', ...click('a1'), sent.state, external)).toMatchObject({ allow: false, reason: denyReasons.secondSubmit });
    // Typing into a submit-named element is never the submit.
    expect(guardDecision('submit_fresh', pw('browser_select_option'), { element: 'x', target: 'a4', values: ['1'] }, typed.state, external))
      .toMatchObject({ allow: false, reason: denyReasons.submitInFill });
  });

  it('navigation: start URL host and visited hosts are allowed, nothing else, https only', () => {
    const withStart: GuardContext = { ...external, startHost: 'careers.acme.test', visitedHosts: ['jobs.acme-corp.test'] };
    const go = (url: string, ctx: GuardContext = withStart) => guardDecision('fill', pw('browser_navigate'), { url }, initialGuardState, ctx);
    expect(go('https://careers.acme.test/jobs/1/apply')).toMatchObject({ allow: true });
    expect(go('https://CAREERS.acme.test/x')).toMatchObject({ allow: true });
    expect(go('https://jobs.acme-corp.test/form')).toMatchObject({ allow: true });
    expect(go('https://www.linkedin.com/jobs/view/1/')).toMatchObject({ allow: true });
    expect(go('https://acme.recruitee.com/o/dev')).toMatchObject({ allow: true });
    expect(go('http://careers.acme.test/jobs/1')).toMatchObject({ allow: false, reason: denyReasons.foreignSite });
    // Exact host, not its parent or siblings.
    expect(go('https://acme.test/')).toMatchObject({ allow: false, reason: denyReasons.foreignSite });
    expect(go('https://evil.careers.acme.test.example/')).toMatchObject({ allow: false, reason: denyReasons.foreignSite });
    expect(go('https://other.test/')).toMatchObject({ allow: false, reason: denyReasons.foreignSite });
    expect(go('https://careers.acme.test/', external)).toMatchObject({ allow: false, reason: denyReasons.foreignSite });
    expect(guardDecision('fill', pw('browser_tabs'), { action: 'new', url: 'https://jobs.acme-corp.test/' }, initialGuardState, withStart)).toMatchObject({ allow: true });
    expect(guardDecision('fill', pw('browser_tabs'), { action: 'new', url: 'https://other.test/' }, initialGuardState, withStart))
      .toMatchObject({ allow: false, reason: denyReasons.foreignSite });
    expect(denyReasons.foreignSite).toContain('"manual"');
  });

  it('helpers: ATS list and allowed URLs', () => {
    for (const domain of atsDomains) expect(isAllowedUrl(`https://x.${domain}/`, { startHost: null, visitedHosts: [] })).toBe(true);
    expect(isAllowedUrl('https://myworkdayjobs.com/', { startHost: null, visitedHosts: [] })).toBe(false);
    expect(isAllowedUrl('about:blank', { startHost: null, visitedHosts: [] })).toBe(false);
    expect(isAllowedUrl(undefined, { startHost: null, visitedHosts: [] })).toBe(false);
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
    expect(other).toEqual({ page: 'https://www.linkedin.com/feed/', refs: {}, hosts: ['www.linkedin.com'] });
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
    const { APPLY_MODE: _mode, APPLY_GUARD_DIR: _dir, APPLY_UPLOAD_DIR: _upload, APPLY_START_URL: _start, ...base } = process.env;
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
    // Only the allowed send click is marked in the log: the caller tells «maybe sent» by it.
    const log = readFileSync(path.join(dir, 'guard-log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(log.filter((entry) => entry.event !== 'post').map((entry) => [entry.decision, entry.submit])).toEqual([['allow', true], ['deny', false]]);
  });

  const externalForm = readFileSync(new URL('./fixtures/external/greenhouse-form-snapshot.txt', import.meta.url), 'utf8');
  const post = (tool: string, text: string) => ({ hook_event_name: 'PostToolUse', tool_name: pw(tool), tool_input: {}, tool_response: [{ type: 'text', text }] });
  const call = (tool: string, toolInput: unknown) => ({ tool_name: pw(tool), tool_input: toolInput });
  const navigate = (url: string) => call('browser_navigate', { url });

  it('external form in fill: Apply opens it, input is remembered, Apply after input is denied', () => {
    const dir = attempt();
    const env = { APPLY_MODE: 'fill', APPLY_GUARD_DIR: dir, APPLY_UPLOAD_DIR: uploadDir };
    expect(hook(post('browser_snapshot', externalForm), env)).toBe('');
    expect(hook(call('browser_click', { element: 'Apply', target: 'e12' }), env)).toBe('');
    expect(hook(call('browser_type', { element: 'First Name', target: 'e21', text: 'Illia' }), env)).toBe('');
    expect(readFileSync(path.join(dir, 'input-pages'), 'utf8')).toBe('https://job-boards.greenhouse.io/acme/jobs/1\n');
    expect(hook(call('browser_file_upload', { paths: [cv] }), env)).toBe('');
    // The page is written once.
    expect(readFileSync(path.join(dir, 'input-pages'), 'utf8')).toBe('https://job-boards.greenhouse.io/acme/jobs/1\n');
    expect(denied(hook(call('browser_click', { element: 'Next', target: 'e12' }), env)).permissionDecisionReason).toBe(denyReasons.submitInFill);
    expect(denied(hook(call('browser_click', { element: 'Next', target: 'e40' }), env)).permissionDecisionReason).toBe(denyReasons.submitInFill);
    // The consent checkbox mentions "candidate" but is not a submit.
    expect(hook(call('browser_click', { element: 'Consent', target: 'e30' }), env)).toBe('');
    expect(readFileSync(path.join(dir, 'input-pages'), 'utf8')).toBe('https://job-boards.greenhouse.io/acme/jobs/1\n');
    const log = readFileSync(path.join(dir, 'guard-log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(log.at(-1)).toMatchObject({ page: 'https://job-boards.greenhouse.io/acme/jobs/1', decision: 'allow' });
  });

  it('external form in fill filled only by a checkbox click: Apply is denied after it', () => {
    const dir = attempt();
    const env = { APPLY_MODE: 'fill', APPLY_GUARD_DIR: dir };
    expect(hook(post('browser_snapshot', externalForm), env)).toBe('');
    expect(hook(call('browser_click', { element: 'Apply', target: 'e12' }), env)).toBe('');
    expect(existsSync(path.join(dir, 'input-pages'))).toBe(false);
    expect(hook(call('browser_click', { element: 'Consent', target: 'e30' }), env)).toBe('');
    expect(denied(hook(call('browser_click', { element: 'Apply', target: 'e12' }), env)).permissionDecisionReason).toBe(denyReasons.submitInFill);
  });

  it('external form in submit_fresh: one submit across hook processes', () => {
    const dir = attempt();
    const env = { APPLY_MODE: 'submit_fresh', APPLY_GUARD_DIR: dir };
    expect(hook(post('browser_snapshot', externalForm), env)).toBe('');
    expect(hook(call('browser_click', { element: 'Apply', target: 'e12' }), env)).toBe('');
    expect(existsSync(path.join(dir, 'submit-click'))).toBe(false);
    expect(hook(call('browser_type', { element: 'First Name', target: 'e21', text: 'Illia' }), env)).toBe('');
    expect(hook(call('browser_click', { element: 'Submit', target: 'e40' }), env)).toBe('');
    expect(existsSync(path.join(dir, 'submit-click'))).toBe(true);
    expect(denied(hook(call('browser_click', { element: 'Submit', target: 'e40' }), env)).permissionDecisionReason).toBe(denyReasons.secondSubmit);
    expect(denied(hook(call('browser_click', { element: 'Apply', target: 'e12' }), env)).permissionDecisionReason).toBe(denyReasons.secondSubmit);
    expect(denied(hook({ tool_name: pw('browser_press_key'), tool_input: { key: 'Enter' } }, env)).permissionDecisionReason).toBe(denyReasons.enter);
  });

  it('hosts: the start URL host and hosts the browser reached are allowed, others are not', () => {
    const dir = attempt();
    const env = { APPLY_MODE: 'fill', APPLY_GUARD_DIR: dir };
    expect(denied(hook(navigate('https://careers.acme.test/jobs/1'), env)).permissionDecisionReason).toBe(denyReasons.foreignSite);
    expect(hook(navigate('https://careers.acme.test/jobs/1'), { ...env, APPLY_START_URL: 'https://careers.acme.test/jobs/1' })).toBe('');
    expect(denied(hook(navigate('http://careers.acme.test/jobs/1'), { ...env, APPLY_START_URL: 'https://careers.acme.test/jobs/1' })).permissionDecision).toBe('deny');
    // An http start URL widens nothing.
    expect(denied(hook(navigate('https://careers.acme.test/jobs/1'), { ...env, APPLY_START_URL: 'http://careers.acme.test/jobs/1' })).permissionDecision).toBe('deny');
    // LinkedIn's Apply button led to the company site: the click response shows its Page URL.
    expect(hook(post('browser_click', '- Page URL: https://jobs.acme-corp.test/apply?id=1\n'), env)).toBe('');
    expect(JSON.parse(readFileSync(path.join(dir, 'refs.json'), 'utf8')).hosts).toEqual(['jobs.acme-corp.test']);
    expect(hook(navigate('https://jobs.acme-corp.test/apply?id=2'), env)).toBe('');
    expect(denied(hook(navigate('https://evil.test/'), env)).permissionDecisionReason).toBe(denyReasons.foreignSite);
    // An http page is not remembered.
    expect(hook(post('browser_click', '- Page URL: http://plain.acme.test/\n'), env)).toBe('');
    expect(denied(hook(navigate('https://plain.acme.test/'), env)).permissionDecision).toBe('deny');
  });

  it('fails closed: bad input or no attempt folder denies the call', () => {
    expect(denied(hook('not json', { APPLY_MODE: 'submit', APPLY_GUARD_DIR: attempt() })).permissionDecisionReason).toMatch(/^Guard failed/);
    expect(denied(hook(submitClick, { APPLY_MODE: 'submit' })).permissionDecisionReason).toMatch(/APPLY_GUARD_DIR/);
    expect(denied(hook({ tool_name: pw('browser_snapshot') }, { APPLY_MODE: 'fill', APPLY_GUARD_DIR: '/nonexistent/dir' })).permissionDecision).toBe('deny');
  });
});
