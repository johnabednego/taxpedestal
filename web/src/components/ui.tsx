import clsx from 'clsx'
import { Loader2, X } from 'lucide-react'
import {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react'

/* -------------------------------------------------------------------------- */
/* Button                                                                      */
/* -------------------------------------------------------------------------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-cobalt text-white hover:bg-cobalt-600 active:bg-cobalt-700 shadow-sm',
  secondary: 'bg-white text-ink-900 border border-ink-200 hover:bg-ink-50 hover:border-ink-300',
  ghost: 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
  danger: 'bg-rose text-white hover:bg-rose-700',
  subtle: 'bg-ink-100 text-ink-800 hover:bg-ink-200',
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      // Disabled while loading so a double click cannot submit twice — the
      // client-side half of the idempotency story.
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors',
        'disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                 */
/* -------------------------------------------------------------------------- */

interface FieldWrapperProps {
  label?: string
  hint?: string
  error?: string
  required?: boolean
  children: ReactNode
  htmlFor?: string
}

export function Field({ label, hint, error, required, children, htmlFor }: FieldWrapperProps) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-800">
          {label}
          {required && <span className="text-rose ml-0.5">*</span>}
        </label>
      )}
      {children}
      {/* role=alert so screen readers announce validation failures. */}
      {error ? (
        <p role="alert" className="text-xs text-rose">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-500">{hint}</p>
      ) : null}
    </div>
  )
}

const controlClass =
  'w-full rounded-lg border bg-white px-3 text-sm text-ink-900 placeholder:text-ink-400 ' +
  'transition-colors focus:border-cobalt focus:outline-none focus:ring-2 focus:ring-cobalt/20 ' +
  'disabled:bg-ink-50 disabled:text-ink-500'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
  mono?: boolean
}

export function Input({ label, hint, error, mono, className, ...props }: InputProps) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} required={props.required} htmlFor={id}>
      <input
        id={id}
        {...props}
        aria-invalid={Boolean(error)}
        className={clsx(
          controlClass,
          'h-10',
          mono && 'font-mono tnum',
          error ? 'border-rose' : 'border-ink-200',
          className,
        )}
      />
    </Field>
  )
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  hint?: string
  error?: string
}

export function Select({ label, hint, error, className, children, ...props }: SelectProps) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} required={props.required} htmlFor={id}>
      <select
        id={id}
        {...props}
        className={clsx(
          controlClass,
          'h-10 appearance-none bg-[length:16px] bg-[right_0.65rem_center] bg-no-repeat pr-9',
          error ? 'border-rose' : 'border-ink-200',
          className,
        )}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235C74A3' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        }}
      >
        {children}
      </select>
    </Field>
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  error?: string
}

export function Textarea({ label, hint, error, className, ...props }: TextareaProps) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} required={props.required} htmlFor={id}>
      <textarea
        id={id}
        rows={3}
        {...props}
        className={clsx(
          controlClass,
          'py-2 resize-y',
          error ? 'border-rose' : 'border-ink-200',
          className,
        )}
      />
    </Field>
  )
}

export function Checkbox({
  label,
  description,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  const id = useId()
  return (
    <div className="flex gap-2.5">
      <input
        id={id}
        type="checkbox"
        {...props}
        className="mt-0.5 h-4 w-4 rounded border-ink-300 text-cobalt focus:ring-cobalt/30"
      />
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-ink-800">
          {label}
        </label>
        {description && <p className="text-xs text-ink-500">{description}</p>}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

export function Card({
  className,
  children,
  padded = true,
}: {
  className?: string
  children: ReactNode
  padded?: boolean
}) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-ink-100 bg-white shadow-card',
        padded && 'p-5',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
        {description && <p className="text-sm text-ink-500 mt-0.5">{description}</p>}
      </div>
      {action}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const TONES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700',
  info: 'bg-cobalt-50 text-cobalt-700',
  success: 'bg-jade-50 text-jade-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-rose-50 text-rose-700',
}

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-md px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Invoice status -> tone. Kept in one place so colour meaning never drifts. */
export const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  SENT: 'info',
  VIEWED: 'info',
  PARTIALLY_PAID: 'warning',
  PAID: 'success',
  OVERDUE: 'danger',
  VOID: 'neutral',
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  VIEWED: 'Viewed',
  PARTIALLY_PAID: 'Part paid',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
  VOID: 'Void',
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-ink-100 text-ink-500">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-ink-900">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} />
}

export function ErrorNotice({ title, message }: { title?: string; message: string }) {
  return (
    <div role="alert" className="rounded-lg border border-rose-100 bg-rose-50 px-4 py-3">
      {title && <p className="text-sm font-semibold text-rose-700">{title}</p>}
      <p className="text-sm text-rose-700">{message}</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Modal                                                                       */
/* -------------------------------------------------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'md' | 'lg'
}) {
  // Escape must close, and the page behind must not scroll.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-ink-900/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'relative w-full rounded-t-2xl sm:rounded-2xl bg-white shadow-lift animate-fade-up',
          'max-h-[92vh] overflow-y-auto',
          size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-ink-100 bg-ink-50/60 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                      */
/* -------------------------------------------------------------------------- */

interface Toast {
  id: number
  tone: Tone
  message: string
}

const ToastContext = createContext<{ push: (message: string, tone?: Tone) => void }>({
  push: () => undefined,
})

export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = (message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, tone, message }])
    setTimeout(() => setToasts((c) => c.filter((t) => t.id !== id)), 5000)
  }

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={clsx(
              'pointer-events-auto animate-slide-in rounded-lg border px-4 py-3 text-sm shadow-lift',
              toast.tone === 'success' && 'border-jade-100 bg-jade-50 text-jade-700',
              toast.tone === 'danger' && 'border-rose-100 bg-rose-50 text-rose-700',
              toast.tone === 'warning' && 'border-amber-100 bg-amber-50 text-amber-700',
              (toast.tone === 'info' || toast.tone === 'neutral') &&
                'border-ink-200 bg-white text-ink-800',
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
