// Local runner: `npm run dev`. On Vercel the default export of src/index.ts is used instead.
import { serve } from "@hono/node-server";
import app from "./index";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`seller listening on http://localhost:${port}`));
