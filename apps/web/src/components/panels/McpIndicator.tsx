import { Bot } from 'lucide-react';
import { useBridge } from '@web/bridge/client';
import { useUI } from '@web/store/ui';
import { cx } from '../ui/primitives';

const COLORS: Record<string, string> = { off: 'bg-[#4b5262]', connecting: 'bg-amber-400', connected: 'bg-emerald-400', unavailable: 'bg-amber-500', busy: 'bg-red-400', revoked: 'bg-red-400' };

export function McpIndicator({ compact = false }: { compact?: boolean }) {
  const { status, statusText } = useBridge();
  const setUI = useUI((s) => s.set);
  return (
    <button onClick={() => setUI({ dialog: 'mcp' })} title={statusText} data-testid="mcp-indicator" className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 text-[12px] text-muted hover:bg-panel-2 hover:text-text">
      <Bot size={15} />
      <span className={cx('h-2 w-2 rounded-full', COLORS[status], status === 'connecting' && 'animate-pulse')} />
      <span className={compact ? 'sr-only' : ''}>{status === 'connected' ? 'Claude connected' : status === 'off' ? 'MCP off' : status === 'busy' ? 'Other tab' : status === 'revoked' ? 'Taken over' : 'MCP waiting'}</span>
    </button>
  );
}
