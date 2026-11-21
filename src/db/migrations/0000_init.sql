CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"org_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"post_logout_redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_grants" text[] DEFAULT '{authorization_code}'::text[] NOT NULL,
	"access_ttl_seconds" integer DEFAULT 600 NOT NULL,
	"refresh_ttl_seconds" integer DEFAULT 604800 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "apps_allowed_grants_check" CHECK ("apps"."allowed_grants" <@ ARRAY['password', 'authorization_code']::text[])
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_org_id_pk" PRIMARY KEY("user_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "oidc_store" (
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"grant_id" text,
	"uid" text,
	"user_id" uuid,
	"org_id" uuid,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oidc_store_kind_id_pk" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app_permissions" (
	"app_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	CONSTRAINT "app_permissions_app_id_permission_pk" PRIMARY KEY("app_id","permission")
);
--> statement-breakpoint
CREATE TABLE "member_roles" (
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "member_roles_user_id_org_id_role_id_pk" PRIMARY KEY("user_id","org_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "org_apps" (
	"org_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	CONSTRAINT "org_apps_org_id_app_id_pk" PRIMARY KEY("org_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"username" text,
	"name" text NOT NULL,
	"password_hash" text,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_org_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_permissions" ADD CONSTRAINT "app_permissions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_roles" ADD CONSTRAINT "member_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_apps" ADD CONSTRAINT "org_apps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_apps" ADD CONSTRAINT "org_apps_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_at_idx" ON "activity_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_log_org_at_idx" ON "activity_log" USING btree ("org_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "oidc_store_kind_grant_id_idx" ON "oidc_store" USING btree ("kind","grant_id");--> statement-breakpoint
CREATE INDEX "oidc_store_kind_uid_idx" ON "oidc_store" USING btree ("kind","uid");--> statement-breakpoint
CREATE INDEX "oidc_store_expires_at_idx" ON "oidc_store" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oidc_store_user_id_idx" ON "oidc_store" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oidc_store_org_id_idx" ON "oidc_store" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_idx" ON "users" USING btree (lower("username"));