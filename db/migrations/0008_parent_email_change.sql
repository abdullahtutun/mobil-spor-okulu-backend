-- migrate:up
-- Yönetim reposundan taşındı (imported from 20261123_parent_email_change):
--   ../mobil_spor_okulu/supabase/migrations/20261123_parent_email_change.sql
-- İçerik aynı; yalnızca üst düzey begin/commit atıldı (dbmate transaction'ı).
-- =============================================================================
-- Veli e-posta değişikliği — aynı hesap, yeni adres, yeni davet
-- =============================================================================
-- `update-parent` Edge Function'ı velinin e-postası değişince ESKİ auth
-- hesabını siliyor, yeni adrese yeni bir hesap açıyordu. Bu hiç çalışmadı:
-- `auth.users` → `profiles` ON DELETE CASCADE, ama `profile_branch_links` ve
-- `parent_athlete_links` `profiles`'a NO ACTION ile bağlı. Bağı olan her
-- velide (yani hepsinde) silme "Database error deleting user" ile düşüyor,
-- geri alma da yeni hesabın bağları yüzünden düşüyordu: yeni adrese davet
-- gitmiş, yeni hesap bağlarıyla kalmış, eski hesap da duruyordu.
--
-- Yeni yol: AYNI auth hesabının e-postası değişir. Profil kimliği, şube ve
-- sporcu bağları, bildirimler, geçmiş yerinde kalır. Hesap davetli hâle
-- döner (onaysız, şifresiz, oturumsuz) ve Edge Function GoTrue'nun
-- `inviteUserByEmail`'ını çağırır: GoTrue onaysız var olan kullanıcıya
-- daveti yeniden gönderir (send-email hook'u, `invite` türü, okulun markasının
-- şifre oluşturma sayfası — `lib/main_set_password.dart` yalnızca `type=invite`
-- kabul ediyor, değişmesi gerekmedi). Onaylı hesaba davet `email_exists` ile
-- reddedildiği ve admin API'si bir hesabı onaysız yapamadığı için (GoTrue
-- `adminUserUpdate`'te `email_confirm: false` etkisiz) bu adım SQL'de.
--
-- Neden şifre de silinir: eski adresin sahibi artık bu hesaba giremez
-- olmalı; yeni adresin sahibi kendi şifresini davet bağlantısıyla koyar.
-- Eskiden de (yeni hesap) durum buydu. Açık oturumlar kapanır.
--
-- Yalnızca service_role (update-parent, yetki denetimlerinden SONRA çağırır:
-- registration.manage, okul, can_manage_parent, has_branch_access). Hedef
-- yine de burada da rol 8 olmalı: bir personelin girişi bu yoldan
-- sıfırlanamaz. Tekrar çağrılabilir: yeni adres zaten bu hesabınsa çakışma
-- değildir (Edge Function'ın bir sonraki adımı düşerse yeniden denemek
-- hesabı tamamlar).
--
-- Idempotent; tekrar çalıştırılabilir.
-- =============================================================================


create or replace function public.reset_parent_login_email(
  p_parent_id uuid,
  p_new_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_email   text := lower(btrim(coalesce(p_new_email, '')));
  v_profile public.profiles%rowtype;
  v_brand   text;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return public.app_err('Geçerli bir e-posta adresi girin.', 'validation');
  end if;

  select * into v_profile
    from public.profiles
   where id = p_parent_id
     for update;
  if not found or v_profile.role_id <> 8 or v_profile.is_deleted is true
     or not exists (
       select 1 from auth.users u where u.id = p_parent_id and u.deleted_at is null
     ) then
    return public.app_err('Güncellenecek veli profili bulunamadı.', 'not_found');
  end if;

  if exists (
    select 1 from auth.users u
     where lower(u.email) = v_email and u.id <> p_parent_id
  ) then
    return public.app_err('Bu e-posta adresi başka bir hesapta kayıtlı.', 'conflict');
  end if;

  select s.brand into v_brand from public.schools s where s.id = v_profile.school_id;

  update auth.users
     set email                      = v_email,
         email_confirmed_at         = null,
         encrypted_password         = '',
         confirmation_token         = '',
         recovery_token             = '',
         email_change               = '',
         email_change_token_new     = '',
         email_change_token_current = '',
         reauthentication_token     = '',
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
           || jsonb_build_object('brand', coalesce(v_brand, 'public'))
           || case when raw_user_meta_data ? 'email_verified'
                   then '{"email_verified": false}'::jsonb else '{}'::jsonb end,
         updated_at = now()
   where id = p_parent_id;

  update auth.identities
     set identity_data = identity_data
           || jsonb_build_object('email', v_email, 'email_verified', false),
         updated_at = now()
   where user_id = p_parent_id and provider = 'email';

  delete from auth.refresh_tokens  where user_id = p_parent_id::text;
  delete from auth.sessions        where user_id = p_parent_id;
  delete from auth.one_time_tokens where user_id = p_parent_id;

  return public.app_ok(null, jsonb_build_object('id', p_parent_id, 'email', v_email));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$function$;

revoke all on function public.reset_parent_login_email(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reset_parent_login_email(uuid, text)
  to service_role;

comment on function public.reset_parent_login_email(uuid, text) is
  'Velinin auth hesabının e-postasını değiştirir ve hesabı davetli hâle '
  'döndürür (onaysız, şifresiz, oturumsuz); ardından update-parent davet '
  'gönderir. Yalnızca service_role. Bkz. 20261123_parent_email_change.sql.';

-- migrate:down
-- =============================================================================
-- GERİ ALMA: 20261123_parent_email_change.sql
-- =============================================================================
-- Bu dosya çalıştırılmak için değil, gerekirse çalıştırılabilsin diye durur.
-- Önce update-parent'ın eski sürümü dağıtılmalı: yeni sürüm bu fonksiyonu
-- çağırıyor, fonksiyon yokken e-posta değişikliği hatayla düşer (aynı e-posta
-- yolu etkilenmez).


drop function if exists public.reset_parent_login_email(uuid, text);
