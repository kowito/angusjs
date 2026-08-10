/**
 * F-expressions — refer to a column's own value inside a write.
 *
 * `update({ views: post.views + 1 })` reads in JavaScript and writes back, so
 * two concurrent requests both read 10 and both write 11: one increment is
 * silently lost. `update({ views: F('views').add(1) })` compiles to
 * `SET views = views + 1`, which the database applies atomically.
 *
 * The framework's job here is to make the correct form the shorter one.
 */

import { sql, type SQL } from 'drizzle-orm'
import type { AnyModel } from './model.ts'

type Operation = { op: '+' | '-' | '*' | '/'; operand: number | FExpression }

export class FExpression {
  constructor(
    readonly field: string,
    private readonly operations: readonly Operation[] = [],
  ) {}

  private chain(op: Operation['op'], operand: number | FExpression): FExpression {
    return new FExpression(this.field, [...this.operations, { op, operand }])
  }

  add(operand: number | FExpression): FExpression {
    return this.chain('+', operand)
  }

  sub(operand: number | FExpression): FExpression {
    return this.chain('-', operand)
  }

  mul(operand: number | FExpression): FExpression {
    return this.chain('*', operand)
  }

  div(operand: number | FExpression): FExpression {
    return this.chain('/', operand)
  }

  /**
   * Compiles to SQL against a model's table. Parenthesised as it goes, so
   * `F('a').add(1).mul(2)` is `((a + 1) * 2)` rather than `a + 1 * 2`.
   */
  toSQL(model: AnyModel, table: Record<string, any>): SQL {
    let expression = sql`${columnOf(model, table, this.field)}`

    for (const { op, operand } of this.operations) {
      const right =
        operand instanceof FExpression
          ? operand.toSQL(model, table)
          : sql`${operand}`
      expression = sql`(${expression} ${sql.raw(op)} ${right})`
    }

    return expression
  }
}

function columnOf(model: AnyModel, table: Record<string, any>, field: string): any {
  const attr = field in model.fields ? field : field.endsWith('Id') ? field.slice(0, -2) : field
  const columnName = model.columns[attr]
  const column = columnName ? table[columnName] : undefined
  if (!column) {
    throw new Error(
      `F("${field}"): "${model.name}" has no field "${field}". ` +
        `Available: ${Object.keys(model.fields).join(', ')}.`,
    )
  }
  return column
}

/**
 * References a column by name, for use in `update()` values and in filter
 * comparisons between two columns.
 *
 * ```ts
 * await Post.objects.filter({ id }).update({ views: F('views').add(1) })
 * await Product.objects.filter({ price__lt: F('cost') })   // sells at a loss
 * ```
 */
export function F(field: string): FExpression {
  return new FExpression(field)
}

export function isFExpression(value: unknown): value is FExpression {
  return value instanceof FExpression
}
