import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './index.css';
import { App } from './App';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { useEditor } from './store/editor';
import { useCatalog } from './lib/catalogStore';

// Handle for debugging from the browser console (and for end-to-end tests).
(window as unknown as { codingStudio: unknown }).codingStudio = { editor: useEditor, catalog: useCatalog };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Coding Studio">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
