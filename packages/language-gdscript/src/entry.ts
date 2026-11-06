/**
 * GDScript entry points follow Godot's execution model: nothing runs at load time, so the entry
 * function is called from `_ready()` (added if the script has none, prepended if it has one —
 * `_process()` and the other callbacks are untouched). The host decides how Godot gets to that
 * script:
 *   - scene: a generated scene whose root node carries the script; make it the main scene;
 *   - autoload: register the script as an Autoload, so it starts with the game.
 * Coroutines (functions that wait on timers or signals) are awaited.
 */
import { walkStmts, type IRExpr, type IRFunction, type IRStmt } from '@cs/intermediate-representation';
import type { EntryPointSupport } from '@cs/language-sdk';
import { CLASS_PARENTS } from './types';

function extendsNode(base: string): boolean | undefined {
  if (!base) return false;
  if (base.startsWith('res://')) return undefined; // a script path: can't tell, trust the user
  if (!(base in CLASS_PARENTS)) return undefined; // a class_name from the user's Godot project
  for (let c: string | undefined = base; c; c = CLASS_PARENTS[c]) if (c === 'Node') return true;
  return false;
}

/** Waits on timers / signals anywhere in its body (a coroutine must be awaited). */
export function isCoroutine(fn: IRFunction): boolean {
  let found = false;
  walkStmts(fn.body, (s) => {
    if (s.k === 'lang' && (s.op === 'await_timer' || s.op === 'await_signal')) found = true;
  });
  return found;
}

export const gdscriptEntry: EntryPointSupport = {
  hosts: [
    { id: 'scene', label: 'Main scene', description: 'A scene whose root node runs the script is generated next to it; make it the main scene (Project Settings → Application → Run → Main Scene).' },
    { id: 'autoload', label: 'Autoload', description: 'Register the script as an Autoload (Project Settings → Globals → Autoload) so it starts with the game, before any scene.' },
  ],
  defaultHost: () => 'scene',
  apply(module, req) {
    const base = typeof module.settings.extends === 'string' ? module.settings.extends.trim() : '';
    const isNode = extendsNode(base);
    if (isNode === false) {
      return { module, diagnostics: [{ severity: 'error', code: 'E_ENTRY_HOST', message: `The entry point's script extends ${base || 'nothing (RefCounted)'}, which Godot never runs by itself. Make it extend Node (or Node2D, Control…).`, suggestion: 'Change "Extends" in the script settings.', functionId: req.fn.id }] };
    }
    const fn = module.members.find((m): m is IRFunction => m.k === 'function' && m.name === req.fn.name)!;
    let members = module.members;
    if (fn.event !== '_ready') {
      const call: IRExpr = { k: 'call', name: fn.name, args: [] };
      const stmt: IRStmt = { k: 'expr', expr: isCoroutine(fn) ? { k: 'await', expr: call } : call, src: { graphId: req.fn.graph.id } };
      const ready = members.find((m): m is IRFunction => m.k === 'function' && m.event === '_ready');
      if (ready) members = members.map((m) => (m === ready ? { ...ready, body: [stmt, ...ready.body] } : m));
      else members = [...members, { k: 'function', name: '_ready', params: [], returnType: { kind: 'void' }, body: [stmt], event: '_ready', doc: `Program entry point: starts ${fn.name}().`, src: { graphId: req.fn.graph.id } }];
    }
    const scriptFile = `${module.path}.gd`;
    if (req.host === 'autoload') {
      return { module: { ...module, members }, instructions: [`In Godot: Project → Project Settings → Globals → Autoload, add res://${scriptFile} (enable it). ${fn.name}() then runs when the game starts.`] };
    }
    const nodeName = module.name.replace(/[^A-Za-z0-9_]/g, '_') || 'Main';
    const type = base && !base.startsWith('res://') && base in CLASS_PARENTS ? base : 'Node';
    const scene = `${module.path}.tscn`;
    const content = `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://${scriptFile}" id="1_entry"]\n\n[node name="${nodeName}" type="${type}"]\nscript = ExtResource("1_entry")\n`;
    return {
      module: { ...module, members },
      files: [{ path: scene, content, sourceMap: [] }],
      instructions: [`Export into your Godot project's folder, then set res://${scene} as the main scene (Project → Project Settings → Application → Run → Main Scene) and press Play: its ${nodeName} node runs ${fn.name}() from _ready().`],
    };
  },
};
