import { pgTable, text, jsonb, integer, bigint, primaryKey } from "drizzle-orm/pg-core";

// Generic document store used by the league app (collection + document id → JSON data).
export const leagueDocs = pgTable(
  "league_docs",
  {
    collection: text().notNull(),
    id: text().notNull(),
    data: jsonb().notNull(),
    version: integer().notNull().default(1),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.id] })]
);
