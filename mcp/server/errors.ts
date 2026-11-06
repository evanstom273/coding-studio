/** Error types shared by the local (Node) and remote (Cloudflare) MCP servers. No runtime-specific imports. */
import type { BridgeError } from '../../packages/shared-protocol/src/index';

export const SERVER_VERSION = '0.2.0';

export class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function errorPayload(e: unknown): BridgeError {
  if (e instanceof BridgeRequestError || e instanceof ExportError) return { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) };
  return { code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) };
}
