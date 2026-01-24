---
"@donkeylabs/server": minor
"@donkeylabs/cli": minor
"@donkeylabs/adapter-sveltekit": patch
---

Add server-level events with typed emit/on

- Add `defineEvents()` helper for declaring typed events at server level
- Add `EventRegistry` interface for module augmentation
- Update Events interface with typed overloads for emit/on/once
- Generate events.ts with namespace-nested types (Order.Created, User.Signup)
- Fix missing RequestOptions import in SvelteKit adapter client generator
