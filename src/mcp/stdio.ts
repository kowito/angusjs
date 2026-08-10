/**
 * stdio transport.
 *
 * The client launches the server as a subprocess and exchanges newline-
 * delimited JSON-RPC over stdin/stdout. The one hard rule: nothing but MCP
 * messages may reach stdout — every log line goes to stderr, or it corrupts
 * the stream.
 */

import { dispatch, failure, isNotification, JSON_RPC_ERRORS, resolveEra, type DispatchContext, type JsonRpcRequest } from './protocol.ts'

/** Logs go to stderr; stdout belongs to the protocol. */
export function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

function write(payload: unknown): void {
  // Messages must not contain embedded newlines, which JSON.stringify honours.
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/**
 * Reads messages until stdin closes. Resolves when the client disconnects,
 * which is the signal to exit.
 */
export async function serveStdio(context: DispatchContext): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })

    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue

      let message: JsonRpcRequest
      try {
        message = JSON.parse(line) as JsonRpcRequest
      } catch {
        write(failure(null, JSON_RPC_ERRORS.parse, 'Invalid JSON.'))
        continue
      }

      try {
        const era = resolveEra(message, null)
        if ('code' in era) {
          write({ jsonrpc: '2.0', id: message.id ?? null, error: era })
          continue
        }

        const response = await dispatch(context, message, era)
        // Notifications are acknowledged by silence.
        if (response !== null && !isNotification(message)) write(response)
      } catch (error) {
        write(
          failure(
            message.id ?? null,
            JSON_RPC_ERRORS.internal,
            error instanceof Error ? error.message : String(error),
          ),
        )
      }
    }
  }
}
