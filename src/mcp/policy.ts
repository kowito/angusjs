/**
 * What an agent is allowed to do, as distinct from what its user is allowed to
 * do.
 *
 * Route permissions already decide whether the *person* behind a request may
 * perform it, and MCP tool calls go through those routes, so an agent can never
 * exceed its user. The gap this fills is the other direction: an agent should
 * usually have *less* authority than the person operating it. "This assistant
 * may read orders and issue refunds, but may not delete customers" is not
 * expressible as a user permission, because the same human can do all three
 * through the admin.
 *
 * Two mechanisms, deliberately separate:
 *
 * - **Exposure** decides which tools exist at all. A tool that is not exposed
 *   never appears in `tools/list` and cannot be called by name, so a model
 *   cannot be talked into using it — the capability simply isn't there.
 * - **Confirmation** keeps a tool available but makes its effect a two-step
 *   act, so an irreversible call cannot happen on a single inference.
 */

import type { Tool } from './tools.ts'

/** The argument a tool under confirmation must carry. */
export const CONFIRM_ARGUMENT = 'confirm'

export interface ToolPolicy {
  /**
   * Only these tools exist. Names may end in `*` to match a prefix, which is
   * how a whole resource is granted: `orders_*`.
   *
   * Absent means "everything not denied". Present and empty means nothing —
   * an explicit choice rather than an accident, and treated as such.
   */
  allow?: readonly string[]
  /** These tools never exist, whatever `allow` says. Deny wins. */
  deny?: readonly string[]
  /**
   * These tools require `confirm: true` in their arguments. Defaults to every
   * tool the route model marks destructive, which is every DELETE.
   *
   * Pass `[]` to turn confirmation off, which is reasonable for an agent whose
   * writes are already reviewed elsewhere.
   */
  confirm?: readonly string[]
  /**
   * Called for a denied or unconfirmed call, so a host can log or explain it.
   */
  onRefusal?: (refusal: Refusal) => void
}

export interface Refusal {
  tool: string
  reason: 'not-exposed' | 'unconfirmed'
  detail: string
}

/** True when `name` matches `pattern`, which may end in `*`. */
function matches(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name
}

function listed(patterns: readonly string[] | undefined, name: string): boolean {
  return patterns !== undefined && patterns.some((pattern) => matches(pattern, name))
}

/**
 * Removes tools the policy does not expose.
 *
 * Filtering the list rather than rejecting the call is the point: a capability
 * that is never advertised cannot be argued into existence by a prompt, and the
 * model wastes no attempt on it.
 */
export function applyPolicy(tools: Tool[], policy: ToolPolicy = {}): Tool[] {
  return tools.filter((tool) => {
    if (listed(policy.deny, tool.name)) return false
    // An absent `allow` permits everything; a present one is exhaustive, so an
    // empty array means no tools rather than no restriction.
    if (policy.allow !== undefined && !listed(policy.allow, tool.name)) return false
    return true
  })
}

/** Whether this tool's effects need a second, explicit step. */
export function needsConfirmation(tool: Tool, policy: ToolPolicy = {}): boolean {
  if (policy.confirm !== undefined) return listed(policy.confirm, tool.name)
  return tool.annotations?.destructiveHint === true
}

/**
 * Adds the `confirm` argument to a tool's schema, and says why it is there.
 *
 * The argument lives in the schema rather than in an out-of-band handshake
 * because the modern protocol has no server-to-client channel on a stateless
 * POST: there is nothing to elicit *through*. Putting the requirement in the
 * schema means every client already supports it, and the model reads the reason
 * at the same moment it reads the tool.
 */
export function withConfirmation(tool: Tool): Tool {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] }

  return {
    ...tool,
    description:
      `${tool.description}\n\n` +
      `This operation cannot be undone. Call it with ${CONFIRM_ARGUMENT}: true only after ` +
      `the person you are acting for has agreed to this specific action.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...schema.properties,
        [CONFIRM_ARGUMENT]: {
          type: 'boolean',
          description:
            'Must be true. Set it only when the person you are acting for has agreed to this ' +
            'specific action — not as a matter of course.',
        },
      },
      required: [...(schema.required ?? []), CONFIRM_ARGUMENT],
    } as Tool['inputSchema'],
  }
}

/**
 * Checks the confirmation argument, returning the message to send back when it
 * is missing.
 *
 * Refusing in the tool result rather than as a protocol error is deliberate:
 * the model sees the refusal, understands what is being asked of it, and can
 * go and ask. A JSON-RPC error would just look like a broken server.
 */
export function checkConfirmation(tool: Tool, args: Record<string, unknown>): string | null {
  if (args[CONFIRM_ARGUMENT] === true) return null

  return (
    `Refused: ${tool.name} makes a change that cannot be undone, and was called without ` +
    `confirmation. Describe to the person you are acting for exactly what this will affect, ` +
    `and call it again with ${CONFIRM_ARGUMENT}: true only if they agree.`
  )
}

/** Applies exposure and confirmation together — what a server actually serves. */
export function policyTools(tools: Tool[], policy: ToolPolicy = {}): Tool[] {
  return applyPolicy(tools, policy).map((tool) => (needsConfirmation(tool, policy) ? withConfirmation(tool) : tool))
}
