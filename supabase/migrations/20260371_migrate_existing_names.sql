-- Migrate existing name data into first_name/middle_initial/last_name
-- Strategy: split on spaces. 1 word = first only. 2 words = first + last.
-- 3+ words = first + middle initial (2nd word first char) + last (remaining)

UPDATE tenants SET
  first_name = split_part(name, ' ', 1),
  last_name = CASE
    WHEN array_length(string_to_array(name, ' '), 1) >= 3 THEN array_to_string((string_to_array(name, ' '))[3:], ' ')
    WHEN array_length(string_to_array(name, ' '), 1) = 2 THEN split_part(name, ' ', 2)
    ELSE ''
  END,
  middle_initial = CASE
    WHEN array_length(string_to_array(name, ' '), 1) >= 3 THEN left(split_part(name, ' ', 2), 1)
    ELSE ''
  END
WHERE name IS NOT NULL AND first_name = ''
