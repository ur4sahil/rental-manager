-- Add field_config for advanced field features (calculated, conditional, address blocks)
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS field_config JSONB DEFAULT '{}'::jsonb;
