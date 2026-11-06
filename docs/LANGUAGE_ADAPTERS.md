# Adding a language

A language is one `LanguageAdapter` object (`packages/language-sdk`) plus, optionally, a node pack. Nothing in the editor, the compiler core, persistence or MCP needs to change.

## 1. Create the package

```
packages/language-python/src/index.ts
```

Add `@cs/language-python` to `tsconfig.json` paths and `aliases.ts`.

## 2. Implement `LanguageAdapter`

```ts
export const pythonAdapter: LanguageAdapter = {
  id: 'python',
  name: 'Python',
  extensions: ['.py'],
  versions: [{ id: '3.12', label: 'Python 3.12' }],
  defaultVersion: '3.12',
  capabilities: { ...allCapabilities(false), classes: true, inheritance: true, exceptions: true, async: true, modules: true, imports: true, dynamicTyping: true, memberVariables: true, enums: true, match: true, nullable: true },
  types: { universe, format, compatibility, operatorResult, structFields, pickerTypes, normalize },
  identifiers: { isValid, reserved, description },
  scriptSettings: [ /* e.g. base class */ ],
  events: [],            // host callbacks, if the framework has any
  templates: [ { id: 'module', name: 'Module', description: '…', settings: {}, events: [] } ],
  registerNodes(registry) { /* language-specific nodes, if any */ },
  validate(module, ctx) { return [] /* IR-level checks */ },
  generate(module, ctx) { /* print IR → files */ },
};
```

What each part is for:

| Member | Responsibility |
| --- | --- |
| `capabilities` | Which features exist. Core nodes declare `requires` (e.g. `core.self` needs `classes`), so unsupported nodes disappear from the palette and are rejected by edit operations. Declarations that need missing capabilities (signals, enums, exported vars) produce `E_UNSUPPORTED_FEATURE`. |
| `types.universe` | Known named types and inheritance (`parentOf`, `isReferenceType`, `isKnown`). |
| `types.compatibility` | Language-specific assignability: `exact` / `implicit` / `narrowing` / `incompatible`. `defaultCompatibility` from `@cs/type-system` is a good start. |
| `types.operatorResult` | Result type of each binary operator for given operand types, or `undefined` when illegal (the Add node then reports an error instead of emitting bad code). |
| `types.format` / `normalize` | How canonical types are spelled in source, and which source spellings users/AI may type. |
| `types.structFields` | Lets JSON literals like `{x: 1, y: 2}` become constructor calls. |
| `identifiers` | Valid identifier rule and reserved words. |
| `generate` | Print every IR construct you support. Map each `builtin` op (`print`, `to_string`, `array_append`, …) to idiomatic code. Throw (→ `E_BACKEND`) or report for anything unsupported — never emit placeholder code. |
| `validate` | Catch constructs that are representable in IR but illegal in your language. |

Use `CodeWriter` for indentation and source maps; pass `{graphId, nodeId}` from each statement's `src` to `line()`.

## 3. Register it

```ts
// packages/toolchain/src/index.ts
languages.register(pythonAdapter);
```

The new language now appears in *New project*, the core node pack is filtered by its capabilities, and MCP `list_language_capabilities` describes it.

## 4. Test it

Copy the pattern of `tests/compiler/typescript.test.ts`: build graphs with `applyOps`, compile, check the output with the language's own compiler (`tsc --strict` there), and **run** it with the real runtime. Add golden files for representative programs. `packages/language-typescript` is a complete second adapter to read alongside GDScript: its own node pack (`ts.*`), an import manager, and two output modes (TypeScript / JavaScript).

## Boundaries

Language-neutral (do not put language knowledge here): `graph-core`, `type-system`, `intermediate-representation`, `node-registry` (incl. core nodes), `language-sdk`, `compiler-core`, `project-format`, the editor.

Language-specific (adapter package): type spelling and rules, operators, literals, reserved words, script settings, lifecycle events, templates, framework node packs (`godot.*`), `lang` IR constructs, code printing.
