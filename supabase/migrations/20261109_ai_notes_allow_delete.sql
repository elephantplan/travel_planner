-- 問過啲咩: let the family delete an AI note, the same way trips can be
-- deleted (anyone with the app's anon key). Applied 2026-11-09.
create policy "anyone can delete an ai note" on public.ai_notes
  for delete to anon, authenticated using (true);
