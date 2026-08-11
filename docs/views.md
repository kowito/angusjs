---
title: Views and routing
section: Building
order: 3
---

# Views and routing

A `Router` is a plain data structure. `toElysia()` is the only place it becomes a server, and that single decision is what lets `angus routes` print the URL table, the OpenAPI document be generated rather than scraped, and MCP tools be built — all without booting anything.

## Routes

```ts
const routes = router()

routes.get('/health', () => ({ status: 'ok' }))

routes.post('/posts/:id/publish', async ({ params, user }) => {
  const post = await Post.objects.get({ id: params.id })
  return publish(post, user)
}, {
  params: t.Object({ id: t.Numeric() }),
  permissions: [isAuthenticated],
  summary: 'Publish a post',
})
```

## View sets

```ts
routes.include(
  '/posts',
  modelViewSet({
    model: Post,
    serializer: PostSerializer,
    filterFields: ['status', 'author'],
    searchFields: ['title', 'body'],
    orderingFields: ['publishedAt', 'title'],
    selectRelated: ['author'],
    permissions: [readOnlyOrAuthenticated],
  }),
)
```

Six endpoints: list, create, retrieve, update, partial update, destroy. Each carries its schemas, permissions and metadata, so all of it reaches OpenAPI and MCP.

| Option | What it does |
| --- | --- |
| `queryset` | Base queryset, called per request — scope rows to the caller here |
| `actions` | Which of the six to generate |
| `filterFields` | Fields exposed as `?status=draft&views__gte=10` |
| `searchFields` | Fields scanned by `?search=` |

| `orderingFields` | Fields allowed in `?ordering=-createdAt` |
| `selectRelated` | Foreign keys to join |
| `pagination` | A paginator, or `false` for a bare array |
| `hooks` | `beforeCreate`, `beforeUpdate`, `beforeDestroy` |

Every field named above is checked against the model when the view set is
built. A typo throws immediately — `searchFields names "titel"… Did you mean
"title"?` — rather than silently doing nothing at request time.

## Permissions

A permission is a function of the request context.

```ts
permissions: [isAuthenticated]
actionPermissions: { destroy: [isStaff] }
```

From `angusjs`: `allowAny`, `isAuthenticated`, `isStaff`, `readOnlyOrAuthenticated`, and the combinators `all(...)`, `any(...)`, `not(...)`. These need only `context.user`, so they work whether or not you use the built-in auth system. `isStaff` admits a superuser.

From `angusjs/auth` (when you use the auth models): the above plus `isActive`, `isSuperuser`, `isEmailVerified`, `hasRole(...)`, `hasScope(...)`, `isOwner(...)`.

`either(...)` is a deprecated alias of `any(...)`.

When a permission refuses, the server logs which one, and in `debug` mode the
403 body carries a `deniedBy` field naming the gate — so "why is this 403?" has
an answer without adding print statements. Production never includes it: the
name of the gate is a hint to whoever is probing it.

## Object-level permissions

A permission runs before anything is fetched, so it can only ask about the caller. Some rules are about the row.

```ts
modelViewSet({
  model: Post,
  serializer: PostSerializer,
  permissions: [isAuthenticated],
  objectPermissions: {
    update: (post, ctx) => post.authorId === ctx.user.id,
    destroy: (post, ctx) => post.authorId === ctx.user.id,
  },
})
```

Anyone signed in may read a post; only its author may change it. Neither a permission nor a scoped queryset can say that alone — a queryset hiding other people's posts would hide them from readers too.

Pass one function to apply it to every detail action. Checks may be async, since object rules often depend on something the row does not carry.

> When the *existence* of a row is itself confidential, scope the `queryset` instead. A 403 confirms the row is there; an out-of-scope queryset gives an honest 404.

## Errors

Throw; the edge translates.

```ts
throw new NotFound('No such post.')
throw new PermissionDenied()
throw new ValidationError({ email: ['Already taken.'] })
```

`DoesNotExist` from the ORM becomes 404. A serializer `ValidationError` becomes 400. A constraint violation becomes 409 or 400 — a duplicate or a bad foreign key comes from the submitted data, so it belongs to the caller rather than being reported as a server fault.

A schema validation failure (422) returns per-field messages written for a person: `must be between 0 and 100`, `must be at most 5 characters`, `must be one of: active, archived` — reconstructed from the field's own constraint, not TypeBox's structural wording.

A handler never builds an error body by hand.

## Serializers

```ts
const PostSerializer = serializer(Post, {
  readOnly: ['id', 'createdAt'],
  exclude: ['internalNotes'],
  fields: { author: UserSerializer },   // nested
})
```

The read and write schemas are derived separately from the field descriptions, so a read-only field appears in responses and is rejected in requests without either being written twice. `serializer.read` is the raw TypeBox schema if you need it.
