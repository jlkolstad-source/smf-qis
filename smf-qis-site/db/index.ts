// Drizzle client backed by the Netlify Database adapter. The connection is
// configured automatically by the platform — no connection string required.
import { drizzle } from "drizzle-orm/netlify-db";
import * as schema from "./schema.js";

export const db = drizzle({ schema });
