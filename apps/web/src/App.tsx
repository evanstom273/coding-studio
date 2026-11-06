import { lazy, Suspense, useEffect } from 'react';
import { useRoute } from './lib/router';
import { Dashboard } from './components/dashboard/Dashboard';
import { Toasts } from './components/ui/Toasts';
import { ConfirmHost } from './components/ui/primitives';
import { initBridge } from './bridge/client';

const EditorShell = lazy(() => import('./components/EditorShell'));

export function App() {
  const route = useRoute();
  useEffect(() => initBridge(), []);
  return (
    <>
      {route.name === 'project' ? (
        <Suspense fallback={<div className="flex h-full items-center justify-center text-muted">Loading editor…</div>}>
          <EditorShell projectId={route.id} />
        </Suspense>
      ) : (
        <Dashboard />
      )}
      <Toasts />
      <ConfirmHost />
    </>
  );
}
