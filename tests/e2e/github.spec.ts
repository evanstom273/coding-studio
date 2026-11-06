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
