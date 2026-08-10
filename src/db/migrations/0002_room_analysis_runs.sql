CREATE TABLE "room_analysis_runs" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"stage" text NOT NULL,
	"completed_chunks" integer DEFAULT 0 NOT NULL,
	"total_chunks" integer DEFAULT 0 NOT NULL,
	"failure" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_analysis_runs_status_check" CHECK ("room_analysis_runs"."status" in ('pending', 'analyzing', 'finalizing', 'ready', 'failed')),
	CONSTRAINT "room_analysis_runs_stage_check" CHECK ("room_analysis_runs"."stage" in ('chunks', 'hierarchy', 'profiles', 'complete')),
	CONSTRAINT "room_analysis_runs_completed_nonnegative_check" CHECK ("room_analysis_runs"."completed_chunks" >= 0),
	CONSTRAINT "room_analysis_runs_total_nonnegative_check" CHECK ("room_analysis_runs"."total_chunks" >= 0),
	CONSTRAINT "room_analysis_runs_completed_within_total_check" CHECK ("room_analysis_runs"."completed_chunks" <= "room_analysis_runs"."total_chunks"),
	CONSTRAINT "room_analysis_runs_failure_check" CHECK ("room_analysis_runs"."failure" in ('none', 'provider_rejected', 'provider_unavailable', 'model_validation', 'evidence_validation', 'hierarchy_validation', 'database', 'unexpected'))
);
--> statement-breakpoint
ALTER TABLE "room_analysis_runs" ADD CONSTRAINT "room_analysis_runs_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;