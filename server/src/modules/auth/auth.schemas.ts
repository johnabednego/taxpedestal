import { z } from 'zod'
import { SUPPORTED_CURRENCY_CODES } from '../../core/money'
import { isValidCountry } from '../../core/countries'

/**
 * Request schemas.
 *
 * Password policy follows NIST SP 800-63B: length is the primary control, and
 * composition rules (one uppercase, one symbol) are deliberately NOT enforced
 * because they push users toward predictable substitutions like "Password1!"
 * while blocking strong passphrases.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters — a short phrase works well')
  .max(200, 'That password is too long')
  .refine((v) => v.trim().length > 0, 'Password cannot be only whitespace')

export const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Tell us your name').max(120),
  email: z.string().trim().toLowerCase().email('That does not look like an email address'),
  password: passwordSchema,
  organisationName: z.string().trim().min(2, 'Give your workspace a name').max(140),
  // ANY ISO 3166 country. Tax automation is a separate capability; a business
  // in a country we have no rules for can still register and invoice, defining
  // its own tax in Settings. Gating registration on tax coverage was a locked
  // door, not a feature.
  country: z
    .string()
    .trim()
    .toUpperCase()
    .length(2, 'Use a two-letter country code')
    .refine(isValidCountry, 'Unknown country code'),
  baseCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((c) => SUPPORTED_CURRENCY_CODES.includes(c), 'Unsupported currency'),
})

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter your email address'),
  password: z.string().min(1, 'Enter your password'),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(10).optional(),
})

export const verifyEmailSchema = z.object({ token: z.string().min(10) })

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: passwordSchema,
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
})
