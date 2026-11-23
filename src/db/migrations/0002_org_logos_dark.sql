CREATE TABLE "org_logos_dark" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"content" "bytea" NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"etag" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "org_logos_dark" ADD CONSTRAINT "org_logos_dark_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_logos_dark" ADD CONSTRAINT "org_logos_dark_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;