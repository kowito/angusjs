/** Terminal output helpers. Colours are dropped when stdout isn't a TTY. */

const enabled = Bun.enableANSIColors

const wrap = (code: string) => (text: string) => (enabled ? `[${code}m${text}[0m` : text)

export const bold = wrap('1')
export const dim = wrap('2')
export const red = wrap('31')
export const green = wrap('32')
export const yellow = wrap('33')
export const blue = wrap('34')
export const magenta = wrap('35')
export const cyan = wrap('36')

export function info(message: string): void {
  console.log(message)
}

export function success(message: string): void {
  console.log(`${green('✓')} ${message}`)
}

export function warn(message: string): void {
  console.warn(`${yellow('!')} ${message}`)
}

export function fail(message: string): void {
  console.error(`${red('✗')} ${message}`)
}

export function heading(message: string): void {
  console.log(`\n${bold(message)}`)
}

/** Renders an aligned table. `align` marks columns that should be right-aligned. */
export function table(rows: string[][], options: { head?: string[]; gap?: number } = {}): void {
  const gap = options.gap ?? 2
  const all = options.head ? [options.head, ...rows] : rows
  if (all.length === 0) return

  const widths: number[] = []
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, stripAnsi(cell).length)
    })
  }

  const render = (row: string[]) =>
    row
      .map((cell, index) =>
        index === row.length - 1 ? cell : cell + ' '.repeat(widths[index]! - stripAnsi(cell).length + gap),
      )
      .join('')

  if (options.head) {
    console.log(bold(render(options.head)))
    console.log(dim(render(widths.map((width) => '─'.repeat(width)))))
  }
  for (const row of rows) console.log(render(row))
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[\d+m/g, '')
}
