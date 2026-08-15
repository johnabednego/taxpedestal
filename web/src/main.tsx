import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { AuthProvider } from './lib/auth'
import { I18nProvider } from './i18n'
import { ToastProvider } from './components/ui'
import { LocaleSync } from './components/LocaleSync'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Financial data goes stale quickly; a 30s window keeps the UI responsive
      // without showing a paid invoice as unpaid for minutes.
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Never retry auth or validation failures, they will fail identically.
        const status = (error as { status?: number })?.status
        if (status && status >= 400 && status < 500) return false
        return failureCount < 2
      },
      refetchOnWindowFocus: true,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Outermost of the app providers: everything below may need to
          translate, including error boundaries and toasts. */}
      <I18nProvider>
        <AuthProvider>
          <ToastProvider>
            {/* Reconciles the browser's language with the account's. */}
            <LocaleSync />
            <App />
          </ToastProvider>
        </AuthProvider>
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
