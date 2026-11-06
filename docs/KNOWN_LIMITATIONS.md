# Known limitations

Honest list of what is not done or not verified in this version.

## Not verified in the build environment

- **Generated GDScript has not been run through a real Godot executable.** Downloading Godot was not permitted in the environment this version was built in. The output is covered by golden files and was written against the Godot 4 API, but run `GODOT_BIN=/path/to/godot npm run test:godot` once to confirm (it checks all 12 examples with Godot's own parser).
- **The Godot editor plugin has not been executed in Godot** for the same reason. The companion service it relies on is fully tested; the plugin's GDScript is unverified.
- **Not deployed.** The Cloudflare Worker configuration was tested locally with `wrangler dev` (assets, SPA fallback, headers, CSP); no deployment was made because no Cloudflare authorisation was provided. See [DEPLOYMENT.md](DEPLOYMENT.md).
- Hosted page → local MCP bridge depends on browser policy (Chrome Local Network Access prompt; Safari blocks it). Only the localhost path is covered by automated tests.

## Languages

- Only **GDScript** ships. The JavaScript adapter in `tests/fixtures` is test-only scaffolding to prove the pipeline is language-neutral; it is not a supported backend. Java, TypeScript, Python, C, C++, C# and Rust are not implemented.
- No reverse direction: existing `.gd` files cannot be turned into graphs. The graph is the source; the code view is read-only.

## GDScript coverage

- Not generated: inner classes, lambdas/`Callable` literals, static functions, property setters/getters, typed `Dictionary[K, V]` (emitted as `Dictionary`), nested typed arrays (emitted as `Array`), `super` calls, `assert`, `breakpoint`.
- The Godot API node pack is a curated subset (see [GDSCRIPT_EXPORT.md](GDSCRIPT_EXPORT.md)). Other members are reachable with *Call Method (by name)*, *Get/Set Property* and *Cast To*, whose types you declare on the node.
- Calls to functions in *other* scripts are not modelled as typed nodes; use *Call Method (by name)* with a target.
- Signal connections take the signal name as text; only the script's own signals are checked for arity.
- `extends` of a user `class_name` script is accepted with a warning; its members are unknown to the type checker.

## Editor

- Comment frames do not drag the nodes inside them.
- Data reroute nodes are untyped, so type checking does not see through them.
- Pure nodes are re-evaluated wherever their output is used (Blueprint semantics) — for random-number nodes store the value in a variable if you need it once.
- No debugger, breakpoints or in-editor execution.
- Canvas keyboard navigation is limited to React Flow's built-ins; the app is designed for mouse/trackpad on desktop, not touch.
- The code view bundles Monaco (~3.6 MB, loaded lazily when the code tab is first shown).
- Only one browser tab can be connected to Claude Code at a time (by design).
