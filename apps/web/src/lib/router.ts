import { useSyncExternalStore } from 'react';

export type Route = { name: 'dashboard' } | { name: 'project'; id: string };

function parse(): Route {
  const m = /^#\/project\/([A-Za-z0-9_-]+)/.exec(window.location.hash);
  return m ? { name: 'project', id: m[1] } : { name: 'dashboard' };
}

let current = parse();
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = parse();
  listeners.forEach((l) => l());
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function navigate(r: Route) {
  window.location.hash = r.name === 'project' ? `#/project/${r.id}` : '#/';
}
