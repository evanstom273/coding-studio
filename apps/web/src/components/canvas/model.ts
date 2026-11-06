import { typeColorKey, type TypeRef } from '@cs/type-system';
import type { NodeInfo } from '@cs/compiler-core';

export const TYPE_COLORS: Record<string, string> = {
  exec: '#f1f3f6',
  bool: '#e05a5a',
  int: '#2fd4bf',
  float: '#8bd94a',
  string: '#e46ff0',
  any: '#9aa3b2',
  object: '#5b9dff',
  struct: '#f4c542',
  array: '#ff9f43',
  map: '#ff8a65',
  function: '#c084fc',
  void: '#9aa3b2',
};

export function portColor(kind: 'exec' | 'data', type?: TypeRef): string {
  if (kind === 'exec') return TYPE_COLORS.exec;
  return TYPE_COLORS[typeColorKey(type ?? { kind: 'any' })] ?? TYPE_COLORS.any;
}

const CATEGORY_COLORS: [RegExp, string][] = [
  [/^Flow/, '#4a5568'],
  [/^Variables/, '#2f855a'],
  [/^Literals/, '#38606b'],
  [/^Math|^Comparison|^Logic/, '#3c6e47'],
  [/^Strings/, '#8a3b8f'],
  [/^Conversions/, '#4c5f7a'],
  [/^Arrays|^Dictionaries/, '#a05a23'],
  [/^Functions/, '#2b5fad'],
  [/^Objects/, '#2c5282'],
  [/^Debug|^Utility/, '#5a5f6b'],
  [/^Godot\/Signals/, '#9b2c2c'],
  [/^Godot/, '#285e9e'],
];

export function headerColor(info: NodeInfo): string {
  if (info.def?.flavor === 'entry') return '#9b2c2c';
  const cat = info.def?.category ?? '';
  return CATEGORY_COLORS.find(([re]) => re.test(cat))?.[1] ?? '#4a5568';
}

export interface BPNodeData extends Record<string, unknown> {
  info: NodeInfo;
  /** Connected input port ids (inline editors are hidden for these). */
  connected: string[];
  diag?: { severity: 'error' | 'warning' | 'info'; message: string };
  language: string;
}
