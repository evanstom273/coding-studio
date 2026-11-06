import { memo, useEffect, useState } from 'react';
import type { JsonValue } from '@cs/graph-core';
import type { PortSpec } from '@cs/node-registry';
import { useEditor } from '@web/store/editor';
import { toolchainFor } from '@web/lib/toolchain';

function commit(nodeId: string, port: string, value: JsonValue | null) {
  useEditor.getState().tryDispatch([{ op: 'update_node', node: nodeId, inputs: { [port]: value } }], 'Edit value', { mergeKey: `inline:${nodeId}:${port}` });
}

function NumberBox({ value, int, onCommit, label }: { value: number; int: boolean; onCommit: (v: number) => void; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      aria-label={label}
      className="bp-input nodrag w-[52px]"
      value={text}
      inputMode="decimal"
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n) && (!int || Number.isInteger(n))) onCommit(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/** Inline literal editor for an unconnected data input. */
export const InlineInput = memo(function InlineInput({ nodeId, port, value, language }: { nodeId: string; port: PortSpec; value: JsonValue | undefined; language: string }) {
  const t = port.type;
  if (!t || port.connectionOnly) return null;
  const v = value !== undefined ? value : port.default;
  const label = `${port.name || port.id} value`;
  switch (t.kind) {
    case 'bool':
      return <input aria-label={label} type="checkbox" className="nodrag h-3.5 w-3.5 accent-[#e05a5a]" checked={v === true} onChange={(e) => commit(nodeId, port.id, e.target.checked)} />;
    case 'int':
    case 'float':
      return <NumberBox label={label} value={typeof v === 'number' ? v : 0} int={t.kind === 'int'} onCommit={(n) => commit(nodeId, port.id, n)} />;
    case 'string':
      return <input aria-label={label} className="bp-input nodrag w-[110px]" value={typeof v === 'string' ? v : ''} onChange={(e) => commit(nodeId, port.id, e.target.value)} />;
    case 'any':
      return <input aria-label={label} className="bp-input nodrag w-[90px]" placeholder="value" value={v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)} onChange={(e) => commit(nodeId, port.id, e.target.value)} />;
    case 'named': {
      const fields = toolchainFor(language).adapter.types.structFields(t.name);
      if (!fields) return null;
      const obj = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, JsonValue>;
      return (
        <span className="flex gap-0.5">
          {fields.map((f) => (
            <NumberBox key={f.name} label={`${label} ${f.name}`} value={typeof obj[f.name] === 'number' ? (obj[f.name] as number) : 0} int={f.type.kind === 'int'} onCommit={(n) => commit(nodeId, port.id, { ...Object.fromEntries(fields.map((x) => [x.name, typeof obj[x.name] === 'number' ? obj[x.name] : 0])), [f.name]: n })} />
          ))}
        </span>
      );
    }
    default:
      return null;
  }
});
