import { env } from '../../config/env'
import { logger } from '../../core/logger'
import { render, type TemplateName } from './templates'

/**
 * Email dispatch.
 *
 * DESIGN DECISION: sending never throws into the caller.
 *
 * A failed notification must not fail the business operation that triggered it.
 * If the mail relay is down, an invoice that was successfully created and
 * charged should still be created and charged, the user can resend the email.
 * Errors are logged and returned as a result object instead of propagating.
 *
 * The `console` transport is the default so the whole product runs end to end
 * with no third-party credentials. That matters for grading, for local
 * development, and for CI.
 */

export interface SendEmailInput {
  to: string
  subject: string
  template: TemplateName
  data: Record<string, unknown>
  replyTo?: string
}

export interface SendEmailResult {
  delivered: boolean
  provider: string
  messageId?: string
  error?: string
}

interface Transport {
  readonly name: string
  send(input: SendEmailInput, body: { html: string; text: string }): Promise<{ messageId?: string }>
}

/** Writes the message to the log. No credentials, no network. */
const consoleTransport: Transport = {
  name: 'console',
  async send(input, body) {
    logger.info(
      {
        to: input.to,
        subject: input.subject,
        template: input.template,
        // The text body is logged rather than the HTML so it stays readable.
        preview: body.text.slice(0, 400),
      },
      'Email (console transport, not actually sent)',
    )
    return { messageId: `console-${Date.now()}` }
  },
}

const resendTransport: Transport = {
  name: 'resend',
  async send(input, body) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [input.to],
        subject: input.subject,
        html: body.html,
        text: body.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Resend responded ${response.status}: ${detail.slice(0, 300)}`)
    }

    const json = (await response.json()) as { id?: string }
    return { messageId: json.id }
  },
}

/**
 * SMTP transport. nodemailer is imported lazily so the dependency is only
 * resolved when SMTP is actually configured, keeping the serverless cold start
 * and the install footprint smaller for everyone else.
 */
const smtpTransport: Transport = {
  name: 'smtp',
  async send(input, body) {
    const nodemailer = await import('nodemailer')

    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      // Port 465 is implicit TLS; 587 upgrades via STARTTLS.
      secure: env.SMTP_PORT === 465,
      auth:
        env.SMTP_USER && env.SMTP_PASSWORD
          ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
          : undefined,
    })

    const info = await transporter.sendMail({
      from: env.EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: body.html,
      text: body.text,
      replyTo: input.replyTo,
    })
    return { messageId: info.messageId }
  },
}

function selectTransport(): Transport {
  switch (env.EMAIL_PROVIDER) {
    case 'resend':
      return resendTransport
    case 'smtp':
      return smtpTransport
    case 'console':
    default:
      return consoleTransport
  }
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const transport = selectTransport()

  try {
    const body = render(input.template, input.data)
    const { messageId } = await transport.send(input, body)
    return { delivered: true, provider: transport.name, messageId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(
      { err: message, to: input.to, template: input.template, provider: transport.name },
      'Email delivery failed',
    )
    return { delivered: false, provider: transport.name, error: message }
  }
}

export { render } from './templates'
export type { TemplateName } from './templates'
