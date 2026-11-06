/**
 * GDScript 2.0 language adapter (Godot 4.x).
 */
import type { Diagnostic } from '@cs/graph-core';
import type { IRExpr, IRField } from '@cs/intermediate-representation';
import { allCapabilities, type EventTemplate, type LanguageAdapter, type ScriptTemplate } from '@cs/language-sdk';
import { T } from '@cs/type-system';
import { GDScriptPrinter } from './generator';
import { godotNodes, LANG } from './nodes';
import { CLASS_PARENTS, gdscriptTypes, universe, VALUE_TYPES } from './types';

export { GODOT_API } from './api';
export { CLASS_PARENTS, VALUE_TYPES } from './types';

const KEYWORDS = [
  'if', 'elif', 'else', 'for', 'while', 'match', 'when', 'break', 'continue', 'pass', 'return', 'class', 'class_name', 'extends', 'is', 'in', 'as',
  'self', 'super', 'signal', 'func', 'static', 'const', 'enum', 'var', 'breakpoint', 'preload', 'await', 'yield', 'assert', 'void', 'and', 'or', 'not',
  'true', 'false', 'null', 'PI', 'TAU', 'INF', 'NAN', 'namespace', 'trait',
  // built-in type names cannot be used as identifiers
  'bool', 'int', 'float', 'String', 'Variant', 'Array', 'Dictionary', 'Object', 'Callable', 'Signal', 'StringName', 'NodePath',
];

const RESERVED = new Set<string>([...KEYWORDS, ...Object.keys(VALUE_TYPES)]);

export const GDSCRIPT_EVENTS: EventTemplate[] = [
  { id: '_ready', name: '_ready', title: 'Ready', description: 'Called once when the node and its children have entered the scene tree.', params: [], returnType: 'void', baseClass: 'Node' },
  { id: '_process', name: '_process', title: 'Process', description: 'Called every frame. delta = seconds since the previous frame.', params: [{ name: 'delta', type: 'float' }], returnType: 'void', baseClass: 'Node' },
  { id: '_physics_process', name: '_physics_process', title: 'Physics Process', description: 'Called every physics tick (60 per second by default). Use for movement and physics.', params: [{ name: 'delta', type: 'float' }], returnType: 'void', baseClass: 'Node' },
  { id: '_input', name: '_input', title: 'Input', description: 'Called for every input event.', params: [{ name: 'event', type: 'InputEvent' }], returnType: 'void', baseClass: 'Node' },
  { id: '_unhandled_input', name: '_unhandled_input', title: 'Unhandled Input', description: 'Called for input events not consumed by the GUI or _input.', params: [{ name: 'event', type: 'InputEvent' }], returnType: 'void', baseClass: 'Node' },
  { id: '_unhandled_key_input', name: '_unhandled_key_input', title: 'Unhandled Key Input', description: 'Called for unhandled key events.', params: [{ name: 'event', type: 'InputEvent' }], returnType: 'void', baseClass: 'Node' },
  { id: '_enter_tree', name: '_enter_tree', title: 'Enter Tree', description: 'Called when the node enters the scene tree (before _ready).', params: [], returnType: 'void', baseClass: 'Node' },
  { id: '_exit_tree', name: '_exit_tree', title: 'Exit Tree', description: 'Called when the node is about to leave the scene tree.', params: [], returnType: 'void', baseClass: 'Node' },
  { id: '_init', name: '_init', title: 'Init', description: 'Constructor: called when the object is created.', params: [], returnType: 'void', baseClass: 'Object' },
  { id: '_draw', name: '_draw', title: 'Draw', description: 'Custom 2D drawing (call queue_redraw to refresh).', params: [], returnType: 'void', baseClass: 'CanvasItem' },
  { id: '_notification', name: '_notification', title: 'Notification', description: 'Low-level engine notifications.', params: [{ name: 'what', type: 'int' }], returnType: 'void', baseClass: 'Object' },
];

export const GDSCRIPT_TEMPLATES: ScriptTemplate[] = [
  { id: 'node', name: 'Node', description: 'A plain Node script with _ready and _process.', settings: { extends: 'Node', class_name: '', tool: false }, events: ['_ready', '_process'] },
  { id: 'node2d', name: 'Node2D', description: 'A 2D node with _ready and _process.', settings: { extends: 'Node2D', class_name: '', tool: false }, events: ['_ready', '_process'] },
  { id: 'node3d', name: 'Node3D', description: 'A 3D node with _ready and _process.', settings: { extends: 'Node3D', class_name: '', tool: false }, events: ['_ready', '_process'] },
  { id: 'character2d', name: 'CharacterBody2D', description: 'A 2D character with _physics_process.', settings: { extends: 'CharacterBody2D', class_name: '', tool: false }, events: ['_physics_process'] },
  { id: 'character3d', name: 'CharacterBody3D', description: 'A 3D character with _physics_process.', settings: { extends: 'CharacterBody3D', class_name: '', tool: false }, events: ['_physics_process'] },
  { id: 'control', name: 'Control', description: 'A UI control with _ready.', settings: { extends: 'Control', class_name: '', tool: false }, events: ['_ready'] },
  { id: 'refcounted', name: 'RefCounted (plain class)', description: 'A plain class with no scene-tree callbacks.', settings: { extends: 'RefCounted', class_name: '', tool: false }, events: [] },
];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isNodeClass(name: string | undefined) {
  let cur = name;
  while (cur) {
    if (cur === 'Node') return true;
    cur = CLASS_PARENTS[cur];
  }
  return false;
}

export const gdscriptAdapter: LanguageAdapter = {
  id: LANG,
  name: 'GDScript',
  extensions: ['.gd'],
  versions: [
    { id: '4.2', label: 'Godot 4.2' },
    { id: '4.3', label: 'Godot 4.3' },
    { id: '4.4', label: 'Godot 4.4' },
    { id: '4.5', label: 'Godot 4.5' },
  ],
  defaultVersion: '4.4',
  capabilities: {
    ...allCapabilities(false),
    classes: true,
    inheritance: true,
    async: true,
    coroutines: true,
    lifecycleEvents: true,
    signals: true,
    properties: true,
    imports: true,
    typeInference: true,
    memberVariables: true,
    exportedVariables: true,
    enums: true,
    match: true,
    nullable: true,
    dynamicTyping: true,
  },
  types: gdscriptTypes,
  identifiers: {
    isValid: (n) => IDENT.test(n),
    reserved: RESERVED,
    description: 'Use letters, digits and underscores, not starting with a digit (snake_case is conventional).',
  },
  scriptSettings: [
    { key: 'extends', label: 'Extends', kind: 'string', default: 'Node', description: 'Base class (e.g. CharacterBody2D) or a res:// script path.' },
    { key: 'class_name', label: 'Class name', kind: 'string', default: '', description: 'Optional global class name (PascalCase).' },
    { key: 'tool', label: '@tool', kind: 'boolean', default: false, description: 'Run the script in the Godot editor too.' },
  ],
  events: GDSCRIPT_EVENTS,
  templates: GDSCRIPT_TEMPLATES,
  registerNodes(registry) {
    registry.registerAll(godotNodes());
  },
  literal(value, type): IRExpr | undefined {
    // Script enums: allow a member name or its integer value.
    if (type.kind === 'named' && !universe.isKnown(type.name)) {
      if (typeof value === 'string' && IDENT.test(value)) return { k: 'enum', enumName: type.name, member: value };
      if (typeof value === 'number') return { k: 'lit', value: Math.trunc(value), type: T.int };
    }
    return undefined;
  },
  validateScript(script, report) {
    const s = script.settings;
    const ext = typeof s.extends === 'string' ? s.extends.trim() : '';
    if (!ext) report({ severity: 'warning', code: 'W_NO_BASE_CLASS', message: 'The script has no "extends"; Godot will use RefCounted.', suggestion: 'Set Extends in the script settings (e.g. Node2D).' });
    else if (!ext.startsWith('res://') && !IDENT.test(ext)) report({ severity: 'error', code: 'E_INVALID_BASE_CLASS', message: `"${ext}" is not a valid class name or res:// path.` });
    else if (!ext.startsWith('res://') && !universe.isKnown(ext)) report({ severity: 'warning', code: 'W_UNKNOWN_BASE_CLASS', message: `"${ext}" is not in the built-in class list; make sure it is a class_name defined in your Godot project.` });
    if (s.class_name !== undefined && s.class_name !== '' && (typeof s.class_name !== 'string' || !IDENT.test(s.class_name))) report({ severity: 'error', code: 'E_INVALID_IDENTIFIER', message: 'class_name must be a valid identifier.' });
    if (typeof s.class_name === 'string' && (universe.isKnown(s.class_name) || RESERVED.has(s.class_name))) report({ severity: 'error', code: 'E_CLASS_NAME_CONFLICT', message: `class_name "${s.class_name}" conflicts with a built-in class.` });
    if (s.tool !== undefined && typeof s.tool !== 'boolean') report({ severity: 'error', code: 'E_INVALID_SETTING', message: '"tool" must be true or false.' });
    for (const k of Object.keys(s)) if (!['extends', 'class_name', 'tool'].includes(k)) report({ severity: 'warning', code: 'W_UNKNOWN_SETTING', message: `Unknown script setting "${k}" is ignored.` });
    for (const v of script.variables) {
      const attrs = v.attributes ?? {};
      for (const k of Object.keys(attrs)) if (k !== 'onreadyPath') report({ severity: 'warning', code: 'W_UNKNOWN_ATTRIBUTE', message: `Unknown attribute "${k}" on ${v.name} is ignored.` });
      if (attrs.onreadyPath !== undefined) {
        if (typeof attrs.onreadyPath !== 'string' || !attrs.onreadyPath.trim()) report({ severity: 'error', code: 'E_INVALID_ATTRIBUTE', message: `${v.name}: @onready node path must be a non-empty string.` });
        if (v.constant || v.exported) report({ severity: 'error', code: 'E_INVALID_ATTRIBUTE', message: `${v.name}: @onready cannot be combined with const or @export.` });
        if (v.default !== undefined) report({ severity: 'warning', code: 'W_ONREADY_DEFAULT', message: `${v.name}: the default value is replaced by the @onready node path.` });
        if (ext && !ext.startsWith('res://') && universe.isKnown(ext) && !isNodeClass(ext)) report({ severity: 'error', code: 'E_ONREADY_NOT_NODE', message: `@onready only works in scripts that extend Node (this one extends ${ext}).` });
      }
    }
  },
  validate(module) {
    const out: Diagnostic[] = [];
    for (const m of module.members) {
      if (m.k === 'field') {
        const f = m as IRField;
        if (f.exported && f.type.kind === 'any' && !f.init) out.push({ severity: 'error', code: 'E_EXPORT_UNTYPED', message: `@export variable "${f.name}" needs a type or a default value.`, scriptId: module.scriptId });
      }
    }
    return out;
  },
  generate(module, ctx) {
    const header = `Generated by Coding Studio from the visual script "${module.name}".\nEdit the graph in Coding Studio; changes made here are overwritten on the next export.`;
    const printer = new GDScriptPrinter(module);
    const { content, sourceMap } = printer.render(ctx, header);
    return [{ path: `${module.path}.gd`, content, sourceMap }];
  },
};

export default gdscriptAdapter;
