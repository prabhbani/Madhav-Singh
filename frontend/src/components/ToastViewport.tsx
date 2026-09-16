import type { Toast } from '../utils/toast';
export function ToastViewport({ toasts }: { toasts: Toast[] }) { return <div className="toast-viewport" aria-live="polite">{toasts.map((toast) => <div className={`toast ${toast.tone}`} key={toast.id}>{toast.message}</div>)}</div>; }
