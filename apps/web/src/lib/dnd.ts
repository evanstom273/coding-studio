import type { JsonValue } from '@cs/graph-core';

export const DND_MIME = 'application/x-coding-studio-node';

export interface DragNodePayload {
  type: string;
  props?: Record<string, JsonValue>;
}
