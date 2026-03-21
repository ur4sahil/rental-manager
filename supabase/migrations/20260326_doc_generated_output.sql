-- Add output_type and pdf_output_path to generated docs
ALTER TABLE doc_generated ADD COLUMN IF NOT EXISTS output_type TEXT DEFAULT 'html';
ALTER TABLE doc_generated ADD COLUMN IF NOT EXISTS pdf_output_path TEXT;
