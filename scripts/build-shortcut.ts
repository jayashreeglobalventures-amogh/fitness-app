// Builds the "Send steps to Fitness" Apple Shortcut, signs it with macOS's own `shortcuts sign` (iPhones only add
// signed shortcuts), and puts it in web/public so the app can offer it: Profile → Steps from Apple Health →
// "Set up on this iPhone". Run on a Mac signed in to iCloud (with iCloud Drive on):  npm run shortcut
// (builds one file per app - production and test - each pointing at its own address; or pass one https address).
//
// The Shortcut: asks once for the person's sync key (an import question) → Find Health Samples (Steps, grouped by
// day, latest first, 1) → Calculate Statistics (Sum) → POST {steps, date} to /api/health-sync with the key →
// shows the reply as a notification. The server ignores a count whose date isn't today.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ORIGINS = ['https://fitness.amogh.systems', 'https://fitness-test.amogh.systems']; // production, test
const targets = (process.argv[2] ? [process.argv[2]] : ORIGINS).map((o) => o.replace(/\/+$/, ''));
for (const o of targets) if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) { console.error(`Give the app's https address, e.g. https://fitness.amogh.systems (got ${o})`); process.exit(1); }
/** Each app offers the Shortcut built for its own address: web/public/shortcuts/<host>.shortcut */
const fileFor = (o: string) => `web/public/shortcuts/${new URL(o).host}.shortcut`;

// ---------- a tiny XML plist writer ----------
type P = string | number | boolean | P[] | { [k: string]: P };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plist(v: P): string {
  if (typeof v === 'string') return `<string>${esc(v)}</string>`;
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (typeof v === 'number') return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (Array.isArray(v)) return `<array>${v.map(plist).join('')}</array>`;
  return `<dict>${Object.entries(v).map(([k, x]) => `<key>${esc(k)}</key>${plist(x)}`).join('')}</dict>`;
}

// ---------- Shortcuts building blocks ----------
const OBJ = '￼'; // where a variable sits inside a text
const output = (uuid: string, name: string, aggrandizements?: P[]) => ({ OutputUUID: uuid, Type: 'ActionOutput', OutputName: name, ...(aggrandizements ? { Aggrandizements: aggrandizements } : {}) });
/** A text made of plain parts and variables. */
function text(...parts: (string | Record<string, P>)[]): P {
  let s = '';
  const attachments: Record<string, P> = {};
  for (const p of parts) {
    if (typeof p === 'string') s += p;
    else { attachments[`{${s.length}, 1}`] = p; s += OBJ; }
  }
  return { Value: { string: s, attachmentsByRange: attachments }, WFSerializationType: 'WFTextTokenString' };
}
const variable = (v: Record<string, P>): P => ({ Value: v, WFSerializationType: 'WFTextTokenAttachment' });
/** A dictionary of text keys → text values (headers, JSON body). */
const dict = (items: [string, P][]): P => ({
  Value: { WFDictionaryFieldValueItems: items.map(([k, v]) => ({ WFItemType: 0, WFKey: text(k), WFValue: v })) },
  WFSerializationType: 'WFDictionaryFieldValue',
});

function build(origin: string, out: string): void {
const id = { key: randomUUID().toUpperCase(), samples: randomUUID().toUpperCase(), sum: randomUUID().toUpperCase(), send: randomUUID().toUpperCase() };
const actions: P[] = [
  // 0: the sync key (filled in once, when the person adds the Shortcut)
  { WFWorkflowActionIdentifier: 'is.workflow.actions.gettext', WFWorkflowActionParameters: { UUID: id.key, WFTextActionText: '' } },
  // 1: today's steps from Health: grouped by day (so phone + watch are not counted twice), the latest day only
  { WFWorkflowActionIdentifier: 'is.workflow.actions.filter.health.quantity', WFWorkflowActionParameters: {
    UUID: id.samples,
    WFContentItemFilter: { Value: { WFActionParameterFilterPrefix: 1, WFContentPredicateBoundedDate: false, WFActionParameterFilterTemplates: [
      { Operator: 4, Property: 'Type', Removable: false, Values: { Enumeration: 'Steps' } },
    ] }, WFSerializationType: 'WFContentPredicateTableTemplate' },
    WFHKSampleFilteringGroupBy: 'Day', WFHKSampleFilteringFillMissing: false,
    WFContentItemSortProperty: 'Start Date', WFContentItemSortOrder: 'Latest First',
    WFContentItemLimitEnabled: true, WFContentItemLimitNumber: 1,
  } },
  // 2: the total as a plain number
  { WFWorkflowActionIdentifier: 'is.workflow.actions.statistics', WFWorkflowActionParameters: {
    UUID: id.sum, WFStatisticsOperation: 'Sum', Input: variable(output(id.samples, 'Health Samples')) } },
  // 3: send it (with the day it belongs to, so a stale count is ignored)
  { WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl', WFWorkflowActionParameters: {
    UUID: id.send, WFURL: `${origin}/api/health-sync`, WFHTTPMethod: 'POST', WFHTTPBodyType: 'JSON', ShowHeaders: true,
    WFHTTPHeaders: dict([['Authorization', text('Bearer ', output(id.key, 'Text'))]]),
    WFJSONValues: dict([
      ['steps', text(output(id.sum, 'Statistics'))],
      ['date', text(output(id.samples, 'Health Samples', [{ Type: 'WFPropertyVariableAggrandizement', PropertyName: 'Start Date' }]))],
      ['source', text('Apple Health Shortcut')],
    ]),
  } },
  // 4: the app's reply, e.g. "Calamari: 8,214 steps saved for 23 Nov - target met ✅"
  { WFWorkflowActionIdentifier: 'is.workflow.actions.notification', WFWorkflowActionParameters: {
    WFNotificationActionTitle: 'Fitness', WFNotificationActionBody: text(output(id.send, 'Contents of URL')), WFNotificationActionSound: false } },
];

const shortcut: P = {
  WFWorkflowClientVersion: '2607.0.2', WFWorkflowMinimumClientVersion: 900, WFWorkflowMinimumClientVersionString: '900',
  WFWorkflowIcon: { WFWorkflowIconStartColor: 4282601983, WFWorkflowIconGlyphNumber: 59811 },
  WFWorkflowTypes: [], WFWorkflowInputContentItemClasses: [], WFWorkflowOutputContentItemClasses: [], WFWorkflowHasShortcutInputVariables: false,
  WFWorkflowImportQuestions: [{ ActionIndex: 0, Category: 'Parameter', ParameterKey: 'WFTextActionText', DefaultValue: '',
    Text: 'Paste your sync key (Fitness → Profile → Steps from Apple Health copied it for you).' }],
  WFWorkflowActions: actions,
};

const dir = mkdtempSync(join(tmpdir(), 'fitness-shortcut-'));
const raw = join(dir, 'Send steps to Fitness.shortcut');
writeFileSync(raw, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plist(shortcut)}</plist>\n`);
execFileSync('plutil', ['-convert', 'binary1', raw]);
try {
  execFileSync('shortcuts', ['sign', '--mode', 'anyone', '--input', raw, '--output', out], { stdio: 'inherit' });
} catch {
  console.error('\nSigning failed. Make sure this Mac is signed in to iCloud (System Settings → your name) and the Shortcuts app has been opened once, then run this again.');
  process.exit(1);
}
console.log(`Signed shortcut for ${origin} → ${out}`);
}

mkdirSync('web/public/shortcuts', { recursive: true });
for (const o of targets) build(o, fileFor(o));
