/**
 * Wire protocol between the MCP server (Node, launched by Claude Code over stdio) and the editor
 * running in a browser tab, over a WebSocket bound to 127.0.0.1.
 *
 *   Claude Code ──stdio/MCP──► mcp/server ──ws://127.0.0.1:47831──► editor bridge (apps/web/src/bridge)
 *
 * Session authorisation: the first editor tab that says hello owns the session. Another tab can
 * only take over when its user explicitly clicks "Take over" (hello.takeover = true); the previous
 * tab is told and shows that it lost control. Nothing is replaced silently.
 */
export const BRIDGE_DEFAULT_PORT = 47831;
export const BRIDGE_PROTOCOL_VERSION = 1;
/** Max size of any single bridge message (requests and responses). */
export const BRIDGE_MAX_PAYLOAD = 8 * 1024 * 1024;

export const BRIDGE_METHODS = [
  'status',
  'list_projects',
  'create_project',
  'open_project',
  'get_project',
  'save_project',
  'duplicate_project',
  'delete_project',
  'list_graphs',
  'get_graph',
  'list_node_types',
  'get_node_schema',
  'search_nodes',
  'list_language_capabilities',
  'batch_edit',
  'validate_graph',
  'compile_script',
  'compile_project',
  'export_files',
  'undo',
  'redo',
  'list_backups',
  'restore_backup',
  'confirm_overwrite',
  'read_tree',
  'read_files',
  'search_files',
  'workspace_batch',
  'git_status',
  'git_commit',
  'git_pull',
  'git_create_pr',
  'git_clone',
  'git_repos',
  'git_pr_list',
  'git_pr_get',
  'git_pr_update',
  'git_pr_merge',
  'git_repo_create',
  'git_repo_update',
  'git_repo_delete',
  'git_publish',
  'read_config',
  'edit_config',
  'ci_status',
  'ci_run',
  'ci_run_details',
  'ci_logs',
  'ci_rerun',
  'ci_add_workflow',
  'deps_list',
  'deps_search',
  'deps_add',
  'deps_remove',
  'host_snapshot',
  'host_import',
  'host_revision',
  'confirm_action',
] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

export interface BridgeRequest {
  type: 'request';
  id: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export interface BridgeError {
  code: string;
  message: string;
  details?: unknown;
}

export type BridgeResponse = { type: 'response'; id: string; ok: true; result: unknown } | { type: 'response'; id: string; ok: false; error: BridgeError };

export interface BridgeHello {
  type: 'hello';
  protocol: number;
  app: 'coding-studio';
  appVersion: string;
  /** Random id of this tab's session. */
  sessionId: string;
  /** Explicit user action: replace the tab that currently owns the bridge. */
  takeover?: boolean;
}

/** Server → editor after hello. */
export type BridgeWelcome = { type: 'welcome'; protocol: number; serverVersion: string; /** the server can run tasks and git on this computer */ host?: boolean } | { type: 'rejected'; reason: 'busy' | 'protocol'; message: string } | { type: 'revoked'; message: string };

export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeHello | BridgeWelcome;

export interface ExportFilesResult {
  /** relative path → UTF-8 text */
  files: Record<string, string>;
  diagnostics: unknown[];
  ok: boolean;
}
