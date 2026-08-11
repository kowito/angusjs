/**
 * The admin site.
 *
 * Register a model and you get a listing with search, filters, sorting and
 * pagination, plus add/change/delete forms — all derived from the field specs
 * the model already carries.
 */

import { defineApp, type AngusApp } from '../core/app.ts'
import { classifyIntegrityError } from '../db/errors.ts'
import { Q } from '../db/lookups.ts'
import type { AnyModel, FieldMap } from '../db/model.ts'
import { PermissionDenied } from '../http/errors.ts'
import { Router, type Context, type Permission } from '../routing/router.ts'
import { esc, html, layout, page, raw, seeOther, type Crumb, type Html } from './render.ts'
import { displayValue, isEditable, parseValue, rowLabel, widget, type RelationChoice } from './widgets.ts'

export interface ModelAdminOptions {
  /** Columns in the listing. Defaults to the first handful of fields. */
  listDisplay?: string[]
  /** Fields offered as sidebar filters. Choices, booleans and relations work. */
  listFilter?: string[]
  /** Fields scanned by the search box. */
  searchFields?: string[]
  /** Default ordering for the listing. Falls back to the model's own. */
  ordering?: string[]
  /** Fields shown in the form but not editable. */
  readonlyFields?: string[]
  /** Restricts the form to these fields, in this order. */
  fields?: string[]
  exclude?: string[]
  listPerPage?: number
  /** Heading the model appears under on the index. */
  group?: string
  /** Which field labels a row. Guessed from `name`/`title`/`slug` otherwise. */
  displayField?: string
  /** Set false to make the model read-only in the admin. */
  canAdd?: boolean
  canChange?: boolean
  canDelete?: boolean
}

interface Registration extends ModelAdminOptions {
  model: AnyModel
  slug: string
}

export interface AdminSiteOptions {
  title?: string
  /** Where the admin is mounted, relative to its app prefix. */
  path?: string
  /**
   * Who may use the admin. When omitted, the admin refuses every request — see
   * `guard` below — unless `insecureAllowUnauthenticated` is set.
   */
  permissions?: Permission[]
  /**
   * Serve the admin with **no authentication at all** when `permissions` is
   * omitted. Every model becomes anonymously readable, writable and deletable.
   *
   * This exists only so a freshly scaffolded project is explorable before an
   * auth system is wired up. It is never safe in production, prints a warning
   * on every startup, and is flagged by `angus check --deploy`. The default is
   * to refuse rather than to guess from `NODE_ENV`, because "the environment
   * variable was not set to production" is not evidence that exposing every
   * row is safe.
   */
  insecureAllowUnauthenticated?: boolean
}

/** Rows fetched to populate a relation dropdown. Beyond this, the select is unusable anyway. */
const RELATION_CHOICE_LIMIT = 500

export class AdminSite {
  private readonly registrations = new Map<string, Registration>()
  readonly title: string
  readonly path: string
  private readonly permissions: Permission[] | undefined
  private readonly insecureOpen: boolean

  constructor(options: AdminSiteOptions = {}) {
    this.title = options.title ?? 'Admin'
    this.path = options.path ?? '/admin'
    this.permissions = options.permissions
    this.insecureOpen = options.insecureAllowUnauthenticated === true

    if (this.insecureOpen && (!this.permissions || this.permissions.length === 0)) {
      // Loud, every startup: an open admin is the sort of thing that ships by
      // accident, and a warning is the last line of defence before it does.
      console.warn(
        '[angus] SECURITY: the admin is serving without authentication ' +
          '(insecureAllowUnauthenticated). Every model is anonymously readable and ' +
          'writable. Configure `permissions` before deploying anywhere public.',
      )
    }
  }

  /** Registers a model, Django's `admin.site.register`. */
  register(model: AnyModel, options: ModelAdminOptions = {}): this {
    const slug = model.name.toLowerCase()
    if (this.registrations.has(slug)) {
      throw new Error(`Model "${model.name}" is already registered with this admin site.`)
    }
    this.registrations.set(slug, { ...options, model, slug })
    return this
  }

  /** Registers several models with shared options. */
  registerAll(models: AnyModel[], options: ModelAdminOptions = {}): this {
    for (const model of models) this.register(model, options)
    return this
  }

  /**
   * Wraps the site as an installable app. It mounts at its own path rather
   * than under the project's API prefix — the admin is a UI, not an endpoint.
   */
  app(name = 'admin'): AngusApp {
    return defineApp({
      name,
      prefix: this.path,
      absolutePrefix: true,
      urls: this.router(),
      // Declared, because every admin route carries the built-in fail-closed
      // guard: an inspector counting permissions cannot tell a configured
      // check from that default.
      meta: { admin: true, guarded: (this.permissions?.length ?? 0) > 0 },
    })
  }

  // -------------------------------------------------------------------------
  // Access control
  // -------------------------------------------------------------------------

  /**
   * The admin exposes every row of every registered model, so it fails closed
   * in every environment. It serves only when `permissions` are configured, or
   * when `insecureAllowUnauthenticated` is explicitly set for local
   * exploration. It deliberately does not decide from `NODE_ENV`: an unset or
   * misspelled variable on a public deploy would otherwise leave every model
   * anonymously writable, which is exactly the accident this guards against.
   */
  private guard(): Permission {
    if (this.permissions && this.permissions.length > 0) {
      const configured = this.permissions
      return async (context) => {
        for (const permission of configured) if (!(await permission(context))) return false
        return true
      }
    }

    if (this.insecureOpen) return () => true

    return () => {
      throw new PermissionDenied(
        'The admin has no `permissions` configured, so it refuses to serve. Pass ' +
          'adminSite({ permissions: [isStaff] }) to protect it, or ' +
          'adminSite({ insecureAllowUnauthenticated: true }) to open it without auth for local use.',
      )
    }
  }

  /**
   * Rejects cross-site form posts. Without this, a logged-in admin visiting a
   * hostile page could be made to submit these forms.
   */
  private static assertSameOrigin(context: Context): void {
    const request = context.request as Request
    const site = request.headers.get('sec-fetch-site')
    if (site && site !== 'same-origin' && site !== 'none') {
      throw new PermissionDenied('Cross-site requests to the admin are not allowed.')
    }
    const origin = request.headers.get('origin')
    if (origin && new URL(origin).host !== new URL(request.url).host) {
      throw new PermissionDenied('Cross-origin requests to the admin are not allowed.')
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private find(slug: string): Registration | undefined {
    return this.registrations.get(slug.toLowerCase())
  }

  /** Absolute URL base, derived from the request so mount points stay flexible. */
  private base(context: Context): string {
    const path = new URL((context.request as Request).url).pathname
    const marker = path.indexOf(this.path)
    return marker === -1 ? this.path : path.slice(0, marker + this.path.length)
  }

  private columns(registration: Registration): string[] {
    if (registration.listDisplay) return registration.listDisplay
    const fields = registration.model.fields as FieldMap
    // The pk plus the first few readable columns — enough to identify a row.
    return Object.keys(fields).slice(0, 6)
  }

  private formFields(registration: Registration): string[] {
    const fields = registration.model.fields as FieldMap
    const excluded = new Set(registration.exclude ?? [])
    const chosen = registration.fields ?? Object.keys(fields)
    return chosen.filter((attr) => fields[attr] && !excluded.has(attr) && isEditable(fields[attr]!.spec))
  }

  private async relationChoices(model: AnyModel, attr: string): Promise<RelationChoice[]> {
    const target = (model.fields as FieldMap)[attr]!.spec.to!()
    const rows = (await target.objects.all().limit(RELATION_CHOICE_LIMIT)) as Record<string, unknown>[]
    return rows.map((row) => ({
      value: row[target.pk] as number,
      label: rowLabel(target, row),
    }))
  }

  private render(context: Context, title: string, crumbs: Crumb[], body: Html, status = 200): Response {
    const user = context.user as { name?: string; email?: string; username?: string } | undefined
    return page(
      layout({
        title,
        siteTitle: this.title,
        root: this.base(context),
        crumbs,
        user: user ? (user.name ?? user.username ?? user.email ?? 'signed in') : null,
        body,
      }),
      status,
    )
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  router(): Router {
    const routes = new Router()
    routes.permissions(this.guard())

    // These serve HTML for humans, so they are kept out of the OpenAPI
    // document and out of the MCP tool list.
    const hidden = { hidden: true }

    routes.get('/', (context) => this.index(context), hidden)
    routes.get('/:model', (context) => this.changelist(context), hidden)
    routes.get('/:model/add', (context) => this.addForm(context), hidden)
    routes.post('/:model/add', (context) => this.create(context), hidden)
    routes.get('/:model/:pk', (context) => this.changeForm(context), hidden)
    routes.post('/:model/:pk', (context) => this.update(context), hidden)
    routes.get('/:model/:pk/delete', (context) => this.confirmDelete(context), hidden)
    routes.post('/:model/:pk/delete', (context) => this.destroy(context), hidden)

    return routes
  }

  private notFound(context: Context, message: string): Response {
    return this.render(
      context,
      'Not found',
      [{ label: 'Not found' }],
      html`<div class="alert error">${message}</div>`,
      404,
    )
  }

  // --- index ---------------------------------------------------------------

  private async index(context: Context): Promise<Response> {
    const base = this.base(context)
    const groups = new Map<string, Registration[]>()

    for (const registration of this.registrations.values()) {
      const group = registration.group ?? 'Models'
      groups.set(group, [...(groups.get(group) ?? []), registration])
    }

    // One count per model — cheap, and it makes the index worth looking at.
    const counts = new Map<string, number>()
    for (const registration of this.registrations.values()) {
      counts.set(registration.slug, await registration.model.objects.count())
    }

    const body =
      this.registrations.size === 0
        ? html`<div class="card"><div class="empty">
            No models registered. Call <code>admin.register(Model)</code> to add one.
          </div></div>`
        : html`${[...groups].map(
            ([group, items]) => html`<div class="card">
              <h2>${group}</h2>
              <div class="grid">
                ${items.map(
                  (registration) => html`<a class="model" href="${base}/${registration.slug}">
                    <strong>${registration.model.meta.verboseNamePlural}</strong>
                    <span>${counts.get(registration.slug) ?? 0} row${
                      counts.get(registration.slug) === 1 ? '' : 's'
                    } · ${registration.model.meta.tableName}</span>
                  </a>`,
                )}
              </div>
            </div>`,
          )}`

    return this.render(context, 'Home', [], html`<h1>${this.title}</h1>
      <p class="sub">Site administration</p>
      ${body}`)
  }

  // --- changelist ----------------------------------------------------------

  private async changelist(context: Context): Promise<Response> {
    const registration = this.find(context.params.model)
    if (!registration) return this.notFound(context, `No model registered as "${esc(context.params.model)}".`)

    const { model } = registration
    const base = this.base(context)
    const query = (context.query ?? {}) as Record<string, string | undefined>
    const fields = model.fields as FieldMap

    let queryset = model.objects.all()

    // Search.
    const search = query.q?.trim() ?? ''
    const searchFields = registration.searchFields ?? []
    if (search !== '' && searchFields.length > 0) {
      queryset = queryset.filter(
        Q.or(...searchFields.map((attr) => ({ [`${attr}__icontains`]: search }) as never)) as never,
      )
    }

    // Sidebar filters. Values arrive as strings and are coerced by kind.
    const activeFilters: Record<string, string> = {}
    for (const attr of registration.listFilter ?? []) {
      const value = query[`f_${attr}`]
      if (value === undefined || value === '') continue
      const spec = fields[attr]?.spec
      if (!spec) continue
      activeFilters[attr] = value
      const coerced =
        spec.kind === 'boolean'
          ? value === 'true'
          : ['integer', 'smallInteger', 'bigInteger', 'foreignKey'].includes(spec.kind)
            ? Number(value)
            : value
      queryset = queryset.filter({ [attr]: coerced } as never)
    }

    // Sorting.
    const sort = query.o ?? ''
    const sortAttr = sort.startsWith('-') ? sort.slice(1) : sort
    if (sort !== '' && fields[sortAttr]) {
      queryset = queryset.orderBy(sort as never)
    } else if (registration.ordering?.length) {
      queryset = queryset.orderBy(...(registration.ordering as never[]))
    }

    // Pagination.
    const perPage = registration.listPerPage ?? 50
    const pageNumber = Math.max(1, Number(query.p ?? 1) || 1)
    const total = await queryset.count()
    const lastPage = Math.max(1, Math.ceil(total / perPage))
    const rows = (await queryset.limit(perPage).offset((pageNumber - 1) * perPage)) as Record<string, unknown>[]

    const columns = this.columns(registration)

    // Foreign key columns are shown as labels, so the targets are fetched in
    // one query per relation rather than one per row.
    const relationLabels = new Map<string, Map<unknown, string>>()
    for (const attr of columns) {
      if (fields[attr]?.spec.kind !== 'foreignKey') continue
      const target = fields[attr]!.spec.to!()
      const ids = [...new Set(rows.map((row) => row[`${attr}Id`]).filter((id) => id !== null && id !== undefined))]
      if (ids.length === 0) continue
      const related = (await target.objects.filter({ [target.pk]: ids } as never)) as Record<string, unknown>[]
      relationLabels.set(attr, new Map(related.map((row) => [row[target.pk], rowLabel(target, row)])))
    }

    const keep = (overrides: Record<string, string | undefined>) => {
      const params = new URLSearchParams()
      if (search) params.set('q', search)
      for (const [attr, value] of Object.entries(activeFilters)) params.set(`f_${attr}`, value)
      if (sort) params.set('o', sort)
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) params.delete(key)
        else params.set(key, value)
      }
      const encoded = params.toString()
      return `${base}/${registration.slug}${encoded ? `?${encoded}` : ''}`
    }

    const header = columns.map((attr) => {
      const spec = fields[attr]?.spec
      const label = spec?.verboseName ?? attr
      if (!spec) return html`<th>${label}</th>`
      const next = sort === attr ? `-${attr}` : attr
      const marker = sort === attr ? ' ↑' : sort === `-${attr}` ? ' ↓' : ''
      return html`<th><a class="${sortAttr === attr ? 'sorted' : ''}" href="${keep({ o: next, p: undefined })}">${label}${marker}</a></th>`
    })

    const body = rows.map((row) => {
      const pk = row[model.pk]
      return html`<tr>
        ${columns.map((attr, index) => {
          const spec = fields[attr]?.spec
          const cell = !spec
            ? html`<span class="null">—</span>`
            : spec.kind === 'foreignKey'
              ? html`${relationLabels.get(attr)?.get(row[`${attr}Id`]) ?? row[`${attr}Id`] ?? '—'}`
              : displayValue(spec, row[attr])
          // The first column links to the change form, as Django does.
          return index === 0
            ? html`<td><a href="${base}/${registration.slug}/${String(pk)}">${cell}</a></td>`
            : html`<td>${cell}</td>`
        })}
      </tr>`
    })

    const filterPanel =
      (registration.listFilter ?? []).length === 0
        ? raw('')
        : html`<div class="card filters"><h2>Filter</h2><div style="padding:12px 16px">
            ${await Promise.all(
              (registration.listFilter ?? []).map(async (attr) => {
                const spec = fields[attr]?.spec
                if (!spec) return raw('')
                let options: { value: string; label: string }[] = []
                if (spec.kind === 'boolean') {
                  options = [
                    { value: 'true', label: 'Yes' },
                    { value: 'false', label: 'No' },
                  ]
                } else if (spec.choices?.length) {
                  options = spec.choices.map((choice) => ({ value: String(choice), label: String(choice) }))
                } else if (spec.kind === 'foreignKey') {
                  options = (await this.relationChoices(model, attr)).map((choice) => ({
                    value: String(choice.value),
                    label: choice.label,
                  }))
                } else {
                  return raw('')
                }
                const current = activeFilters[attr]
                return html`<div class="group">
                  <div>${spec.verboseName ?? attr}</div>
                  <a class="${current === undefined ? 'active' : ''}" href="${keep({ [`f_${attr}`]: undefined, p: undefined })}">All</a>
                  ${options.map(
                    (option) =>
                      html`<a class="${current === option.value ? 'active' : ''}" href="${keep({
                        [`f_${attr}`]: option.value,
                        p: undefined,
                      })}">${option.label}</a>`,
                  )}
                </div>`
              }),
            )}
          </div></div>`

    const listing = html`<div class="card">
      <div class="toolbar">
        ${
          searchFields.length > 0
            ? html`<form method="get">
                ${Object.entries(activeFilters).map(
                  ([attr, value]) => html`<input type="hidden" name="f_${attr}" value="${value}">`,
                )}
                ${sort ? html`<input type="hidden" name="o" value="${sort}">` : ''}
                <input type="search" name="q" value="${search}" placeholder="Search ${
                  searchFields.join(', ')
                }" aria-label="Search">
                <button type="submit">Search</button>
                ${search ? html`<a class="btn" href="${keep({ q: undefined, p: undefined })}">Clear</a>` : ''}
              </form>`
            : html`<div class="spacer"></div>`
        }
        ${
          registration.canAdd === false
            ? ''
            : html`<a class="btn btn-primary" href="${base}/${registration.slug}/add">Add ${
                model.meta.verboseName
              }</a>`
        }
      </div>
      ${
        rows.length === 0
          ? html`<div class="empty">Nothing to show${search ? html` for “${search}”` : ''}.</div>`
          : html`<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`
      }
      <div class="pager">
        <div>${total} row${total === 1 ? '' : 's'}${
          lastPage > 1 ? html` · page ${pageNumber} of ${lastPage}` : ''
        }</div>
        <div class="spacer"></div>
        ${pageNumber > 1 ? html`<a href="${keep({ p: String(pageNumber - 1) })}">← Previous</a>` : ''}
        ${pageNumber < lastPage ? html`<a href="${keep({ p: String(pageNumber + 1) })}">Next →</a>` : ''}
      </div>
    </div>`

    return this.render(
      context,
      model.meta.verboseNamePlural,
      [{ label: model.meta.verboseNamePlural }],
      html`<h1>${model.meta.verboseNamePlural}</h1>
        <p class="sub">${model.meta.tableName}</p>
        <div class="layout ${filterPanel.value === '' ? '' : 'with-filters'}">
          ${listing}${filterPanel}
        </div>`,
    )
  }

  // --- forms ---------------------------------------------------------------

  private async renderForm(
    context: Context,
    registration: Registration,
    options: {
      values: Record<string, unknown>
      errors?: Record<string, string>
      formError?: string
      pk?: unknown
    },
  ): Promise<Response> {
    const { model } = registration
    const base = this.base(context)
    const fields = model.fields as FieldMap
    const readonly = new Set(registration.readonlyFields ?? [])
    const editable = this.formFields(registration)
    const isAdd = options.pk === undefined

    const choices = new Map<string, RelationChoice[]>()
    for (const attr of editable) {
      if (fields[attr]!.spec.kind === 'foreignKey') {
        choices.set(attr, await this.relationChoices(model, attr))
      }
    }

    // Non-editable fields are still worth showing on a change form.
    const shown = isAdd ? editable : Object.keys(fields).filter((attr) => editable.includes(attr) || !isAdd)

    const body = html`<h1>${isAdd ? `Add ${model.meta.verboseName}` : `Change ${model.meta.verboseName}`}</h1>
      <p class="sub">${isAdd ? model.meta.tableName : `${model.meta.tableName} · #${String(options.pk)}`}</p>
      ${options.formError ? html`<div class="alert error">${options.formError}</div>` : ''}
      <form method="post" class="card">
        ${shown.map((attr) => {
          const spec = fields[attr]!.spec
          const error = options.errors?.[attr]
          const writable = editable.includes(attr) && !readonly.has(attr)
          const label = spec.verboseName ?? attr
          const required = writable && !spec.null && !spec.blank && !spec.hasDefault

          return html`<div class="field ${error ? 'invalid' : ''}">
            <label class="${required ? 'required' : ''}" for="id_${attr}">${label}</label>
            ${
              writable
                ? widget({ name: attr, spec, value: options.values[attr], choices: choices.get(attr) })
                : html`<div class="readonly">${
                    spec.kind === 'foreignKey'
                      ? String(options.values[`${attr}Id`] ?? options.values[attr] ?? '—')
                      : displayValue(spec, options.values[attr])
                  }</div>`
            }
            ${spec.helpText ? html`<div class="help">${spec.helpText}</div>` : ''}
            ${error ? html`<div class="err">${error}</div>` : ''}
          </div>`
        })}
        <div class="actions">
          <button type="submit" class="primary">Save</button>
          <a class="btn" href="${base}/${registration.slug}">Cancel</a>
          <div class="spacer"></div>
          ${
            !isAdd && registration.canDelete !== false
              ? html`<a class="btn" href="${base}/${registration.slug}/${String(options.pk)}/delete">Delete</a>`
              : ''
          }
        </div>
      </form>`

    return this.render(
      context,
      isAdd ? `Add ${model.meta.verboseName}` : `Change ${model.meta.verboseName}`,
      [
        { label: model.meta.verboseNamePlural, href: `${base}/${registration.slug}` },
        { label: isAdd ? 'Add' : String(options.pk) },
      ],
      body,
    )
  }

  private async addForm(context: Context): Promise<Response> {
    const registration = this.find(context.params.model)
    if (!registration) return this.notFound(context, `No model registered as "${esc(context.params.model)}".`)
    if (registration.canAdd === false) throw new PermissionDenied('This model is read-only in the admin.')

    // Seed the form with each field's default.
    const values: Record<string, unknown> = {}
    for (const [attr, field] of Object.entries(registration.model.fields as FieldMap)) {
      const spec = field.spec
      if (spec.hasDefault && typeof spec.default !== 'function') values[attr] = spec.default
    }

    return this.renderForm(context, registration, { values })
  }

  private async changeForm(context: Context): Promise<Response> {
    const registration = this.find(context.params.model)
    if (!registration) return this.notFound(context, `No model registered as "${esc(context.params.model)}".`)

    const row = await this.fetchRow(registration, context.params.pk)
    if (!row) return this.notFound(context, `No ${registration.model.name} with primary key ${esc(context.params.pk)}.`)

    return this.renderForm(context, registration, { values: row, pk: row[registration.model.pk] })
  }

  private async fetchRow(
    registration: Registration,
    rawPk: string,
  ): Promise<Record<string, unknown> | null> {
    const spec = (registration.model.fields as FieldMap)[registration.model.pk]!.spec
    const numeric = ['auto', 'bigAuto', 'integer', 'bigInteger', 'smallInteger'].includes(spec.kind)
    const pk = numeric ? Number(rawPk) : rawPk
    if (numeric && !Number.isInteger(pk as number)) return null

    return (await registration.model.objects.getOrNull({ [registration.model.pk]: pk } as never)) as Record<
      string,
      unknown
    > | null
  }

  /**
   * Elysia parses the request body before the handler runs, so the form is read
   * from `context.body`. `request.formData()` would throw "body already used".
   */
  private static async formValues(context: Context): Promise<Record<string, string | undefined>> {
    const values: Record<string, string | undefined> = {}
    const body = context.body

    if (body && typeof body === 'object') {
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === undefined || value === null) continue
        // A repeated field arrives as an array; the last one wins.
        values[key] = Array.isArray(value) ? String(value[value.length - 1]) : String(value)
      }
      return values
    }

    const form = await (context.request as Request).formData()
    for (const [key, value] of form.entries()) {
      values[key] = typeof value === 'string' ? value : ''
    }
    return values
  }

  /** Reads a submitted form into model values, collecting per-field errors. */
  private async readForm(
    context: Context,
    registration: Registration,
  ): Promise<{ values: Record<string, unknown>; errors: Record<string, string>; submitted: Record<string, unknown> }> {
    const form = await AdminSite.formValues(context)
    const fields = registration.model.fields as FieldMap
    const readonly = new Set(registration.readonlyFields ?? [])

    const values: Record<string, unknown> = {}
    const errors: Record<string, string> = {}
    const submitted: Record<string, unknown> = {}

    for (const attr of this.formFields(registration)) {
      if (readonly.has(attr)) continue
      const spec = fields[attr]!.spec
      const raw = form[attr]

      submitted[attr] = spec.kind === 'boolean' ? raw === 'true' || raw === 'on' : (raw ?? '')
      const parsed = parseValue(spec, raw)
      if (!parsed.ok) {
        errors[attr] = parsed.error
        continue
      }
      if (parsed.value !== undefined) values[attr] = parsed.value
    }

    return { values, errors, submitted }
  }

  private async create(context: Context): Promise<Response> {
    AdminSite.assertSameOrigin(context)
    const registration = this.find(context.params.model)
    if (!registration) return this.notFound(context, `No model registered as "${esc(context.params.model)}".`)
    if (registration.canAdd === false) throw new PermissionDenied('This model is read-only in the admin.')

    const { values, errors, submitted } = await this.readForm(context, registration)
    if (Object.keys(errors).length > 0) {
      return this.renderForm(context, registration, { values: submitted, errors })
    }

    try {
      const row = (await registration.model.objects.create(values as never)) as Record<string, unknown>
      return seeOther(`${this.base(context)}/${registration.slug}/${String(row[registration.model.pk])}`)
    } catch (error) {
      return this.renderForm(context, registration, {
        values: submitted,
        formError: describeWriteError(error),
      })
    }
  }

  private async update(context: Context): Promise<Response> {
    AdminSite.assertSameOrigin(context)
    const registration = this.find(context.params.model)
    if (!registration) return this.notFound(context, `No model registered as "${esc(context.params.model)}".`)
    if (registration.canChange === false) throw new PermissionDenied('This model is read-only in the admin.')

    const existing = await this.fetchRow(registration, context.params.pk)
    if (!existing) return this.notFound(context, `No ${registration.model.name} with primary key ${esc(context.params.pk)}.`)

    const pk = existing[registration.model.pk]
    const { values, errors, submitted } = await this.readForm(context, registration)
    if (Object.keys(errors).length > 0) {
      return this.renderForm(context, registration, { values: { ...existing, ...submitted }, errors, pk })
    }

    try {
      await registration.model.objects.filter({ [registration.model.pk]: pk } as never).update(values as never)
      return seeOther(`${this.base(context)}/${registration.slug}/${String(pk)}`)
    } catch (error) {
      return this.renderForm(context, registration, {
        values: { ...existing, ...submitted },
        formError: describeWriteError(error),
        pk,
      })
    }
  }

  // --- delete --------------------------------------------------------------

  private async confirmDelete(context: Context): Promise<Response> {
    const registration = this.find(context.params.model)
    if (!registration) return this.notFound(context, `No model registered as "${esc(context.params.model)}".`)

    const row = await this.fetchRow(registration, context.params.pk)
    if (!row) return this.notFound(context, `No ${registration.model.name} with primary key ${esc(context.params.pk)}.`)

    const base = this.base(context)
    const label = rowLabel(registration.model, row, registration.displayField)

    return this.render(
      context,
      'Delete',
      [
        { label: registration.model.meta.verboseNamePlural, href: `${base}/${registration.slug}` },
        { label: String(row[registration.model.pk]), href: `${base}/${registration.slug}/${String(row[registration.model.pk])}` },
        { label: 'Delete' },
      ],
      html`<h1>Delete ${registration.model.meta.verboseName}?</h1>
        <div class="alert error">
          <strong>${label}</strong> will be permanently removed. Rows referencing it may be deleted too,
          depending on each relation's <code>onDelete</code>.
        </div>
        <form method="post" class="card">
          <div class="actions">
            <button type="submit" class="danger">Yes, delete</button>
            <a class="btn" href="${base}/${registration.slug}/${String(row[registration.model.pk])}">Cancel</a>
          </div>
        </form>`,
    )
  }

  private async destroy(context: Context): Promise<Response> {
    AdminSite.assertSameOrigin(context)
    const registration = this.find(context.params.model)
    if (!registration) return this.notFound(context, `No model registered as "${esc(context.params.model)}".`)
    if (registration.canDelete === false) throw new PermissionDenied('Deleting is disabled for this model.')

    const row = await this.fetchRow(registration, context.params.pk)
    if (!row) return this.notFound(context, `No ${registration.model.name} with primary key ${esc(context.params.pk)}.`)

    await registration.model.objects
      .filter({ [registration.model.pk]: row[registration.model.pk] } as never)
      .delete()

    return seeOther(`${this.base(context)}/${registration.slug}`)
  }
}

/**
 * Turns a driver error into something an admin user can act on, using the same
 * classifier the API error contract uses so the two cannot drift apart.
 */
function describeWriteError(error: unknown): string {
  switch (classifyIntegrityError(error)) {
    case 'unique':
      return 'That value must be unique, and another row already uses it.'
    case 'foreign-key':
      return 'That related row does not exist.'
    case 'not-null':
      return 'A required field was left empty.'
    case 'check':
      return 'That value is not allowed.'
    default:
      return error instanceof Error ? error.message : String(error)
  }
}

export function adminSite(options?: AdminSiteOptions): AdminSite {
  return new AdminSite(options)
}
