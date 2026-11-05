CREATE TABLE "league_docs" (
	"collection" text,
	"id" text,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "league_docs_pkey" PRIMARY KEY("collection","id")
);
