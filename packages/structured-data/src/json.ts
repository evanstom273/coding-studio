/** JSON / JSONC: edits through jsonc-parser, which changes only the affected text (comments survive). */
import { applyEdits as applyTextEdits, findNodeAtLocation, modify, parse, parseTree, printParseErrorCode, type FormattingOptions, type ParseError } from 'jsonc-parser';
import { applyToValue, getIn, isObject, type Edit, type Value } from './model';

export function parseJson(text: string): { value?: Value; errors: { message: string; offset: number; line: number }[] } {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as Value;
  return { value: text.trim() ? value : undefined, errors: errors.map((e) => ({ message: printParseErrorCode(e.error), offset: e.offset, line: text.slice(0, e.offset).split('\n').length })) };
}

function formatting(text: string): FormattingOptions {
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m?.[1] ?? '  ';
  return { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 1 : indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

export function editJson(text: string, edits: Edit[]): string {
  const fo = formatting(text);
  let out = text.trim() ? text : '{}\n';
  for (const e of edits) out = editOne(out, e, fo);
  if (text.trim() && text.endsWith('\n') && !out.endsWith('\n')) out += fo.eol;
  if (!text.trim() && !out.endsWith('\n')) out += '\n';
  return out;
}

function editOne(text: string, e: Edit, fo: FormattingOptions): string {
  const mod = (path: (string | number)[], value: unknown, opts: { isArrayInsertion?: boolean } = {}) => applyTextEdits(text, modify(text, path, value, { formattingOptions: fo, ...opts }));
  switch (e.op) {
    case 'set':
      return mod(e.path, e.value);
    case 'delete':
      return mod(e.path, undefined);
    case 'insert': {
      const arr = getIn(parse(text) as Value, e.path);
      const index = e.index ?? (Array.isArray(arr) ? arr.length : 0);
      if (!Array.isArray(arr)) return mod(e.path, [e.value]);
      return mod([...e.path, index], e.value, { isArrayInsertion: true });
    }
    case 'rename': {
      // Replace just the key's text, so the value and everything around it stay as they were.
      const tree = parseTree(text);
      const node = tree && findNodeAtLocation(tree, e.path);
      const key = node?.parent?.children?.[0];
      if (!key || key.type !== 'string') return text;
      return text.slice(0, key.offset) + JSON.stringify(e.to) + text.slice(key.offset + key.length);
    }
    case 'move': {
      const parentPath = e.path.slice(0, -1);
      const after = getIn(applyToValue(parse(text) as Value, [e]), parentPath);
      if (Array.isArray(after) || isObject(after)) return mod(parentPath, after);
      return text;
    }
  }
}
