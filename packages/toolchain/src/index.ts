/**
 * Wires languages and node packs together. The only module that knows which languages exist.
 * Adding a language = registering its adapter here (see docs/LANGUAGE_ADAPTERS.md).
 */
import { LanguageRegistry, type LanguageAdapter } from '@cs/language-sdk';
import { NodeRegistry } from '@cs/node-registry';
import { CORE_NODES } from '@cs/node-registry/core-nodes';
import { gdscriptAdapter } from '@cs/language-gdscript';
import { typescriptAdapter } from '@cs/language-typescript';
import type { Toolchain } from '@cs/compiler-core';

export const languages = new LanguageRegistry();
languages.register(gdscriptAdapter);
languages.register(typescriptAdapter);

const cache = new Map<string, Toolchain>();

/** Build a registry with the core nodes plus one adapter's node pack. */
export function createToolchain(adapter: LanguageAdapter): Toolchain {
  const registry = new NodeRegistry();
  registry.registerAll(CORE_NODES);
  adapter.registerNodes(registry);
  return { adapter, registry };
}

export function toolchainFor(languageId: string): Toolchain {
  let tc = cache.get(languageId);
  if (!tc) {
    const adapter = languages.get(languageId);
    if (!adapter) throw new Error(`Unknown language "${languageId}". Available: ${languages.all().map((l) => l.id).join(', ')}`);
    tc = createToolchain(adapter);
    cache.set(languageId, tc);
  }
  return tc;
}
