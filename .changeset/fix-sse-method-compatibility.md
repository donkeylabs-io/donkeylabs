---
"@donkeylabs/adapter-sveltekit": patch
---

Fix SSE method compatibility with @donkeylabs/server generated clients

- Add `connectToSSERoute` method to `UnifiedApiClientBase` as alias for `sseConnect`
- Add `SSEOptions` interface for compatibility with server's SSE options
- Add `once()` and `off()` methods to `SSEConnection` for full `SSESubscription` interface compatibility

This fixes a bug where generated API clients using `AppServer.generateClientCode()` would fail at runtime because they called `this.connectToSSERoute()` which didn't exist on the adapter's base class.
