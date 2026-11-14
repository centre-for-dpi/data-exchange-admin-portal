-- Drafts (requested) no longer claim slug or tax id: only submitted, active, suspended or
-- offboarded entities do (security review of M2-01: squatting through never-submitted drafts).

-- DropIndex
DROP INDEX "entity_slug_live";

-- DropIndex
DROP INDEX "entity_tax_id_live";

-- CreateIndex
CREATE UNIQUE INDEX "entity_slug_live" ON "entity"("slug") WHERE (status <> ALL (ARRAY['requested'::entity_status, 'rejected'::entity_status]));

-- CreateIndex
CREATE UNIQUE INDEX "entity_tax_id_live" ON "entity"("tax_id_type", "tax_id") WHERE (status <> ALL (ARRAY['requested'::entity_status, 'rejected'::entity_status]));

