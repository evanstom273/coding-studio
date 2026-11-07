/** YAML: edits through the yaml Document model, which keeps comments, anchors and layout. */
import { isMap, isPair, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import type { Edit, Path, Value } from './model';

export function parseYaml(text: string): { value?: Value; errors: { message: string; line: number }[] } {
  const doc = parseDocument(text);
  return { value: text.trim() ? (doc.toJS() as Value) : undefined, errors: doc.errors.map((e) => ({ message: e.message.split('\n')[0], line: (e.linePos?.[0].line ?? 1) as number })) };
}

const node = (doc: Document, path: Path) => (path.length ? doc.getIn(path, true) : doc.contents);

export function editYaml(text: string, edits: Edit[]): string {
  const doc = parseDocument(text.trim() ? text : '{}\n');
  for (const e of edits) {
    switch (e.op) {
      case 'set':
        if (!e.path.length) doc.contents = doc.createNode(e.value) as never;
        else {
          const cur = doc.getIn(e.path, true);
          // Keep a scalar node (and its comment) when only its value changes.
          if (isScalar(cur) && (e.value === null || typeof e.value !== 'object')) cur.value = e.value;
          else doc.setIn(e.path, doc.createNode(e.value));
        }
        break;
      case 'delete':
        doc.deleteIn(e.path);
        break;
      case 'insert': {
        const seq = node(doc, e.path);
        const item = doc.createNode(e.value);
        if (isSeq(seq)) seq.items.splice(e.index ?? seq.items.length, 0, item);
        else doc.setIn(e.path, doc.createNode([e.value]));
        break;
      }
      case 'rename': {
        const parent = node(doc, e.path.slice(0, -1));
        if (!isMap(parent)) break;
        const pair = parent.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === e.path[e.path.length - 1]);
        if (pair && isScalar(pair.key)) pair.key.value = e.to;
        break;
      }
      case 'move': {
        const parent = node(doc, e.path.slice(0, -1));
        const last = e.path[e.path.length - 1];
        if (isSeq(parent) && typeof last === 'number') {
          const [it] = parent.items.splice(last, 1);
          parent.items.splice(e.to, 0, it);
        } else if (isMap(parent)) {
          const i = parent.items.findIndex((p) => isScalar(p.key) && p.key.value === last);
          if (i >= 0) {
            const [it] = parent.items.splice(i, 1);
            parent.items.splice(e.to, 0, it);
          }
        }
        break;
      }
    }
  }
  const out = doc.toString();
  return out === '{}\n' && !text.trim() ? '' : out;
}
