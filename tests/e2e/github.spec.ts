/**
 * GitHub in the editor: connect a token, open a repo, edit, see the diff, commit to a new branch,
 * open a PR, pull a remote change. The Worker's /github endpoints are served by a fake GitHub.
 */
import { expect, test, type Page } from '@playwright/test';
import { FakeGitHub } from '../fixtures/fake-github';
import { freshStart } from './helpers';

async function serveGitHub(page: Page, fake: FakeGitHub) {
  let token: string | null = null;
  await page.route(/\/github\/[^/]+\/token$/, async (route) => {
    const m = route.request().method();
    if (m === 'PUT') {
      token = JSON.parse(route.request().postData() ?? '{}').token;
      return route.fulfill({ json: { connected: true, login: 'lyra' } });
    }
    if (m === 'DELETE') token = null;
    return route.fulfill({ json: token ? { connected: true, login: 'lyra' } : { connected: false } });
  });
  await page.route(/\/github\/[^/]+\/api\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const path = u.pathname.replace(/^\/github\/[^/]+\/api/, '') + u.search;
    const r = await fake.fetch(path, { method: req.method(), ...(req.postData() ? { body: JSON.parse(req.postData()!) } : {}) });
    return route.fulfill({ status: r.status, json: r.body });
  });
}

test('connect GitHub, open a repo, commit to a branch, open a PR, pull', async ({ page }) => {
  const fake = new FakeGitHub();
  fake.push('main', { 'README.md': '# Game\nhello\n', 'src/app.ts': 'export const a = 1;\n' });
  await freshStart(page);
  await serveGitHub(page, fake);

  await page.getByTestId('open-github').click();
  await page.getByTestId('github-token').fill('github_pat_1234567890abcdefghij');
  await page.getByTestId('github-token-save').click();
  await page.getByTestId('repo-row').filter({ hasText: 'lyra/game' }).click();
  await page.getByTestId('clone-repo').click();
  await expect(page.getByTestId('project-title')).toHaveText('game');

  await page.getByTestId('left-tab-files').click();
  await page.locator('[data-testid="file-row"][data-path="README.md"]').click();
  await page.locator('[data-testid="text-editor"] .view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('edited on my phone\n');

  await page.getByTestId('left-tab-git').click();
  await expect(page.getByTestId('git-branch')).toContainText('lyra/game · main');
  await expect(page.locator('[data-testid="git-change"][data-path="README.md"]')).toBeVisible();
  await page.locator('[data-testid="git-change"][data-path="README.md"]').click();
  await expect(page.getByTestId('diff-view')).toBeVisible();

  await page.getByTestId('commit-message').fill('Edit readme');
  await page.getByTestId('commit-new-branch').check();
  await page.getByTestId('commit-branch-name').fill('phone-edit');
  await page.getByTestId('commit-push').click();
  await expect(page.getByTestId('git-branch')).toContainText('phone-edit');
  expect(fake.files('phone-edit')['README.md']).toBe('# Game\nhello\nedited on my phone\n');
  expect(fake.files('main')['README.md']).toBe('# Game\nhello\n');
  await page.getByTestId('create-pr').click();
  await expect(page.getByTestId('pr-link')).toBeVisible();
  expect(fake.pullsList[0]).toMatchObject({ head: 'phone-edit', base: 'main' });
  await expect(page.getByTestId('git-change')).toHaveCount(0);

  // a change pushed elsewhere comes in with Pull, as one undoable step
  fake.push('phone-edit', { 'src/app.ts': 'export const a = 2;\n' });
  await page.getByTestId('git-pull').click();
  await expect.poll(() => page.evaluate(() => (window as never as { codingStudio: { editor: { getState(): { workspace: { files: Map<string, { text?: string }> } } } } }).codingStudio.editor.getState().workspace.files.get('src/app.ts')?.text)).toBe('export const a = 2;\n');
  await expect(page.getByTestId('git-change')).toHaveCount(0);
});

test('Actions: add a workflow, commit, follow a failing run, jump from the log to the file, re-run', async ({ page }) => {
  const fake = new FakeGitHub();
  fake.push('main', { 'package.json': '{"scripts":{"test":"vitest","build":"vite build"}}', 'src/app.ts': 'export const a: number = 1;\nexport const b: number = "two";\n' });
  await freshStart(page);
  await serveGitHub(page, fake);
  await page.getByTestId('open-github').click();
  await page.getByTestId('github-token').fill('github_pat_1234567890abcdefghij');
  await page.getByTestId('github-token-save').click();
  await page.getByTestId('repo-row').first().click();
  await page.getByTestId('clone-repo').click();
  await expect(page.getByTestId('project-title')).toHaveText('game');

  await page.getByTestId('left-tab-git').click();
  await page.getByTestId('git-view-actions').click();
  await page.getByTestId('add-workflow-ci').click();
  await expect(page.locator('[data-testid="tab"][data-tab=".github/workflows/ci.yml"]')).toBeVisible();
  await page.getByTestId('git-view-changes').click();
  await page.getByTestId('commit-message').fill('Add CI');
  await page.getByTestId('commit-push').click();
  await expect(page.getByTestId('git-change')).toHaveCount(0);
  expect(fake.files('main')['.github/workflows/ci.yml']).toContain('npm run build');

  // GitHub runs it and it fails
  fake.addRun('main', { conclusion: 'failure', log: ['2026-01-01T00:00:00.0000000Z > tsc --noEmit', '2026-01-01T00:00:01.0000000Z src/app.ts(2,14): error TS2322: Type string is not assignable to type number.', '2026-01-01T00:00:01.0000000Z ##[error]Process completed with exit code 2.'].join('\n') });
  await page.getByTestId('git-view-actions').click();
  await expect(page.getByTestId('workflow-row')).toHaveCount(1);
  await expect(page.getByTestId('run-row').first()).toHaveAttribute('data-state', 'failed');
  await page.getByTestId('run-row').first().click();
  await page.getByTestId('open-log').click();
  await expect(page.getByTestId('log-view')).toBeVisible();
  await page.getByTestId('log-problem').filter({ hasText: 'src/app.ts:2' }).click();
  await expect(page.locator('[data-testid="tab"][data-tab="src/app.ts"]')).toHaveAttribute('aria-selected', 'true');

  // re-run failed jobs; run it by hand too
  await page.getByTestId('rerun-failed').click();
  await expect(page.getByTestId('run-row').first()).toHaveAttribute('data-state', 'running', { timeout: 10_000 });
  await page.getByTestId('run-workflow').click();
  await expect.poll(() => fake.dispatches.length).toBe(1);
});

test('pull requests: open one from the PR tab, merge it; repository settings: rename and delete', async ({ page }) => {
  const fake = new FakeGitHub();
  fake.push('main', { 'README.md': '# Game\n' });
  fake.push('feature', { 'README.md': '# Game\nnew feature\n' });
  await freshStart(page);
  await serveGitHub(page, fake);
  await page.getByTestId('open-github').click();
  await page.getByTestId('github-token').fill('github_pat_1234567890abcdefghij');
  await page.getByTestId('github-token-save').click();
  await page.getByTestId('repo-row').filter({ hasText: 'lyra/game' }).click();
  await page.getByTestId('clone-repo').click();
  await expect(page.getByTestId('project-title')).toHaveText('game');
  await page.getByTestId('left-tab-git').click();
  await page.getByTestId('git-view-pulls').click();
  await page.getByTestId('pr-new').click();
  await expect(page.getByTestId('pr-head')).toHaveValue('feature');
  await expect(page.getByTestId('pr-base')).toHaveValue('main');
  await page.getByTestId('pr-title').fill('Add the feature');
  await page.getByTestId('pr-create').click();
  await expect(page.getByTestId('pr-row')).toContainText('Add the feature');
  await page.getByTestId('pr-merge').click();
  await expect(page.getByTestId('pr-row')).toHaveCount(0);
  expect(fake.files('main')['README.md']).toBe('# Game\nnew feature\n');
  expect(fake.refs.has('feature')).toBe(false);
  // pull brings the merge into the project
  await page.getByTestId('git-view-changes').click();
  await page.getByTestId('git-pull').click();
  await expect.poll(() => page.evaluate(() => (window as never as { codingStudio: { editor: { getState(): { workspace: { files: Map<string, { text?: string }> } } } } }).codingStudio.editor.getState().workspace.files.get('README.md')?.text)).toBe('# Game\nnew feature\n');

  await page.getByTestId('git-view-repo').click();
  await page.getByTestId('repo-name').fill('game-2');
  await page.getByTestId('repo-save').click();
  await expect(page.getByTestId('git-branch')).toContainText('lyra/game-2');
  expect(fake.name).toBe('game-2');
  await page.getByTestId('git-view-repo').click();
  await expect(page.getByTestId('repo-delete')).toBeDisabled();
  await page.getByTestId('repo-delete-confirm').fill('lyra/game-2');
  await page.getByTestId('repo-delete').click();
  await expect(page.getByTestId('git-not-linked')).toBeVisible();
  expect(fake.repoInfo.deleted).toBe(true);
});

test('create a GitHub repository from a project that has none', async ({ page }) => {
  const fake = new FakeGitHub('lyra', 'unused');
  await freshStart(page);
  await serveGitHub(page, fake);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Fresh');
  await page.getByTestId('create-project').click();
  await page.getByTestId('left-tab-git').click();
  await page.getByTestId('github-token').fill('github_pat_1234567890abcdefghij');
  await page.getByTestId('github-token-save').click();
  await page.getByTestId('publish-name').fill('fresh-game');
  await page.getByTestId('publish-create').click();
  await expect(page.getByTestId('git-branch')).toContainText('lyra/fresh-game · main');
  await expect.poll(() => Object.keys(fake.files('main')).sort()).toEqual(expect.arrayContaining(['README.md', 'codingstudio.json', 'main.vgraph', 'main.gd']));
  expect(fake.files('main')['main.gd']).toContain('extends Node');
  expect(fake.files('main')['.codingstudio/git.json']).toBeUndefined();
  await expect(page.getByTestId('git-change')).toHaveCount(0);
});

test('a visual React project is pushed with its generated code; graph edits show as generated changes; broken graphs are not pushed', async ({ page }) => {
  const fake = new FakeGitHub('lyra', 'unused');
  await freshStart(page);
  await serveGitHub(page, fake);
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Web');
  await page.getByTestId('project-language').selectOption('typescript');
  await page.locator('button', { hasText: 'Web app' }).click();
  await page.getByTestId('create-project').click();
  await page.getByTestId('left-tab-git').click();
  await page.getByTestId('github-token').fill('github_pat_1234567890abcdefghij');
  await page.getByTestId('github-token-save').click();
  await page.getByTestId('publish-name').fill('web-app');
  await page.getByTestId('publish-create').click();
  await expect.poll(() => fake.files('main')['src/App.tsx'] ?? '').toContain('export function App()');
  expect(Object.keys(fake.files('main'))).toEqual(expect.arrayContaining(['src/App.vgraph', 'src/main.tsx', 'package.json']));
  await expect(page.locator('[data-testid="git-change"][data-path="src/App.tsx"]')).toHaveCount(0);

  // edit the heading in the graph → App.tsx is listed as a generated change and gets pushed
  type W = { codingStudio: { editor: { getState(): { project: { scripts: { functions: { id: string; name: string; graph: { nodes: { id: string; type: string; props: { tag?: string } }[] } }[] }[] }; dispatch(o: unknown[], l: string): void } } } };
  await page.evaluate(() => {
    const st = (window as never as W).codingStudio.editor.getState();
    const fn = st.project.scripts[0].functions.find((f) => f.name === 'App')!;
    const h1 = fn.graph.nodes.find((n) => n.type === 'ts.element' && n.props.tag === 'h1')!;
    st.dispatch([{ op: 'update_node', graph: fn.id, node: h1.id, inputs: { child_0: 'Pushed heading' } }], 'test');
  });
  const row = page.locator('[data-testid="git-change"][data-path="src/App.tsx"]');
  await expect(row).toContainText('generated');
  await page.getByTestId('commit-message').fill('New heading');
  await page.getByTestId('commit-push').click();
  await expect.poll(() => fake.files('main')['src/App.tsx']).toContain('Pushed heading');

  // a graph with an error: the commit is refused with the error, nothing is pushed
  const head = fake.refs.get('main');
  await page.evaluate(() => {
    type E = { codingStudio: { editor: { getState(): { workspace: { files: Map<string, { text?: string }> }; applyFiles(o: unknown[], l: string): void } } } };
    const st = (window as never as E).codingStudio.editor.getState();
    const doc = JSON.parse(st.workspace.files.get('src/App.vgraph')!.text!);
    const g = doc.script.functions.find((f: { name: string }) => f.name === 'App').graph;
    const entry = g.nodes.find((n: { type: string }) => n.type === 'core.entry');
    g.nodes.push({ id: 'n_broken', type: 'core.no_such_node', position: { x: 0, y: 0 }, props: {}, inputs: {} });
    g.edges.push({ id: 'e_broken', from: { node: entry.id, port: 'then' }, to: { node: 'n_broken', port: 'exec' } });
    st.applyFiles([{ op: 'write_file', path: 'src/App.vgraph', content: JSON.stringify(doc, null, 2) }], 'break it');
  });
  await page.getByTestId('commit-message').fill('Broken');
  await page.getByTestId('commit-push').click();
  await expect(page.getByRole('button', { name: /Not pushed: \d+ errors? in the visual scripts/ })).toContainText('Unknown node type');
  expect(fake.refs.get('main')).toBe(head);
});
