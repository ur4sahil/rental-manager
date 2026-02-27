import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://hoymytpyaudjvsgiiibn.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhveW15dHB5YXVkanZzZ2lpaWJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNjM1OTUsImV4cCI6MjA4NzczOTU5NX0.aYe9lSvYoTunuo4OAo5SQ9qdiTTNijZrovhCvyDyu7c'

export const supabase = createClient(supabaseUrl, supabaseKey)
