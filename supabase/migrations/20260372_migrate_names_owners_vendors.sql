UPDATE owners SET
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
