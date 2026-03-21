-- Add PDF overlay template support
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS template_type TEXT DEFAULT 'html';
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS pdf_storage_path TEXT;
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS pdf_page_count INTEGER DEFAULT 0;
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS pdf_field_placements JSONB DEFAULT '[]'::jsonb;
