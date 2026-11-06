import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ label: string; children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-[14px] font-semibold text-err">{this.props.label} crashed</div>
        <pre className="max-w-xl whitespace-pre-wrap text-[11px] text-muted">{this.state.error.message}</pre>
        <p className="text-[12px] text-muted">Your project is autosaved. Reloading usually fixes this.</p>
        <button className="rounded bg-panel-2 px-3 py-1" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
