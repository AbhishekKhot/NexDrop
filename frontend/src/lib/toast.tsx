/**
 * toast.tsx
 * Lightweight toast notification system for surfacing errors and warnings.
 *
 * Implemented as a React context so any component in the tree can call
 * addToast() without prop drilling.  Toasts are rendered in a fixed overlay
 * at the bottom-right of the viewport — outside the normal document flow —
 * so they appear on top of all page content regardless of z-index stacking.
 *
 * Design decisions:
 *  - Auto-dismiss after 5 seconds keeps the UI clean without requiring user action.
 *  - Maximum 5 toasts at once prevents flooding the screen during error storms
 *    (e.g. repeated WebSocket reconnect failures).  The oldest toast is evicted
 *    when the cap is reached, because newer errors are generally more actionable.
 *  - Manual dismiss button lets the user clear a toast before the timer fires
 *    (useful for long error messages they want to read carefully).
 *
 * ERR-05: This module is the single UI surface for agent errors, send failures,
 * and signaling errors.  Previously these were silently dropped or only visible
 * in the browser console.
 */

import React, { createContext, useCallback, useContext, useState } from 'react';

export type ToastLevel = 'error' | 'warning' | 'info';

export interface Toast {
  id: string;       // unique per toast — used as React key and for targeted dismiss
  message: string;
  level: ToastLevel;
}

interface ToastContextValue {
  /** Add a toast notification.  Level defaults to 'error' if omitted. */
  addToast: (message: string, level?: ToastLevel) => void;
}

/**
 * Default context value (no-op) used when a component calls useToast() outside
 * a ToastProvider — prevents a runtime crash in tests or isolated rendering
 * where the provider might be absent.
 */
const ToastContext = createContext<ToastContextValue>({
  addToast: () => undefined,
});

/** Hook to access addToast() from any component inside ToastProvider */
export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 5_000;

/**
 * ToastProvider wraps the application and provides the toast context.
 *
 * Should be placed near the root of the component tree (in App.tsx) so all
 * pages and hooks can call useToast() without re-mounting the provider.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  /**
   * Add a new toast notification.
   *
   * Eviction policy: if adding the new toast would exceed MAX_TOASTS, the
   * oldest entries are sliced off the front.  Newer errors take priority
   * because they are more likely to still be actionable.
   *
   * useCallback with [] deps: addToast is referentially stable so components
   * can safely list it as a useEffect dependency without causing re-runs.
   */
  const addToast = useCallback((message: string, level: ToastLevel = 'error') => {
    const id = crypto.randomUUID();
    setToasts((prev) => {
      const next = [...prev, { id, message, level }];
      // Evict oldest if over cap — keep the newest MAX_TOASTS entries
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });
    // Auto-dismiss: the filter is a no-op if the user already dismissed this toast
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  /**
   * Remove a specific toast immediately (user clicked the dismiss button).
   * Independent of the auto-dismiss timer — both can fire without conflict.
   */
  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Render the overlay only when toasts are present — avoids an invisible
          fixed div sitting in the hit-test layer over page content */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            bottom: '1.5rem',
            right: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            zIndex: 9999,
            maxWidth: '380px',
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.75rem',
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                background:
                  t.level === 'error'
                    ? '#2d1a1a'
                    : t.level === 'warning'
                    ? '#2d2518'
                    : '#1a2333',
                border: `1px solid ${
                  t.level === 'error'
                    ? '#c0392b'
                    : t.level === 'warning'
                    ? '#e67e22'
                    : '#2980b9'
                }`,
                color: '#e8eaed',
                fontSize: '0.875rem',
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                animation: 'slideIn 0.2s ease',
              }}
            >
              {/* Level icon — quick visual cue that doesn't rely on colour alone */}
              <span style={{ flexShrink: 0 }}>
                {t.level === 'error' ? '✕' : t.level === 'warning' ? '⚠' : 'ℹ'}
              </span>
              {/* wordBreak prevents long URLs or stack traces overflowing the container */}
              <span style={{ flex: 1, wordBreak: 'break-word' }}>{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                style={{
                  flexShrink: 0,
                  background: 'none',
                  border: 'none',
                  color: '#888',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: '1rem',
                  lineHeight: 1,
                }}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
