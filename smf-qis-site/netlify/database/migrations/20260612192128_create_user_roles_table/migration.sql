CREATE TABLE "user_roles" (
	"email" text PRIMARY KEY,
	"role" text DEFAULT 'Member' NOT NULL,
	"site" text DEFAULT 'ALL' NOT NULL,
	"assigned_by" text DEFAULT '' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" ("role");