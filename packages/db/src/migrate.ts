import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool } from "./index";

const pool = createPool();
try {
  await migrate(createDb(pool), { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
  console.log("migrations applied");
} finally {
  await pool.end();
}
