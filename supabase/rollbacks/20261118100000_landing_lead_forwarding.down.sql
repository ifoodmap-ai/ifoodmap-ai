-- 還原 20261118100000_landing_lead_forwarding
-- 只拆 trigger / function / constraint / index;新欄位(landing_leads 的聯絡資料、supplier_leads.contact)與已轉出的商機保留,避免丟資料
DROP TRIGGER IF EXISTS trg_landing_leads_forward      ON public.landing_leads;
DROP TRIGGER IF EXISTS trg_landing_leads_forward_prep ON public.landing_leads;
DROP TRIGGER IF EXISTS trg_supplier_leads_guard_contact ON public.supplier_leads;
DROP FUNCTION IF EXISTS public.landing_leads_forward_trg();
DROP FUNCTION IF EXISTS public.forward_landing_lead(uuid);
DROP FUNCTION IF EXISTS public.landing_leads_forward_prep();
DROP FUNCTION IF EXISTS public.supplier_leads_guard_contact();
DROP FUNCTION IF EXISTS public.lead_norm(text);
DROP INDEX IF EXISTS public.uq_supplier_leads_landing;
ALTER TABLE public.landing_leads DROP CONSTRAINT IF EXISTS landing_leads_forward_fields;
