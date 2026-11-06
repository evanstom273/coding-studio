/**
 * Monaco bundled locally (no CDN), with only the core editor and our own GDScript tokenizer.
 */
import 'monaco-editor/esm/vs/editor/editor.all.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import { loader } from '@monaco-editor/react';
// Syntax highlighting for common project files (tokenizers only; language services come later).
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

monaco.languages.register({ id: 'gdscript', extensions: ['.gd'] });
monaco.languages.setMonarchTokensProvider('gdscript', {
  keywords: ['if', 'elif', 'else', 'for', 'while', 'match', 'when', 'break', 'continue', 'pass', 'return', 'class', 'class_name', 'extends', 'is', 'in', 'as', 'self', 'super', 'signal', 'func', 'static', 'const', 'enum', 'var', 'await', 'preload', 'and', 'or', 'not', 'true', 'false', 'null', 'void'],
  types: ['bool', 'int', 'float', 'String', 'Array', 'Dictionary', 'Variant', 'Vector2', 'Vector3', 'Color', 'Node', 'Object'],
  tokenizer: {
    root: [
      [/##.*$/, 'comment.doc'],
      [/#.*$/, 'comment'],
      [/@[a-zA-Z_]+/, 'annotation'],
      [/\$[A-Za-z0-9_/]+/, 'string.nodepath'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/\b\d+\.\d*([eE][-+]?\d+)?\b|\b\d+([eE][-+]?\d+)?\b/, 'number'],
      [/\b[A-Z][A-Za-z0-9_]*\b/, 'type'],
      [/[a-zA-Z_]\w*(?=\s*\()/, 'function'],
      [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
    ],
  },
});
monaco.editor.defineTheme('coding-studio', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'ff7085' },
    { token: 'type', foreground: '8effda' },
    { token: 'function', foreground: '57b3ff' },
    { token: 'annotation', foreground: 'ffb373' },
    { token: 'string', foreground: 'ffeda1' },
    { token: 'string.nodepath', foreground: '63c259' },
    { token: 'number', foreground: 'a1ffe0' },
    { token: 'comment', foreground: '6f7889' },
    { token: 'comment.doc', foreground: '99b3cc' },
  ],
  colors: { 'editor.background': '#12151b', 'editorLineNumber.foreground': '#4b5262', 'editor.lineHighlightBackground': '#1a1f28' },
});

export { monaco };
