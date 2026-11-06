# Compiler design

```
Project ─► per script: declarations check ─► per function: graph analysis ─► lowering to IR
        ─► IR checks (missing returns) ─► adapter.validate(IR) ─► adapter.generate(IR) ─► files + source maps
```

`packages/compiler-core` contains no language knowledge. Names, types, operators, literals and spelling go through the `LanguageAdapter`; node semantics come from each `NodeDefinition`.

## 1. Declarations (`compile.ts › validateDeclarations`)

Identifiers (adapter rules + reserved words), uniqueness across members, types (parse + known to the adapter's type universe or declared as a script enum), defaults fit their type, capability checks (signals, enums, exported variables, member variables), event signatures match the adapter's lifecycle templates, and parameters/locals may not shadow members. The adapter can add script-level checks (`validateScript`: GDScript checks `extends`, `class_name`, `@onready`).

## 2. Graph analysis (`analyzeGraph`)

For every node: definition exists and is available for the language; type-valued props parse; the node's own `check()`; inline literal values fit their port types. For every edge: endpoints exist, ports exist with the right direction, exec↔exec / data↔data, and type compatibility according to the adapter (`exact`, `implicit`, `narrowing` → warning, `incompatible` → error). Then: one wire per data input, one wire per exec output, exactly one Entry node, **exec cycles** (Tarjan SCC, including loop bodies) and **data cycles** among pure nodes are errors, unreachable exec nodes are warnings, unused pure nodes are info.

Structural errors stop lowering of that function: it would be meaningless.

## 3. Lowering (`lower.ts`)

Graph position never matters; execution order comes only from exec wires.

- **Chains.** From the Entry node, follow each node's chosen exec output (`next`).
- **Branch merging.** Nodes with several outgoing chains (Branch, Switch, Sequence) return `next: 'join'`. The lowerer computes **immediate post-dominators** of the exec graph (loop-body edges excluded, unconnected exec outputs leading to a virtual exit). Each branch body is compiled until it reaches the merge point; flow then continues from the merge point once. A Branch → If/else chain with merges yields `if / elif / else` followed by the shared code.
- **Loops.** Loop bodies are separate regions (`region: 'loop'`): they start with an empty stop set and cannot merge with the outer flow. `break`/`continue` outside a loop are errors.
- **Duplication.** If a node is reached by paths that don't merge structurally, its code is emitted more than once (semantically equivalent for acyclic graphs) and a `W_DUPLICATED_FLOW` warning names the node.
- **Data.** Inputs are pulled lazily. Pure nodes are inlined as expressions where used (Blueprint semantics). Values produced by exec nodes (function results, created objects, loop variables) are bound to locals in the **scope of the block** where they were computed; reading one from another branch, from outside a loop, or before it runs is `E_VALUE_NOT_AVAILABLE` — never silently wrong code.
- **Names.** Temporaries get deterministic names derived from the node (`add_result`, `new_timer`, `i`) and are deduplicated against members, parameters, locals and reserved words.

## 4. IR (`packages/intermediate-representation`)

Modules → members (fields, functions, signals, enums) → statements (`var`, `assign`, `expr`, `if`, `while`, `for_range`, `for_each`, `match`, `break`, `continue`, `return`, `comment`) → expressions (literals, refs, binary/unary ops, calls, language-neutral `builtin` operations such as `print`/`to_string`/`array_append`, property and index access, construction, collections, ternary, cast, instance-of, enum values). Every statement carries a source reference `{graphId, nodeId}`.

Language node packs may emit `lang` expressions/statements tagged with their language id (e.g. GDScript `$Path`, `await`, `signal.emit()`); other backends refuse them with a diagnostic instead of guessing.

## 5. Backend

`adapter.validate(module)` runs language-specific IR checks; `adapter.generate(module)` prints files using `CodeWriter`, which records a source map (generated line → node). Source is only emitted when there are no error diagnostics. Output is deterministic: identical graphs and settings give identical bytes (ids are never printed).

## Diagnostics

`{ severity, code, message, scriptId, functionId, graphId, nodeId?, portId?, edgeId?, suggestion? }`. Codes are stable (`E_*` errors, `W_*` warnings, `I_*` info). The editor shows them on nodes, in the Errors/Warnings tabs (click to focus the node) and the MCP tools return them verbatim.
