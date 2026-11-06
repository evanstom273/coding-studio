/// <reference types="vite/client" />
declare module 'monaco-editor/esm/vs/editor/editor.all.js';
declare module 'monaco-editor/esm/vs/editor/editor.worker.js?worker' {
  const W: new () => Worker;
  export default W;
}
declare module 'monaco-editor/esm/vs/editor/editor.api.js' {
  export * from 'monaco-editor';
}
