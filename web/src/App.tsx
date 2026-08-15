import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from './lib/auth'
import AppShell from './components/AppShell'
import Landing from './pages/Landing'
import { Login, Register } from './pages/Auth'
import { AcceptInvite, ForgotPassword, ResetPassword, VerifyEmail } from './pages/AuthFlows'
import Dashboard from './pages/Dashboard'
import { Clients, Invoices } from './pages/Lists'
import InvoiceBuilder from './pages/InvoiceBuilder'
import { InvoiceDetail, PublicInvoice } from './pages/InvoiceDetail'
import Settings from './pages/Settings'
import Admin from './pages/Admin'

/**
 * Guards the authenticated area.
 *
 * Waits for the silent refresh to finish before deciding, otherwise a page
 * reload would bounce a signed-in user to the login screen for a frame.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-400" />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        {/* Landing points for every transactional email we send. Without these
            the emails work perfectly and every journey dead-ends. */}
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        {/* Public, unauthenticated — the customer paying an invoice. */}
        <Route path="/pay/:token" element={<PublicInvoice />} />

        {/* Reached from emails. These previously did not exist, so every
            verification, reset and invitation link fell through to the
            catch-all and landed on the marketing page. */}

        <Route
          path="/app"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="invoices" element={<Invoices />} />
          <Route path="invoices/new" element={<InvoiceBuilder />} />
          <Route path="invoices/:id" element={<InvoiceDetail />} />
          <Route path="clients" element={<Clients />} />
          <Route path="settings" element={<Settings />} />
          <Route path="admin" element={<Admin />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
