-- migrate:up
-- =============================================================================
-- 0011 — Aidat taksitlerini toplu tahsil (collect_financial_records)
-- =============================================================================
-- Aidat ekranında bir sporcunun birden çok açık taksiti tek seferde
-- kapatılır: seçilen her taksitin KALAN tutarı (net_amount − tahsilatlar)
-- tek bir tarih ve yöntemle tahsil edilir.
--
-- Hepsi ya da hiçbiri (ürün kararı): para kaydı yarım kalmamalı. Bu yüzden
-- tek RPC, tek transaction; istemci create_transaction'ı döngüde çağırmaz.
-- Bütün kontroller yazmadan ÖNCE yapılır (app_err normal döner, önceki
-- insert'leri geri almaz — AGENTS.md "Validate before writing"); yazma
-- sırasında beklenmeyen bir hata olursa `raise` bütün transaction'ı geri
-- alır.
--
-- Kurallar create_transaction'la aynı:
--   - can_manage_accounting() (finance.manage),
--   - okul oturumdan; p_school_id yok,
--   - her kayıt çağıranın okulunda, silinmemiş ve finance_branch_ok (şube),
--   - tahsilatın şubesi tahakkukun şubesi, işlemi yapan auth.uid().
-- Ek olarak: kayıtlar `for update` ile kilitlenir (iki kişi aynı taksiti
-- aynı anda kapatamaz; ikincisi kalan tutarı 0 görür ve `conflict` alır),
-- kalan tutarı olmayan kayıt `conflict`, başkasının ya da olmayan kayıt
-- `not_found` (var olduğunu doğrulamaz).
--
-- Yalnızca yeni backend'de: yorum `backend:` ile başlar, şema parmak izinin
-- dışında kalır (test/schema.e2e-spec.ts BACKEND_ONLY).
-- =============================================================================

create or replace function public.collect_financial_records(
  p_record_ids       uuid[],
  p_method           public.payment_method,
  p_transaction_date timestamptz default now()
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  v_school_id uuid := public.get_user_school_id();
  v_ids       uuid[];
  v_found     integer;
  v_open      integer;
  v_total     numeric := 0;
  v_rec       record;
begin
  if not public.can_manage_accounting() then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;
  if v_school_id is null then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;
  if p_method is null then
    return public.app_err('Ödeme yöntemi seçilmeli.', 'validation');
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_ids
    from unnest(coalesce(p_record_ids, '{}')) x
   where x is not null;
  if cardinality(v_ids) = 0 then
    return public.app_err('Tahsil edilecek taksit seçilmedi.', 'validation');
  end if;
  if cardinality(v_ids) > 100 then
    return public.app_err('Tek seferde en çok 100 taksit tahsil edilebilir.', 'validation');
  end if;

  -- Kilitle ve doğrula (yazmadan önce).
  perform 1
    from public.financial_records fr
   where fr.id = any(v_ids)
     and fr.school_id = v_school_id
     and fr.is_deleted is not true
     and public.finance_branch_ok(fr.branch_id)
   order by fr.id
     for update;
  get diagnostics v_found = row_count;
  if v_found <> cardinality(v_ids) then
    return public.app_err('Tahsilat yapılacak finansal kayıt bulunamadı.', 'not_found');
  end if;

  select count(*) filter (where r.remaining > 0),
         coalesce(sum(r.remaining) filter (where r.remaining > 0), 0)
    into v_open, v_total
    from (
      select fr.net_amount - coalesce((
               select sum(t.amount) from public.transactions t
                where t.record_id = fr.id and t.is_deleted is not true), 0) as remaining
        from public.financial_records fr
       where fr.id = any(v_ids)
    ) r;
  if v_open <> cardinality(v_ids) then
    return public.app_err(
      'Seçilen taksitlerden biri zaten ödenmiş. Listeyi yenileyip tekrar deneyin.',
      'conflict');
  end if;

  for v_rec in
    select fr.id, fr.branch_id,
           fr.net_amount - coalesce((
             select sum(t.amount) from public.transactions t
              where t.record_id = fr.id and t.is_deleted is not true), 0) as remaining
      from public.financial_records fr
     where fr.id = any(v_ids)
     order by fr.id
  loop
    insert into public.transactions (
      record_id, amount, method, transaction_date, processed_by,
      school_id, branch_id, is_deleted
    ) values (
      v_rec.id, v_rec.remaining, p_method, coalesce(p_transaction_date, now()),
      auth.uid(), v_school_id, v_rec.branch_id, false
    );
    perform public.recalculate_financial_record_status(v_rec.id);
  end loop;

  return public.app_ok('Taksitler tahsil edildi.',
    jsonb_build_object('count', cardinality(v_ids), 'total_amount', v_total));
exception when others then
  -- plpgsql'de exception bloğu kendi alt transaction'ını geri alır: döngüde
  -- yazılan her tahsilat geri alınmış olarak app_err döner (hepsi ya da
  -- hiçbiri).
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;

comment on function public.collect_financial_records(uuid[], public.payment_method, timestamptz) is
  'backend: Seçilen aidat/gelir taksitlerinin kalan tutarlarını tek transaction''da tahsil eder (hepsi ya da hiçbiri). finance.manage, okul ve şube kapsamı create_transaction''la aynı. Bkz. 0011_collect_dues_bulk.sql.';

revoke all on function public.collect_financial_records(uuid[], public.payment_method, timestamptz) from public, anon;
grant execute on function public.collect_financial_records(uuid[], public.payment_method, timestamptz) to authenticated, service_role;

-- migrate:down
drop function if exists public.collect_financial_records(uuid[], public.payment_method, timestamptz);
