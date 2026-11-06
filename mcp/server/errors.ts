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
  // Any error carrying a string code (BridgeRequestError, ExportError, the project service's
  // ServiceError…) is reported as-is.
  if (e instanceof Error && typeof (e as { code?: unknown }).code === 'string') {
    const details = (e as { details?: unknown }).details;
    return { code: (e as unknown as { code: string }).code, message: e.message, ...(details !== undefined ? { details } : {}) };
  }
  return { code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) };
}
