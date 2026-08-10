// api/src/main.ts
// API process entrypoint. Run with: node --loader ts-node/esm api/src/main.ts
// or via the compiled dist/ output in production (see package.json build script).

import { createApp } from "./app.ts";
import { env } from "./env.ts";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(JSON.stringify({ level: "info", msg: "Appealy API listening", port: env.PORT }));
});
