/**
 * Email templates.
 *
 * Deliberately small: a layout, two templates auth needs, and a helper to write
 * your own. Email HTML is a genuinely hostile format — tables, inline styles,
 * no flexbox in Outlook — and a framework that tried to abstract it would be
 * both large and wrong. What is here is the plain, single-column, inline-styled
 * layout that renders everywhere, and an escape hatch to replace it.
 *
 * Every template produces **both** `text` and `html`. A text alternative is not
 * decoration: some clients prefer it, and a mail with only HTML scores worse
 * with spam filters.
 */

import { esc } from '../html.ts'

export interface TemplateContext {
  /** Product name, shown in the header and signature. */
  siteName?: string
  /** Absolute base URL, used to build links. */
  siteUrl?: string
  [key: string]: unknown
}

export interface EmailTemplate {
  subject: string
  text: string
  html: string
}

const BASE_STYLE = 'margin:0;padding:24px;background:#f4f5f7;font-family:system-ui,-apple-system,"Segoe UI",sans-serif'
const CARD_STYLE =
  'max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dfe1e6;border-radius:8px;padding:28px'
const BUTTON_STYLE =
  'display:inline-block;padding:11px 20px;background:#1c6a4a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600'

export interface LayoutOptions {
  title: string
  /** Paragraphs of body copy. Escaped. */
  body: string[]
  action?: { label: string; url: string }
  /** Small print below the action. */
  footer?: string[]
  siteName?: string
}

/**
 * Wraps content in the layout. Inline styles only, because `<style>` blocks are
 * stripped by several major clients.
 */
export function renderEmail(options: LayoutOptions): { html: string; text: string } {
  const paragraphs = options.body
    .map((line) => `<p style="margin:0 0 14px;color:#23332b;line-height:1.6">${esc(line)}</p>`)
    .join('\n      ')

  const action = options.action
    ? `<p style="margin:22px 0"><a href="${esc(options.action.url)}" style="${BUTTON_STYLE}">${esc(
        options.action.label,
      )}</a></p>
      <p style="margin:0 0 14px;color:#5f7168;font-size:13px;line-height:1.6">
        If the button doesn't work, copy this link:<br>
        <a href="${esc(options.action.url)}" style="color:#1c6a4a;word-break:break-all">${esc(options.action.url)}</a>
      </p>`
    : ''

  const footer = (options.footer ?? [])
    .map((line) => `<p style="margin:0 0 6px;color:#8b9a91;font-size:12px;line-height:1.5">${esc(line)}</p>`)
    .join('\n      ')

  const html = `<!doctype html>
<html><body style="${BASE_STYLE}">
  <div style="${CARD_STYLE}">
    ${options.siteName ? `<p style="margin:0 0 18px;color:#8b9a91;font-size:12px;letter-spacing:.08em;text-transform:uppercase">${esc(options.siteName)}</p>` : ''}
    <h1 style="margin:0 0 16px;font-size:19px;color:#101c16">${esc(options.title)}</h1>
    ${paragraphs}
    ${action}
    ${footer ? `<hr style="border:0;border-top:1px solid #e6ece5;margin:22px 0 16px">\n      ${footer}` : ''}
  </div>
</body></html>`

  const text = [
    options.title,
    '',
    ...options.body,
    ...(options.action ? ['', options.action.label, options.action.url] : []),
    ...(options.footer?.length ? ['', ...options.footer] : []),
    '',
  ].join('\n')

  return { html, text }
}

// ---------------------------------------------------------------------------
// The templates auth needs
// ---------------------------------------------------------------------------

export interface PasswordResetInput extends TemplateContext {
  resetUrl: string
  /** Shown so the reader knows how long they have. Defaults to 1 hour. */
  expiresInMinutes?: number
}

export function passwordResetEmail(input: PasswordResetInput): EmailTemplate {
  const site = input.siteName ?? 'your account'
  const minutes = input.expiresInMinutes ?? 60

  const { html, text } = renderEmail({
    siteName: input.siteName,
    title: 'Reset your password',
    body: [
      `Someone asked to reset the password for ${site}.`,
      `This link works once and expires in ${minutes} minutes.`,
    ],
    action: { label: 'Choose a new password', url: input.resetUrl },
    // Said plainly, because the common case for receiving this unexpectedly is
    // someone mistyping their own address — not an attack.
    footer: ['If you didn\'t ask for this, you can ignore this email. Your password will not change.'],
  })

  return { subject: `Reset your ${site} password`, text, html }
}

export interface VerificationInput extends TemplateContext {
  verifyUrl: string
  expiresInMinutes?: number
}

export function verificationEmail(input: VerificationInput): EmailTemplate {
  const site = input.siteName ?? 'your account'
  const minutes = input.expiresInMinutes ?? 60

  const { html, text } = renderEmail({
    siteName: input.siteName,
    title: 'Confirm your email address',
    body: [`Confirm this address to finish setting up ${site}.`, `This link expires in ${minutes} minutes.`],
    action: { label: 'Confirm email address', url: input.verifyUrl },
    footer: ['If you didn\'t create an account, you can ignore this email.'],
  })

  return { subject: `Confirm your email address`, text, html }
}
