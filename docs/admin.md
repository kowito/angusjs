---
title: Admin
section: Interfaces
order: 1
---

# Admin

```ts
import admin from './admin.ts'

admin.register(Post, {
  listDisplay: ['title', 'status', 'publishedAt'],
  listFilter: ['status'],
  searchFields: ['title', 'body'],
})
```

That is the whole setup. The widgets come from the field descriptions: a `choices` field renders a select, a `datetime` renders a datetime input, a foreign key renders a searchable picker, a `boolean` renders a checkbox. There is no adapter layer and no resource definitions to keep in step with the models, because the models already say all of it.

## Options

| Option | What it does |
| --- | --- |
| `listDisplay` | Columns in the list |
| `listFilter` | Fields offered as filters |
| `searchFields` | Fields the search box scans |
| `ordering` | Default sort |
| `readonlyFields` | Shown but not editable |
| `fieldsets` | Grouped form layout |
| `perPage` | List page size |

## Security

The admin fails closed rather than open: with no configured permissions it serves in development and **refuses in production**. An admin that quietly stayed open because nobody configured it is the failure worth designing against.

```ts
admin.configure({ permissions: [isStaff] })
```

Every admin route carries the guard, including the ones that only render.

## Server-rendered

The admin is HTML from the server. No build step, no bundle, no client framework — it works with JavaScript disabled, and it is one fewer thing between a broken production database and the person trying to fix it.
