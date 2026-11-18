ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "cost_cents" integer;