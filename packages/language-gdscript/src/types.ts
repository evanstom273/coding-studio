/**
 * GDScript (Godot 4) type rules: class hierarchy, value types, spelling and operator results.
 * Only well-known engine classes are listed; scripts may still extend other classes (with a
 * warning) and use "Call Method (by name)" for anything not covered here.
 */
import { defaultCompatibility, formatType, T, type Compatibility, type TypeRef, type TypeUniverse } from '@cs/type-system';
import type { BinaryOp } from '@cs/intermediate-representation';
import type { LanguageTypes } from '@cs/language-sdk';

/** class → parent (Godot 4.x ClassDB, abbreviated to commonly scripted classes). */
export const CLASS_PARENTS: Record<string, string | undefined> = {
  Object: undefined,
  Node: 'Object',
  CanvasItem: 'Node',
  Node2D: 'CanvasItem',
  Sprite2D: 'Node2D',
  AnimatedSprite2D: 'Node2D',
  Camera2D: 'Node2D',
  Marker2D: 'Node2D',
  CollisionObject2D: 'Node2D',
  Area2D: 'CollisionObject2D',
  PhysicsBody2D: 'CollisionObject2D',
  CharacterBody2D: 'PhysicsBody2D',
  RigidBody2D: 'PhysicsBody2D',
  StaticBody2D: 'PhysicsBody2D',
  CollisionShape2D: 'Node2D',
  RayCast2D: 'Node2D',
  AudioStreamPlayer2D: 'Node2D',
  Control: 'CanvasItem',
  Label: 'Control',
  BaseButton: 'Control',
  Button: 'BaseButton',
  Range: 'Control',
  ProgressBar: 'Range',
  Panel: 'Control',
  Node3D: 'Node',
  Camera3D: 'Node3D',
  Marker3D: 'Node3D',
  VisualInstance3D: 'Node3D',
  GeometryInstance3D: 'VisualInstance3D',
  MeshInstance3D: 'GeometryInstance3D',
  CollisionObject3D: 'Node3D',
  Area3D: 'CollisionObject3D',
  PhysicsBody3D: 'CollisionObject3D',
  CharacterBody3D: 'PhysicsBody3D',
  RigidBody3D: 'PhysicsBody3D',
  StaticBody3D: 'PhysicsBody3D',
  CollisionShape3D: 'Node3D',
  RayCast3D: 'Node3D',
  AudioStreamPlayer3D: 'Node3D',
  Timer: 'Node',
  AnimationMixer: 'Node',
  AnimationPlayer: 'AnimationMixer',
  AudioStreamPlayer: 'Node',
  Viewport: 'Node',
  Window: 'Viewport',
  MainLoop: 'Object',
  SceneTree: 'MainLoop',
  RefCounted: 'Object',
  SceneTreeTimer: 'RefCounted',
  Tween: 'RefCounted',
  KinematicCollision2D: 'RefCounted',
  KinematicCollision3D: 'RefCounted',
  Resource: 'RefCounted',
  PackedScene: 'Resource',
  Texture2D: 'Resource',
  AudioStream: 'Resource',
  Script: 'Resource',
  InputEvent: 'Resource',
  InputEventFromWindow: 'InputEvent',
  InputEventWithModifiers: 'InputEventFromWindow',
  InputEventKey: 'InputEventWithModifiers',
  InputEventMouse: 'InputEventWithModifiers',
  InputEventMouseMotion: 'InputEventMouse',
  InputEventMouseButton: 'InputEventMouse',
  InputEventAction: 'InputEvent',
  InputEventJoypadButton: 'InputEvent',
  InputEventJoypadMotion: 'InputEvent',
};

/** Built-in (non-Object) value types. Fields are used to build literals from JSON. */
export const VALUE_TYPES: Record<string, { name: string; type: TypeRef }[] | null> = {
  Vector2: [
    { name: 'x', type: T.float },
    { name: 'y', type: T.float },
  ],
  Vector2i: [
    { name: 'x', type: T.int },
    { name: 'y', type: T.int },
  ],
  Vector3: [
    { name: 'x', type: T.float },
    { name: 'y', type: T.float },
    { name: 'z', type: T.float },
  ],
  Vector3i: [
    { name: 'x', type: T.int },
    { name: 'y', type: T.int },
    { name: 'z', type: T.int },
  ],
  Color: [
    { name: 'r', type: T.float },
    { name: 'g', type: T.float },
    { name: 'b', type: T.float },
    { name: 'a', type: T.float },
  ],
  Rect2: null,
  Transform2D: null,
  Transform3D: null,
  Basis: null,
  Quaternion: null,
  NodePath: null,
  StringName: null,
  Callable: null,
  Signal: null,
};

const VECTORS = new Set(['Vector2', 'Vector2i', 'Vector3', 'Vector3i', 'Color']);

export const universe: TypeUniverse = {
  parentOf: (n) => CLASS_PARENTS[n],
  isReferenceType: (n) => n in CLASS_PARENTS,
  isKnown: (n) => n in CLASS_PARENTS || n in VALUE_TYPES,
};

/** Split "A, B<C, D>" on top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '[' || ch === '<') depth++;
    if (ch === ']' || ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** GDScript spellings → canonical. Accepts canonical text unchanged. */
export function normalize(text: string): string | undefined {
  const s = text.trim();
  const simple: Record<string, string> = { String: 'string', Variant: 'any', Array: 'array<any>', Dictionary: 'map<any, any>', void: 'void', bool: 'bool', int: 'int', float: 'float' };
  if (simple[s]) return simple[s];
  let m = /^Array\[(.+)\]$/.exec(s);
  if (m) return `array<${normalize(m[1]) ?? m[1]}>`;
  m = /^Dictionary\[(.+)\]$/.exec(s);
  if (m) {
    const parts = splitTop(m[1]);
    if (parts.length === 2) return `map<${normalize(parts[0]) ?? parts[0]}, ${normalize(parts[1]) ?? parts[1]}>`;
  }
  m = /^(array|map)<(.+)>(\?)?$/.exec(s);
  if (m) return `${m[1]}<${splitTop(m[2]).map((p) => normalize(p) ?? p).join(', ')}>${m[3] ?? ''}`;
  return undefined;
}

/** How a type is written in GDScript. `any` has no annotation; callers check for it. */
export function gdType(t: TypeRef): string {
  switch (t.kind) {
    case 'any':
      return 'Variant';
    case 'string':
      return 'String';
    case 'array': {
      const el = t.element;
      // Nested typed collections are not supported by GDScript: fall back to untyped Array.
      if (el.kind === 'any' || el.kind === 'array' || el.kind === 'map' || el.kind === 'void' || el.kind === 'function') return 'Array';
      return `Array[${gdType(el)}]`;
    }
    case 'map':
      return 'Dictionary';
    case 'named':
      return t.name;
    case 'function':
      return 'Callable';
    default:
      return t.kind;
  }
}

function vecFamily(t: TypeRef): string | undefined {
  return t.kind === 'named' && VECTORS.has(t.name) ? t.name : undefined;
}

export function operatorResult(op: BinaryOp, l: TypeRef, r: TypeRef): TypeRef | undefined {
  const num = (t: TypeRef) => t.kind === 'int' || t.kind === 'float';
  const isAny = l.kind === 'any' || r.kind === 'any';
  switch (op) {
    case '+':
    case '-':
    case '*':
    case '/': {
      if (isAny) return T.any;
      if (num(l) && num(r)) return l.kind === 'float' || r.kind === 'float' ? T.float : T.int;
      if (op === '+' && l.kind === 'string' && r.kind === 'string') return T.string;
      if (op === '+' && l.kind === 'array' && r.kind === 'array') return T.array(T.any);
      const lv = vecFamily(l);
      const rv = vecFamily(r);
      if (lv && rv && lv === rv) return l;
      if (lv && num(r) && (op === '*' || op === '/')) return lv.endsWith('i') && r.kind === 'float' ? T.named(lv.slice(0, -1)) : l;
      if (rv && num(l) && op === '*') return r;
      if (op === '*' && l.kind === 'named' && r.kind === 'named') {
        if ((l.name === 'Basis' || l.name === 'Transform3D' || l.name === 'Quaternion') && r.name === 'Vector3') return T.named('Vector3');
        if (l.name === 'Transform2D' && r.name === 'Vector2') return T.named('Vector2');
        if (l.name === r.name && ['Basis', 'Transform3D', 'Transform2D', 'Quaternion'].includes(l.name)) return l;
      }
      return undefined;
    }
    case '%':
      if (isAny) return T.any;
      if (l.kind === 'int' && r.kind === 'int') return T.int;
      if (l.kind === 'string') return T.string; // String formatting: "%d" % value
      return undefined;
    case '==':
    case '!=':
      if (isAny) return T.bool;
      if (num(l) && num(r)) return T.bool;
      if (l.kind === 'named' && r.kind === 'named' && universe.isReferenceType(l.name) && universe.isReferenceType(r.name)) return T.bool;
      return formatType(l) === formatType(r) || (l.kind === 'string' && r.kind === 'named' && r.name === 'StringName') || (r.kind === 'string' && l.kind === 'named' && l.name === 'StringName') ? T.bool : undefined;
    case '<':
    case '<=':
    case '>':
    case '>=':
      if (isAny) return T.bool;
      if (num(l) && num(r)) return T.bool;
      if (l.kind === 'string' && r.kind === 'string') return T.bool;
      if (vecFamily(l) && vecFamily(l) === vecFamily(r) && l.kind === 'named' && l.name !== 'Color') return T.bool;
      return undefined;
    case 'and':
    case 'or':
      return l.kind === 'bool' && r.kind === 'bool' ? T.bool : isAny ? T.bool : undefined;
  }
}

export function compatibility(from: TypeRef, to: TypeRef): Compatibility {
  if (to.kind === 'named' && (to.name === 'StringName' || to.name === 'NodePath') && from.kind === 'string') return 'implicit';
  if (from.kind === 'named' && from.name === 'StringName' && to.kind === 'string') return 'implicit';
  // enums are ints at runtime
  if (from.kind === 'named' && !universe.isKnown(from.name) && to.kind === 'int') return 'implicit';
  if (to.kind === 'named' && !universe.isKnown(to.name) && from.kind === 'int') return 'narrowing';
  return defaultCompatibility(from, to, universe);
}

export const gdscriptTypes: LanguageTypes = {
  universe,
  normalize,
  format: (t) => (t.kind === 'any' ? 'Variant' : gdType(t)),
  compatibility,
  operatorResult,
  structFields: (n) => VALUE_TYPES[n] ?? undefined,
  pickerTypes: () => ['bool', 'int', 'float', 'string', 'any', 'Vector2', 'Vector3', 'Color', 'array<any>', 'array<int>', 'array<float>', 'array<string>', 'map<string, any>', 'Node', 'Node2D', 'Node3D', 'CharacterBody2D', 'CharacterBody3D', 'Camera3D', 'Timer', 'AnimationPlayer', 'AudioStreamPlayer', 'PackedScene', 'InputEvent', 'Area2D', 'Area3D', 'Sprite2D', 'Label'],
  check: (t) => {
    if ((t.kind === 'int' || t.kind === 'float' || t.kind === 'bool' || t.kind === 'string') && t.nullable) return `GDScript ${gdType({ kind: t.kind })} values cannot be null`;
    if (t.kind === 'named' && t.args?.length) return `GDScript does not support generic arguments on ${t.name}`;
    return undefined;
  },
};
