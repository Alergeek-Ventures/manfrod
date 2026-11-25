ALTER TABLE self_modify_pulls
  ADD COLUMN origin_channel_id text,
  ADD COLUMN origin_thread_ts text;
