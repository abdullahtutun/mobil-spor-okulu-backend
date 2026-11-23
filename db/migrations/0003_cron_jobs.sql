-- migrate:up
-- =============================================================================
-- 0003 — pg_cron işleri (canlıdaki cron.job, bire bir)
-- =============================================================================
-- cron.job satırları dump'a girmez. Canlıda 9 etkin iş var (2026-11-23);
-- INVENTORY.md 6 sekiz sayıyordu:
--   * `expire_trials_job` hiçbir yönetim migration'ında yok — Supabase
--     panelinden elle açılmış. Canlıda çalıştığı için alındı.
--   * migration'lardaki `0 17 * * *` attendance_reminder zamanlaması canlıda
--     yok: 20261002_class_training_schedule.sql işi `*/15 * * * *` ile
--     yeniden kurdu (aynı ad, tek iş).
-- Saatler UTC (imaj cron.timezone = 'UTC'; Supabase'te de UTC):
-- 06:00 UTC = 09:00 TRT.
--
-- cron.schedule(ad, …) aynı adla çağrılınca işi günceller; dosya yeniden
-- çalıştırılabilir. İşleri migration'ı çalıştıran rol (postgres) çalıştırır.
-- =============================================================================

select cron.schedule('athletes_sensitive_data_purge', '35 0 * * *',
  $$select public.purge_deleted_athlete_sensitive_data()$$);

select cron.schedule('expire_trials_job', '0 3 * * *', $$
    UPDATE public.schools 
    SET subscription_status = 'expired' 
    WHERE subscription_status = 'trial' 
      AND trial_ends_at < now();
  $$);

select cron.schedule('notifications_attendance_reminder', '*/15 * * * *',
  $$select public.enqueue_attendance_reminders()$$);

select cron.schedule('notifications_birthday_upcoming', '0 6 * * *',
  $$select public.enqueue_birthday_upcoming_notifications()$$);

select cron.schedule('notifications_morning', '0 6 * * *',
  $$select public.enqueue_morning_notifications()$$);

select cron.schedule('notifications_parent_payments', '0 6 * * *',
  $$select public.enqueue_parent_payment_notifications()$$);

-- Kaçan push dürtmelerini yakalar; bizde request_push_dispatch pg_notify'dır.
select cron.schedule('notifications_push_sweep', '*/5 * * * *',
  $$select public.sweep_push_queue()$$);

select cron.schedule('pre_registrations_retention_purge', '30 0 * * *',
  $$select public.purge_expired_pre_registrations()$$);

select cron.schedule('site_leads_retention_purge', '45 0 * * *',
  $$select public.purge_expired_site_leads()$$);

-- migrate:down
select cron.unschedule(jobname) from cron.job where jobname in (
  'athletes_sensitive_data_purge', 'expire_trials_job',
  'notifications_attendance_reminder', 'notifications_birthday_upcoming',
  'notifications_morning', 'notifications_parent_payments',
  'notifications_push_sweep', 'pre_registrations_retention_purge',
  'site_leads_retention_purge');
