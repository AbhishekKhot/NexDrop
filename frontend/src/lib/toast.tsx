/**
 * toast.tsx
 * Lightweight toast notification context.
 *
 * ERR-05: Surface agent errors, send failures, and signaling errors to the user.
 * Toasts auto-dismiss after 5 s; up to 5 shown at once (oldest evicted).
 */

import React, { createContext, useCallback, useContext, useState } from 'react';

export type ToastLevel = 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  message: string;
  level: ToastLevel;
}

interface ToastContextValue {
  addToast: (message: string, level?: ToastLevel) => void;
}

const ToastContext = createContext<ToastContextValue>({
  addToast: () => undefined,
});

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

const MAX_TOASTS = 5;
const AUTO_DISMISS_MS = 5_000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, level: ToastLevel = 'error') => {
    const id = crypto.randomUUID();
    setToasts((prev) => {
      const next = [...prev, { id, message, level }];
      // Evict oldest if over cap
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    });
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
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
              <span style={{ flexShrink: 0 }}>
                {t.level === 'error' ? '✕' : t.level === 'warning' ? '⚠' : 'ℹ'}
              </span>
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
