/**
 * TypeScript / JavaScript language adapter. Each visual script is a module (`<path>.ts`, or
 * `.js` with output "JavaScript"): member variables become module-level `let`/`const`, functions
 * become (optionally exported, optionally async) functions, enums become `enum`s.
 */
import type { Diagnostic } from '@cs/graph-core';
import { stmtExprs, walkExpr, walkStmts, type IRExpr, type IRStmt } from '@cs/intermediate-representation';
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
  { id: 'class', name: 'Class', description: 'A class: variables become fields, functions become methods. Set "Extends" to build on another class, from a package (e.g. Phaser.Scene from phaser) or your project.', settings: { output: 'ts', kind: 'class', extends: '', extendsFrom: '' }, events: [] },
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
    { key: 'kind', label: 'Script is a', kind: 'select', default: 'module', options: [{ value: 'module', label: 'Module (functions and variables)' }, { value: 'class', label: 'Class (fields and methods; this)' }], description: 'A class can extend another class and use Self (this). A function named "constructor" becomes its constructor.' },
    { key: 'extends', label: 'Extends', kind: 'text', default: '', description: 'Class: the class it builds on, e.g. Phaser.Scene, Phaser.Physics.Arcade.Sprite, THREE.Mesh, or another script\'s class name. Empty = none.' },
    { key: 'extendsFrom', label: 'Extends — from package', kind: 'text', default: '', description: 'Where that class comes from: an npm package (phaser, three) or a script path (src/Enemy). Empty if it\'s a global (like Error or HTMLElement).' },
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
    for (const k of Object.keys(s)) if (!['output', 'kind', 'extends', 'extendsFrom'].includes(k)) report({ severity: 'warning', code: 'W_UNKNOWN_SETTING', message: `Unknown script setting "${k}" is ignored.` });
    const isClass = s.kind === 'class';
    if (s.kind !== undefined && s.kind !== 'module' && s.kind !== 'class') report({ severity: 'error', code: 'E_INVALID_SETTING', message: 'Script kind must be "module" or "class".' });
    const ext = typeof s.extends === 'string' ? s.extends.trim() : '';
    if (ext && !isClass) report({ severity: 'warning', code: 'W_EXTENDS_IGNORED', message: '"Extends" only applies when the script is a class.' });
    if (ext && !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(ext)) report({ severity: 'error', code: 'E_INVALID_SETTING', message: `"${ext}" isn't a class name (e.g. Phaser.Scene or Enemy).` });
    if (isClass) {
      if (script.functions.some((f) => f.component)) report({ severity: 'error', code: 'E_INVALID_SETTING', message: 'A class script can\'t have React components; make them in a module script.' });
      const ctor = script.functions.find((f) => f.name === 'constructor');
      if (ctor?.async) report({ severity: 'error', code: 'E_ASYNC_CONSTRUCTOR', message: 'A constructor can\'t be async.', functionId: ctor.id });
    } else if (script.functions.some((f) => f.name === 'constructor')) report({ severity: 'error', code: 'E_INVALID_NAME', message: 'Only a class script can have a "constructor"; set "Script is a" to Class.' });
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
    // Rules of hooks: use…() only at the top level of a component (not in a branch, loop or callback).
    const hookName = (e: IRExpr): string | undefined => (e.k === 'invoke' && e.callee.k === 'import' && /^use[A-Z]/.test(e.callee.name) ? e.callee.name : undefined);
    const nested = (stmts: IRStmt[], fnName: string, top: boolean) => {
      for (const s of stmts) {
        for (const e of stmtExprs(s))
          walkExpr(e, (x) => {
            const h = hookName(x);
            if (h && !top) out.push({ severity: 'error', code: 'E_HOOK_RULES', message: `${fnName}: ${h}() is inside a branch, loop or try block. React needs hooks called in the same order on every render.`, suggestion: 'Move it to the start of the component.', scriptId: module.scriptId, ...(s.src?.graphId ? { graphId: s.src.graphId } : {}), ...(s.src?.nodeId ? { nodeId: s.src.nodeId } : {}) });
            if (x.k === 'lambda') nested(x.body, fnName, false);
          });
        const blocks: IRStmt[][] = s.k === 'if' ? [s.then, s.else ?? []] : s.k === 'while' || s.k === 'for_range' || s.k === 'for_each' ? [s.body] : s.k === 'match' ? [...s.arms.map((a) => a.body), s.default ?? []] : s.k === 'try' ? [s.body, s.handler ?? [], s.finally ?? []] : [];
        for (const b of blocks) nested(b, fnName, false);
      }
    };
    for (const m of module.members) if (m.k === 'function' && (m.component || /^use[A-Z]/.test(m.name))) nested(m.body, m.name, true);
    // Setting state while rendering re-renders, which sets it again: React gives up with "Too many re-renders".
    const blocksOf = (s: IRStmt): IRStmt[][] => (s.k === 'if' ? [s.then, s.else ?? []] : s.k === 'while' || s.k === 'for_range' || s.k === 'for_each' ? [s.body] : s.k === 'match' ? [...s.arms.map((a) => a.body), s.default ?? []] : s.k === 'try' ? [s.body, s.handler ?? [], s.finally ?? []] : []);
    for (const m of module.members) {
      if (m.k !== 'function' || !(m.component || /^use[A-Z]/.test(m.name))) continue;
      const states = new Set<string>();
      for (const s of m.body) if (s.k === 'var_tuple' && s.init.k === 'invoke' && s.init.callee.k === 'import' && s.init.callee.name === 'useState') states.add(s.names[0]);
      if (!states.size) continue;
      const scan = (stmts: IRStmt[]) => {
        for (const s of stmts) {
          if (s.k === 'assign' && s.target.k === 'ref' && states.has(s.target.name))
            out.push({ severity: 'error', code: 'E_SET_STATE_IN_RENDER', message: `${m.name}: "${s.target.name}" is set while the component is drawing. That redraws it, which sets it again, forever (React stops with "Too many re-renders").`, suggestion: `Set ${s.target.name} inside an event handler (an Inline Function wired to onClick, onChange…) or an effect, not in ${m.name}'s main flow.`, scriptId: module.scriptId, ...(s.src?.graphId ? { graphId: s.src.graphId } : {}), ...(s.src?.nodeId ? { nodeId: s.src.nodeId } : {}) });
          for (const b of blocksOf(s)) scan(b);
        }
      };
      scan(m.body);
    }
    for (const m of module.members) {
      if (m.k !== 'function') continue;
      walkStmts(m.body, (s) => {
        for (const e of stmtExprs(s))
          walkExpr(e, (x) => {
            if (x.k === 'self' && module.settings.kind !== 'class') out.push({ severity: 'error', code: 'E_NO_THIS', message: `${m.name}: a module has no "self"/this. Make the script a Class (Script settings → Script is a), or connect an object to the node's target.`, scriptId: module.scriptId, ...(s.src?.graphId ? { graphId: s.src.graphId } : {}), ...(s.src?.nodeId ? { nodeId: s.src.nodeId } : {}) });
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
    const css = printer.css();
    return [{ path: `${module.path}.${mode}${printer.usesJsx() ? 'x' : ''}`, content, sourceMap }, ...(css ? [{ path: `${module.path}.anim.css`, content: `/* Animations for the visual script "${module.name}" (generated by Coding Studio; edit them in the graph). */\n\n${css}\n`, sourceMap: [] }] : [])];
  },
};

export default typescriptAdapter;
export { scanExports, type ExportedFunction } from './exports';
export { parseDisplay, parseParams, canonicalFromTs, type ApiParam, type ApiSignature } from './catalog';
