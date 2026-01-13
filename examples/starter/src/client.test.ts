import { createApiClient } from "$server/client"


const client = createApiClient("http://localhost:3000", {})

client.api.health.ping({}).then(console.log)

