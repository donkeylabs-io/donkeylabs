import { AppServer } from "@donkeylabs/server";

const server = new AppServer({
  db: undefined as any,
});

server.start().catch((err) => {
  console.error("Failed to start server", err);
});
