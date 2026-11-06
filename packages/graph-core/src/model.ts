/**
 * The language-independent document model: scripts own declarations (variables, functions,
 * signals, enums) and every function owns exactly one graph. Nothing here knows about React,
 * React Flow, Godot or any particular programming language.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface Vec2 {
  x: number;
  y: number;
}

export interface GraphNode {
  /** Stable id, unique within the project. */
  id: string;
  /** Node type id from the node registry, e.g. "core.branch" or "godot.move_and_slide". */
  type: string;
  position: Vec2;
  /** Node settings (selected variable, operand type, case list…). Validated by the node definition. */
  props: Record<string, JsonValue>;
  /** Inline literal values for unconnected data inputs, keyed by port id. */
  inputs: Record<string, JsonValue>;
  collapsed?: boolean;
  /** Frames (comment boxes) have a size. */
  size?: { width: number; height: number };
}

export interface PortRef {
  node: string;
  port: string;
}

export interface Edge {
  /** Stable id, unique within the graph. */
  id: string;
  from: PortRef;
  to: PortRef;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Graph {
  id: string;
  nodes: GraphNode[];
  edges: Edge[];
  viewport?: Viewport;
}

export interface VariableDecl {
  id: string;
  name: string;
  /** Canonical type string, see @cs/type-system. */
  type: string;
  /** Literal default value (JSON). Structured values (Vector2…) use {"$type": "Vector2", "x": 0, "y": 0}. */
  default?: JsonValue;
  description?: string;
  /** Expose to the host editor (GDScript @export). Adapters without the capability report a diagnostic. */
  exported?: boolean;
  constant?: boolean;
  /** Language-specific attributes, validated by the adapter (GDScript: onreadyPath). */
  attributes?: Record<string, JsonValue>;
}

export interface ParamDecl {
  id: string;
  name: string;
  type: string;
  default?: JsonValue;
}

/** `lambda`: an inline function (closure) owned by another function; it can use the owner's parameters and locals. */
export type FunctionKind = 'function' | 'event' | 'lambda';

export interface FunctionDecl {
  id: string;
  name: string;
  kind: FunctionKind;
  /** For kind "event": the adapter's lifecycle event id (GDScript: "_ready", "_process"…). */
  event?: string;
  params: ParamDecl[];
  returnType: string;
  locals: VariableDecl[];
  description?: string;
  /** kind `lambda`: the function whose parameters and locals it can use. */
  owner?: string;
  /** Languages with async functions (TypeScript): the function is `async` and may use Await. */
  async?: boolean;
  /** Languages with modules: the function is exported from its file. */
  exported?: boolean;
  /** TypeScript: a React component (parameters are its props; returns JSX). */
  component?: boolean;
  graph: Graph;
}

export interface SignalDecl {
  id: string;
  name: string;
  params: ParamDecl[];
  description?: string;
}

export interface EnumDecl {
  id: string;
  name: string;
  members: { name: string; value?: number }[];
}

/** A named object shape (TypeScript `interface`): rows of a database table, component props… */
export interface InterfaceDecl {
  id: string;
  name: string;
  description?: string;
  exported?: boolean;
  fields: { name: string; type: string; optional?: boolean; description?: string }[];
}

export interface ScriptDoc {
  id: string;
  /** Display / identifier name, e.g. "Player". */
  name: string;
  /** Output path relative to the export root, without extension, e.g. "player/player". */
  path: string;
  /** Language-specific script settings validated by the adapter (GDScript: extends, class_name, tool). */
  settings: Record<string, JsonValue>;
  description?: string;
  variables: VariableDecl[];
  functions: FunctionDecl[];
  signals: SignalDecl[];
  enums: EnumDecl[];
  /** Type declarations (languages with interfaces). */
  interfaces?: InterfaceDecl[];
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. "E_TYPE_MISMATCH". */
  code: string;
  message: string;
  scriptId?: string;
  /** Graph id (functions own one graph each). */
  graphId?: string;
  functionId?: string;
  nodeId?: string;
  portId?: string;
  edgeId?: string;
  suggestion?: string;
}
