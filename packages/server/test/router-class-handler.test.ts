
import { describe, it, expect } from "bun:test";
import { createRouter, type ServerContext, defineRoute } from "../src/router";
import { TypedHandler } from "../src/handlers";

class MyHandler {
  constructor(private ctx: ServerContext) {}
  handle(input: { val: string }) {
    return { echo: input.val };
  }
}

describe("Router Class Handlers", () => {
    it("should support passing a Class constructor to handle", async () => {
        const router = createRouter()
            .route("test").typed({
                handle: MyHandler
            });

        const route = router.getRoutes()[0];
        expect(route).toBeDefined();

        // Simulate execution
        const ctx = {};
        const input = { val: "hello" };
        
        // Use the handler function that was wrapped
        // The wrapped function signature is (input, ctx) => ...
        const result = await route.handle(input, ctx as ServerContext);
        
        expect(result).toEqual({ echo: "hello" });
    });
});
