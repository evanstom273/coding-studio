/**
 * TypeScript / JavaScript language adapter. Each visual script is a module (`<path>.ts`, or
 * `.js` with output "JavaScript"): member variables become module-level `let`/`const`, functions
 * become (optionally exported, optionally async) functions, enums become `enum`s.
 */
import type { Diagnostic } from '@cs/graph-core';
import { stmtExprs, walkExpr, walkStmts, type IRExpr } from '@cs/intermediate-representation';
import { allCapabilities, type LanguageAdapter, type ScriptTemplate } from '@cs/language-sdk';
import { T } from '@cs/type-system';
import { typescriptNodes, LANG } from './nodes';
import { IDENT, TSPrinter, type OutputMode } from './printer';
import { typescriptTypes } from './types';
import { typescriptEntry } from './entry';

export { relativeModule, templateFields } from './nodes';
export { tsType, normalize as normalizeTsType } from './types';
export { TSPrinter, ImportManager } from './printer';

const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await async of undefined NaN Infinity arguments eval'.split(' '),
);

export const TS_TEMPLATES: ScriptTemplate[] = [
  { id: 'module', name: 'Module', description: 'A module with an exported main() function.', settings: { output: 'ts' }, events: [], functions: [{ name: 'main', exported: true }] },
  { id: 'async-module', name: 'Async module', description: 'A module with an exported async main() (use Await, fetch…).', settings: { output: 'ts' }, events: [], functions: [{ name: 'main', exported: true, async: true }] },
  { id: 'web-app', name: 'Web app (React + Tailwind + Dexie)', description: 'A Vite project: the App component as a graph, a Dexie database and a todo list. Runs in Preview.', settings: { output: 'ts' }, events: [] },
  { id: 'empty', name: 'Empty module', description: 'No functions yet.', settings: { output: 'ts' }, events: [] },
];

export const stateSetter = (name: string) => `set${name.replace(/^./, (c) => c.toUpperCase())}`;

const outputMode = (s: Record<string, unknown>): OutputMode => (s.output === 'js' ? 'js' : 'ts');

export const typescriptAdapter: LanguageAdapter = {
  id: LANG,
  name: 'TypeScript',
  extensions: ['.ts', '.js'],
  versions: [
    { id: 'es2022', label: 'ES2022' },
    { id: 'esnext', label: 'ESNext' },
  ],
  defaultVersion: 'es2022',
  capabilities: {
    ...allCapabilities(false),
    classes: true,
    exceptions: true,
    async: true,
    modules: true,
    imports: true,
    typeInference: true,
    generics: true,
    memberVariables: true,
    exportedVariables: true,
    enums: true,
    match: true,
    nullable: true,
    dynamicTyping: true,
    closures: true,
    interfaces: true,
  },
  types: typescriptTypes,
  identifiers: {
    isValid: (n) => IDENT.test(n),
    reserved: RESERVED,
    description: 'Use letters, digits, _ and $, not starting with a digit (camelCase is conventional).',
  },
  scriptSettings: [
    { key: 'output', label: 'Output', kind: 'select', default: 'ts', options: [{ value: 'ts', label: 'TypeScript (.ts)' }, { value: 'js', label: 'JavaScript (.js)' }], description: 'Write typed TypeScript or plain JavaScript (ES modules).' },
  ],
  events: [],
  templates: TS_TEMPLATES,
  entryPoint: typescriptEntry,
  registerNodes(registry) {
    registry.registerAll(typescriptNodes());
  },
  declareLocal(local, _type, init) {
    // React state: const [count, setCount] = useState(initial). Set Variable then calls the setter.
    if (local.attributes?.state !== true) return undefined;
    return { k: 'var_tuple', names: [local.name, stateSetter(local.name)], constant: true, init: { k: 'invoke', callee: { k: 'import', module: 'react', name: 'useState', kind: 'named' }, args: init ? [init] : [] } };
  },
  literal(value, type): IRExpr | undefined {
    if (type.kind === 'named' && !typescriptTypes.universe.isKnown(type.name)) {
      if (typeof value === 'string' && IDENT.test(value)) return { k: 'enum', enumName: type.name, member: value };
      if (typeof value === 'number') return { k: 'lit', value: Math.trunc(value), type: T.int };
    }
    return undefined;
  },
  validateScript(script, report) {
    const s = script.settings;
    if (s.output !== undefined && s.output !== 'ts' && s.output !== 'js') report({ severity: 'error', code: 'E_INVALID_SETTING', message: 'Output must be "ts" or "js".' });
    for (const k of Object.keys(s)) if (k !== 'output') report({ severity: 'warning', code: 'W_UNKNOWN_SETTING', message: `Unknown script setting "${k}" is ignored.` });
    for (const f of script.functions) {
      for (const l of f.locals) {
        if (l.attributes?.state !== true) continue;
        if (!f.component && !/^use[A-Z]/.test(f.name)) report({ severity: 'error', code: 'E_STATE_OUTSIDE_COMPONENT', message: `${f.name}.${l.name}: React state only works in components (or hooks named use…). Tick "component" on ${f.name}.`, functionId: f.id });
        const setter = stateSetter(l.name);
        if ([...f.locals, ...f.params, ...script.variables, ...script.functions].some((x) => x.name === setter)) report({ severity: 'error', code: 'E_DUPLICATE_IDENTIFIER', message: `${f.name}: "${setter}" (the setter of state ${l.name}) is already used.`, functionId: f.id });
      }
    }
    if (script.signals.length) report({ severity: 'error', code: 'E_UNSUPPORTED', message: 'TypeScript modules have no signals; use a callback (Function as Value) or an EventTarget instead.' });
  },
  validate(module) {
    const out: Diagnostic[] = [];
    for (const m of module.members) {
      if (m.k !== 'function') continue;
      walkStmts(m.body, (s) => {
        for (const e of stmtExprs(s))
          walkExpr(e, (x) => {
            if (x.k === 'self') out.push({ severity: 'error', code: 'E_NO_THIS', message: `${m.name}: a module has no "self"/this. Connect an object to the node's target instead.`, scriptId: module.scriptId, ...(s.src?.graphId ? { graphId: s.src.graphId } : {}), ...(s.src?.nodeId ? { nodeId: s.src.nodeId } : {}) });
          });
      });
    }
    return out;
  },
  generate(module, ctx) {
    const mode = outputMode(module.settings);
    const header = `Generated by Coding Studio from the visual script "${module.name}".\nEdit the graph in Coding Studio; changes made here are overwritten on the next export.`;
    const printer = new TSPrinter(module, mode);
    const { content, sourceMap } = printer.render(ctx, header);
    return [{ path: `${module.path}.${mode}${printer.usesJsx() ? 'x' : ''}`, content, sourceMap }];
  },
};

export default typescriptAdapter;
export { scanExports, type ExportedFunction } from './exports';
export { parseDisplay, parseParams, canonicalFromTs, type ApiParam, type ApiSignature } from './catalog';
