/**
 * Companion service for the Godot editor plugin.
 *
 * A stateless loopback HTTP API that gives the plugin the exact same compiler and edit
 * operations as the web editor, so a graph edited in Godot and in the browser behaves identically:
 *
 *   GET  /health                      → { ok, version, languages }
 *   GET  /palette?language=gdscript   → node types for the add-node menu
 *   POST /describe { project, function } → nodes with resolved titles/ports/colours + edges
 *   POST /apply    { project, operations, defaults? } → { project, created, warnings } (atomic)
 *   POST /compile  { project }        → { ok, files, diagnostics }
 *   POST /new      { name, template?, scriptName? } → { project }
 *
 * Security: binds to 127.0.0.1; rejects any request carrying an Origin header (i.e. from a web
 * page — Godot's HTTPRequest sends none), caps bodies at 16 MB, never touches the filesystem.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { compileProject, makeNodeContext, nodeInfo } from '@cs/compiler-core';
import { applyOps, createProject, migrateProject, OpError, projectRevision, type Project } from '@cs/project-format';
import { languages, toolchainFor } from '@cs/toolchain';
import type { PortSpec } from '@cs/node-registry';
import { formatType, typeColorKey } from '@cs/type-system';

export const COMPANION_DEFAULT_PORT = 47832;
export const COMPANION_VERSION = '0.1.0';
const MAX_BODY = 16 * 1024 * 1024;

const COLORS: Record<string, string> = { exec: '#f1f3f6', bool: '#e05a5a', int: '#2fd4bf', float: '#8bd94a', string: '#e46ff0', any: '#9aa3b2', object: '#5b9dff', struct: '#f4c542', array: '#ff9f43', map: '#ff8a65', function: '#c084fc', void: '#9aa3b2' };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'E_PAYLOAD_TOO_LARGE', 'Request body over 16 MB'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'E_BAD_JSON', 'Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function loadProject(raw: unknown): Project {
  try {
    return migrateProject(raw).project;
  } catch (e) {
    throw new HttpError(400, 'E_BAD_PROJECT', e instanceof Error ? e.message : String(e));
  }
}

const editable = (p: PortSpec) => (p.kind === 'data' && p.direction === 'in' && !p.connectionOnly && p.type && ['bool', 'int', 'float', 'string'].includes(p.type.kind) ? p.type.kind : null);

export function describe(project: Project, fnRef?: string) {
  const tc = toolchainFor(project.language);
  const script = project.scripts.find((s) => s.functions.some((f) => f.id === fnRef || f.graph.id === fnRef)) ?? project.scripts[0];
  if (!script) throw new HttpError(404, 'E_NOT_FOUND', 'Project has no scripts');
  const fn = script.functions.find((f) => f.id === fnRef || f.graph.id === fnRef) ?? script.functions[0];
  if (!fn) throw new HttpError(404, 'E_NOT_FOUND', 'Script has no functions');
  const ctx = makeNodeContext(tc, script, fn);
  const connected = new Set(fn.graph.edges.flatMap((e) => [`${e.from.node}|out|${e.from.port}`, `${e.to.node}|in|${e.to.port}`]));
  const port = (n: string) => (p: PortSpec) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    type: p.type ? formatType(p.type) : 'exec',
    color: COLORS[p.kind === 'exec' ? 'exec' : typeColorKey(p.type!)] ?? COLORS.any,
    connected: connected.has(`${n}|${p.direction}|${p.id}`),
    editable: editable(p),
    ...(p.default !== undefined ? { default: p.default } : {}),
  });
  return {
    revision: projectRevision(project),
    script: { id: script.id, name: script.name },
    function: { id: fn.id, name: fn.name, kind: fn.kind },
    nodes: fn.graph.nodes.map((n) => {
      const info = nodeInfo(tc, ctx, n);
      return {
        id: n.id,
        type: n.type,
        title: info.title,
        category: info.def?.category ?? 'Unknown',
        flavor: info.def?.flavor ?? 'exec',
        position: n.position,
        inputs: info.ports.filter((p) => p.direction === 'in').map(port(n.id)),
        outputs: info.ports.filter((p) => p.direction === 'out').map(port(n.id)),
        values: n.inputs,
        props: n.props,
      };
    }),
    edges: fn.graph.edges,
  };
}

async function route(req: IncomingMessage, res: ServerResponse) {
  if (req.headers.origin) throw new HttpError(403, 'E_FORBIDDEN', 'Browser requests are not accepted by the companion service.');
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const send = (body: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && url.pathname === '/health') return send({ ok: true, version: COMPANION_VERSION, languages: languages.all().map((l) => l.id) });
  if (req.method === 'GET' && url.pathname === '/palette') {
    const tc = toolchainFor(url.searchParams.get('language') ?? 'gdscript');
    return send(tc.registry.available(tc.adapter.id, tc.adapter.capabilities).map((d) => ({ type: d.type, title: d.title, category: d.category, description: d.description })));
  }
  if (req.method !== 'POST') throw new HttpError(404, 'E_NOT_FOUND', `No route ${req.method} ${url.pathname}`);
  const body = (await readBody(req)) as Record<string, unknown>;
  switch (url.pathname) {
    case '/new': {
      const tc = toolchainFor(typeof body.language === 'string' ? body.language : 'gdscript');
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'New Visual Script';
      const scriptName = typeof body.scriptName === 'string' ? body.scriptName : 'Main';
      if (!tc.adapter.identifiers.isValid(scriptName)) throw new HttpError(400, 'E_INVALID_IDENTIFIER', `"${scriptName}" is not a valid script name`);
      return send({ project: createProject(tc.adapter, name, { template: typeof body.template === 'string' ? body.template : undefined, scriptName }) });
    }
    case '/describe':
      return send(describe(loadProject(body.project), typeof body.function === 'string' ? body.function : undefined));
    case '/apply': {
      const p = loadProject(body.project);
      if (!Array.isArray(body.operations)) throw new HttpError(400, 'E_INVALID', 'operations must be an array');
      if (typeof body.expected_revision === 'string' && body.expected_revision !== projectRevision(p)) throw new HttpError(409, 'E_REVISION_CONFLICT', 'Project revision mismatch');
      try {
        const r = applyOps(p, body.operations, toolchainFor(p.language), (body.defaults as { scriptId?: string; functionId?: string }) ?? {});
        const project = { ...r.project, updatedAt: Date.now() };
        return send({ project, created: r.created, warnings: r.warnings, revision: projectRevision(project) });
      } catch (e) {
        if (e instanceof OpError) throw new HttpError(422, e.code, e.message, { opIndex: e.opIndex });
        throw e;
      }
    }
    case '/compile': {
      const p = loadProject(body.project);
      const r = compileProject(toolchainFor(p.language), p);
      return send({ ok: r.ok, files: r.files.map((f) => ({ path: f.path, content: f.content, sourceMap: f.sourceMap })), diagnostics: r.diagnostics });
    }
    default:
      throw new HttpError(404, 'E_NOT_FOUND', `No route POST ${url.pathname}`);
  }
}

export function startCompanion(port = COMPANION_DEFAULT_PORT): Promise<Server> {
  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const err = e instanceof HttpError ? e : new HttpError(500, 'E_INTERNAL', e instanceof Error ? e.message : String(e));
      if (!res.headersSent) res.writeHead(err.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
