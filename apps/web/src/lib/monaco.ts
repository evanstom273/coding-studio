/**
 * Monaco bundled locally (no CDN): the core editor, our GDScript tokenizer, and the TypeScript /
 * JavaScript, CSS, HTML and JSON language services (each runs in its own web worker, loaded the
 * first time a file of that kind is opened).
 */
import 'monaco-editor/esm/vs/editor/editor.all.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import * as tsContribution from 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/css/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/html/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
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

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: (_id: string, label: string) => {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  },
};

/** The parts of Monaco's TypeScript contribution we use (its .d.ts doesn't export them). */
export interface TsDiagnostic {
  start?: number;
  length?: number;
  messageText: string | { messageText: string; next?: unknown[] };
  category: number; // 0 warning, 1 error, 2 suggestion, 3 message
  code: number;
}
export interface TsWorker {
  getSemanticDiagnostics(fileName: string): Promise<TsDiagnostic[]>;
  getSyntacticDiagnostics(fileName: string): Promise<TsDiagnostic[]>;
}
interface TsDefaults {
  setCompilerOptions(o: Record<string, unknown>): void;
  setEagerModelSync(v: boolean): void;
  setDiagnosticsOptions(o: { noSemanticValidation?: boolean; noSyntaxValidation?: boolean; diagnosticCodesToIgnore?: number[] }): void;
  addExtraLib(content: string, filePath?: string): { dispose(): void };
}
interface TsApi {
  ScriptTarget: Record<string, number>;
  ModuleKind: Record<string, number>;
  ModuleResolutionKind: Record<string, number>;
  JsxEmit: Record<string, number>;
  typescriptDefaults: TsDefaults;
  javascriptDefaults: TsDefaults;
  getTypeScriptWorker(): Promise<(...uris: unknown[]) => Promise<TsWorker>>;
}
const ts = tsContribution as unknown as TsApi;

// One TypeScript program over every model: workspace files and generated graph code (see tsProject.ts).
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
  allowNonTsExtensions: true,
  isolatedModules: true,
  skipLibCheck: true,
  noEmit: true,
  lib: ['es2022', 'dom', 'dom.iterable'],
};
ts.typescriptDefaults.setCompilerOptions(compilerOptions);
ts.javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: false });
ts.typescriptDefaults.setEagerModelSync(true);
ts.javascriptDefaults.setEagerModelSync(true);
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

export { monaco, ts as tsLanguage };
