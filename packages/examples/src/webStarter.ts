/**
 * "Web app" starter: Vite + React + Tailwind + Dexie. The App component is a visual graph
 * (state, a click handler, elements); the database and the todo list are ordinary TypeScript,
 * so both ways of working are there from the start.
 */
import type { Toolchain } from '@cs/compiler-core';
import { applyOps, createProject, type EditOp } from '@cs/project-format';
import { makeRecord, projectToWorkspace, type Workspace } from '@cs/workspace';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'web-app',
      private: true,
      version: '0.1.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'tsc --noEmit && vite build', preview: 'vite preview', typecheck: 'tsc --noEmit' },
      dependencies: { dexie: '^4.0.11', 'dexie-react-hooks': '^1.1.7', react: '^19.1.0', 'react-dom': '^19.1.0' },
      devDependencies: { '@tailwindcss/vite': '^4.1.0', '@types/react': '^19.1.0', '@types/react-dom': '^19.1.0', '@vitejs/plugin-react': '^4.4.0', tailwindcss: '^4.1.0', typescript: '^5.8.0', vite: '^6.3.0' },
    },
    null,
    2,
  ) + '\n',
  'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Web app</title>
  </head>
  <body class="bg-slate-100">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  'vite.config.ts': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
`,
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true, isolatedModules: true }, include: ['src'] }, null, 2) + '\n',
  'src/index.css': '@import "tailwindcss";\n',
  'src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
  'src/db.ts': `import Dexie, { type EntityTable } from 'dexie';

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

/** The app's IndexedDB database (stored in the browser). */
export const db = new Dexie('web-app') as Dexie & { todos: EntityTable<Todo, 'id'> };

db.version(1).stores({ todos: '++id, title, done' });

export function addTodo(title: string): void {
  void db.todos.add({ title, done: false });
}
`,
  'src/TodoList.tsx': `import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';

/** Shows the todos; updates by itself whenever the database changes. */
export function TodoList() {
  const todos = useLiveQuery(() => db.todos.toArray(), []);
  if (!todos) return null;
  if (!todos.length) return <p className="mt-4 text-sm text-slate-500">Nothing yet — add one.</p>;
  return (
    <ul className="mt-4 space-y-1">
      {todos.map((t) => (
        <li key={t.id} className="rounded bg-white px-3 py-2 shadow-sm">
          {t.title}
        </li>
      ))}
    </ul>
  );
}
`,
  'README.md': `# Web app

- \`src/App\` is a **visual script** (open \`src/App.vgraph\`): React state, a click handler and the page layout as nodes.
- \`src/db.ts\` and \`src/TodoList.tsx\` are ordinary TypeScript.
- Press **Preview** to run it here. On a computer: \`npm install\` then \`npm run dev\`.
`,
};

export function buildWebStarter(tc: Toolchain, name: string): Workspace {
  const p = createProject(tc.adapter, name, { template: 'empty', scriptName: 'App' });
  const sid = p.scripts[0].id;
  const ops: EditOp[] = [
    { op: 'update_script', script: sid, path: 'src/App', description: 'The main component: a heading, a button that adds a todo, and the list.' },
    { op: 'add_function', ref: 'app', script: sid, name: 'App', component: true, exported: true, returnType: 'any', description: 'The whole page.' },
    { op: 'add_variable', function: '$app', name: 'count', type: 'int', default: 0, attributes: { state: true } },
    // const add = () => { addTodo(`Todo ${count + 1}`); setCount(count + 1) }
    { op: 'add_function', ref: 'add', script: sid, kind: 'lambda', owner: '$app', name: 'addOne' },
    { op: 'add_node', ref: 'n', graph: '$add', type: 'core.get_var', props: { variable: 'count' }, position: { x: 0, y: 160 } },
    { op: 'add_node', ref: 'plus', graph: '$add', type: 'core.add', props: { type: 'int' }, inputs: { b: 1 }, position: { x: 200, y: 160 } },
    { op: 'add_node', ref: 'title', graph: '$add', type: 'ts.template', props: { template: 'Todo {n}' }, position: { x: 400, y: 160 } },
    { op: 'add_node', ref: 'call', graph: '$add', type: 'ts.call', props: { scriptPath: 'src/db', module: '', name: 'addTodo', argNames: ['title'], argTypes: ['string'], returnType: 'void' }, position: { x: 300, y: 0 } },
    { op: 'add_node', ref: 'inc', graph: '$add', type: 'core.set_var', props: { variable: 'count', operation: '+' }, inputs: { value: 1 }, position: { x: 600, y: 0 } },
    { op: 'connect', graph: '$add', from: { node: '$n', port: 'value' }, to: { node: '$plus', port: 'a' } },
    { op: 'connect', graph: '$add', from: { node: '$plus', port: 'result' }, to: { node: '$title', port: 'n' } },
    { op: 'connect', graph: '$add', from: { node: '$add.entry', port: 'then' }, to: { node: '$call', port: 'exec' } },
    { op: 'connect', graph: '$add', from: { node: '$title', port: 'text' }, to: { node: '$call', port: 'arg_0' } },
    { op: 'connect', graph: '$add', from: { node: '$call', port: 'then' }, to: { node: '$inc', port: 'exec' } },
    // the page
    { op: 'add_node', ref: 'h1', graph: '$app', type: 'ts.element', props: { tag: 'h1', attributes: ['className'], children: 1 }, inputs: { attr_className: 'text-2xl font-bold text-slate-800', child_0: 'My todos' }, position: { x: 0, y: 200 } },
    { op: 'add_node', ref: 'cb', graph: '$app', type: 'ts.closure', props: { function: '$add' }, position: { x: 0, y: 360 } },
    { op: 'add_node', ref: 'btn', graph: '$app', type: 'ts.element', props: { tag: 'button', attributes: ['className', 'onClick'], children: 1 }, inputs: { attr_className: 'mt-3 rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500', child_0: 'Add a todo' }, position: { x: 250, y: 330 } },
    { op: 'add_node', ref: 'list', graph: '$app', type: 'ts.element', props: { tag: 'TodoList', module: './TodoList', attributes: [], children: 0 }, position: { x: 250, y: 500 } },
    { op: 'add_node', ref: 'main', graph: '$app', type: 'ts.element', props: { tag: 'main', attributes: ['className'], children: 3 }, inputs: { attr_className: 'mx-auto max-w-md p-6' }, position: { x: 550, y: 250 } },
    { op: 'add_node', ref: 'ret', graph: '$app', type: 'core.return', position: { x: 800, y: 0 } },
    { op: 'connect', graph: '$app', from: { node: '$cb', port: 'fn' }, to: { node: '$btn', port: 'attr_onClick' } },
    { op: 'connect', graph: '$app', from: { node: '$h1', port: 'element' }, to: { node: '$main', port: 'child_0' } },
    { op: 'connect', graph: '$app', from: { node: '$btn', port: 'element' }, to: { node: '$main', port: 'child_1' } },
    { op: 'connect', graph: '$app', from: { node: '$list', port: 'element' }, to: { node: '$main', port: 'child_2' } },
    { op: 'connect', graph: '$app', from: { node: '$app.entry', port: 'then' }, to: { node: '$ret', port: 'exec' } },
    { op: 'connect', graph: '$app', from: { node: '$main', port: 'element' }, to: { node: '$ret', port: 'value' } },
  ];
  const project = applyOps(p, ops, tc).project;
  const ws = projectToWorkspace(project);
  const files = new Map(ws.files);
  const now = Date.now();
  for (const [path, content] of Object.entries(FILES)) files.set(path, makeRecord(path, path === 'package.json' ? content.replace('"web-app"', JSON.stringify(name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'web-app')) : content, now));
  return { meta: ws.meta, files };
}
