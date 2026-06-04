CREATE INDEX "audit_log_changed_at_idx" ON "audit_log" ("changed_at");--> statement-breakpoint
CREATE INDEX "audit_sessions_status_idx" ON "audit_sessions" ("status");--> statement-breakpoint
CREATE INDEX "audit_sessions_scheduled_date_idx" ON "audit_sessions" ("scheduled_date");--> statement-breakpoint
CREATE INDEX "capa_links_capa_source_type_idx" ON "capa_links" ("capa_id","source_type");--> statement-breakpoint
CREATE INDEX "crisis_exercises_status_idx" ON "crisis_exercises" ("status");--> statement-breakpoint
CREATE INDEX "effectiveness_checks_status_idx" ON "effectiveness_checks" ("status");--> statement-breakpoint
CREATE INDEX "oos_records_status_idx" ON "oos_records" ("status");--> statement-breakpoint
CREATE INDEX "oos_records_site_status_idx" ON "oos_records" ("site","status");--> statement-breakpoint
CREATE INDEX "oos_records_created_at_idx" ON "oos_records" ("created_at");--> statement-breakpoint
CREATE INDEX "records_type_idx" ON "records" ("type");--> statement-breakpoint
CREATE INDEX "records_status_idx" ON "records" ("status");--> statement-breakpoint
CREATE INDEX "records_site_type_idx" ON "records" ("site","type");--> statement-breakpoint
CREATE INDEX "records_site_status_idx" ON "records" ("site","status");--> statement-breakpoint
CREATE INDEX "records_site_type_status_idx" ON "records" ("site","type","status");--> statement-breakpoint
CREATE INDEX "records_created_at_idx" ON "records" ("created_at");--> statement-breakpoint
CREATE INDEX "records_due_date_idx" ON "records" ("due_date");--> statement-breakpoint
CREATE INDEX "records_capa_id_idx" ON "records" ("capa_id");