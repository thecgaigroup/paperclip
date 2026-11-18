ALTER TABLE "heartbeat_runs" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "cost_usd" integer;