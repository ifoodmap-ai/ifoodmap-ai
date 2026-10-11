// /market/checkout 免註冊結帳:姓名、電話、Email、收件縣市與地址、備註;每家店各選一種付款方式;勾選同意服務條款。
// 收件縣市不在某家店的配送範圍時,那家店這次不能結帳(留在購物車);一次結帳按店家拆成多張訂單。
// 送出後資料庫重算一切(market_place_order);成功就把結帳的商品從購物車拿掉,帶著 token 進訂單查詢頁(?new=1 顯示「已送出」)。
// 無障礙:每個欄位有 <label>;錯誤顯示在欄位下方(aria-invalid + aria-describedby),送出失敗時焦點移到第一個錯的欄位。
//
// 🔴 伺服器回的錯誤一律經 checkout.ts 的 checkoutErrorMessage 轉成中文(新的錯誤代碼只要在那裡加一句),這頁不寫死訊息;
//    送出時丟出的例外(斷線、逾時)經 checkoutExceptionMessage。
// 🔴 查詢 token(checkoutTokenStore):第一次送出才產生,斷線、逾時、缺貨、價格變了…之後的重送都沿用同一個 —— 下單 RPC 認出來就回
//    第一次的結果(duplicate:true)、不重複建單。成功(含 duplicate)就清掉;TOKEN_REUSED(這個 token 已經成功下過單、內容不同)
//    給舊 token 的「查看訂單」並清掉,購物車保留、不自動重送(再按就是用新 token 的另一張訂單)。
// 🔴 還沒拿到商品資料時不顯示表單(離線、載入失敗各自有整頁畫面):用空陣列算會變成「0 家店、NT$ 0」的表單。
// 已下架 / 查不到的商品不在任何一家店裡,要列在「這次不能結帳」,不然消費者不知道少結了哪些。
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { MARKET_FOCUS_RING, MARKET_PRIMARY_BUTTON, useMarketTitle } from "@/components/market/MarketLayout";
import { MarketStaleNotice } from "@/components/market/MarketNotices";
import { buildCart, CART_LIMITS, cartProductsKey, type CartGroup } from "@/lib/market/cart";
import { fetchProductsByIds } from "@/lib/market/catalog";
import {
  buildCheckoutPayload,
  CHECKOUT_TOKEN_PATTERN,
  checkoutErrorMessage,
  checkoutExceptionMessage,
  checkoutTokenStore,
  defaultPayment,
  emptyBuyer,
  fetchCheckoutStatus,
  placeOrder,
  validateBuyer,
  type BuyerErrors,
  type BuyerForm,
} from "@/lib/market/checkout";
import { LIMITS, PAYMENT_METHODS, TW_CITIES, type PaymentMethod, type TwCity } from "@/lib/market/constants";
import { formatTwd } from "@/lib/market/format";
import { TERMS_VERSION } from "@/lib/market/legal";
import { cartStore, useCart } from "@/lib/market/useCart";
import MarketLoadError from "./MarketLoadError";
import MarketOffline from "./MarketOffline";

// scroll-mt-20:送出失敗時焦點移到欄位,不要被固定的頁首蓋住
const INPUT = `min-h-11 w-full scroll-mt-20 rounded-md border border-slate-300 bg-white px-3 text-base ${MARKET_FOCUS_RING}`;
const FIELD_ORDER: Array<keyof BuyerForm> = ["name", "phone", "email", "city", "address", "note"];
const REFETCH_CODES = ["PRICE_CHANGED", "OUT_OF_STOCK", "PRODUCT_UNAVAILABLE", "NOT_DELIVERABLE", "BELOW_MINIMUM", "PAYMENT_NOT_ACCEPTED"];

const FieldError = ({ id, message }: { id: string; message?: string }) =>
  message ? (
    <p id={id} className="mt-1 text-sm text-red-700">
      {message}
    </p>
  ) : null;

export default function MarketCheckoutPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { lines } = useCart();
  const ids = lines.map((l) => l.productId);
  const products = useQuery({
    queryKey: cartProductsKey(ids),
    queryFn: () => fetchProductsByIds(ids),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
  });
  const status = useQuery({ queryKey: ["market", "checkout-status"], queryFn: fetchCheckoutStatus });
  const productsOffline = products.isPending && products.isPaused;
  useMarketTitle(productsOffline ? "目前離線" : products.isLoadingError ? "商品資料載入失敗" : "結帳");

  const [buyer, setBuyer] = useState<BuyerForm>(emptyBuyer);
  const [errors, setErrors] = useState<BuyerErrors>({});
  const [payments, setPayments] = useState<Record<string, PaymentMethod>>({});
  const [agreed, setAgreed] = useState(false);
  const [agreeError, setAgreeError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** TOKEN_REUSED 時舊 token 的查詢頁(「查看訂單」連結) */
  const [reusedToken, setReusedToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const view = useMemo(() => buildCart(lines, products.data ?? [], buyer.city || null), [lines, products.data, buyer.city]);
  // 別的分頁剛加進來、上一份資料裡沒有的商品還不知道狀態(placeholderData),新資料回來之前不列成已下架
  const unavailable = products.isPlaceholderData
    ? view.unavailable.filter((l) => (products.data ?? []).some((p) => p.id === l.productId))
    : view.unavailable;
  const ready = view.groups.filter((g) => g.canCheckout);
  const blocked = view.groups.filter((g) => !g.canCheckout);
  const grandTotal = ready.reduce((sum, g) => sum + g.total, 0);
  const storeNameOf = (id: string) => view.groups.find((g) => g.supplierId === id)?.storeName ?? "有一家店";
  // 選過的付款方式店家已經不收(重抓之後)就退回店家接受的預設 —— 畫面上的選取跟送出去的一定是同一個
  const paymentOf = (g: CartGroup): PaymentMethod => {
    const picked = payments[g.supplierId];
    return picked && g.store.payment_methods.includes(picked) ? picked : defaultPayment(g.store.payment_methods);
  };

  const set = <K extends keyof BuyerForm>(key: K, value: BuyerForm[K]) => setBuyer((b) => ({ ...b, [key]: value }));
  const field = (key: keyof BuyerForm) => ({
    id: `checkout-${key}`,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `checkout-${key}-error` : undefined,
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    setReusedToken(null);
    const errs = validateBuyer(buyer);
    setErrors(errs);
    setAgreeError(!agreed);
    const firstBad = FIELD_ORDER.find((k) => errs[k]);
    if (firstBad) {
      document.getElementById(`checkout-${firstBad}`)?.focus();
      return;
    }
    if (!agreed) {
      document.getElementById("checkout-agree")?.focus();
      return;
    }
    if (ready.length === 0) {
      setSubmitError("沒有可以結帳的店家,請看上方每家店的說明。");
      return;
    }
    if (ready.length > CART_LIMITS.maxStores) {
      setSubmitError(checkoutErrorMessage({ ok: false, code: "TOO_MANY_STORES" }, storeNameOf));
      return;
    }
    // 前端檢查都過了、真的要送出才拿 token(第一次送出時產生,之後重送沿用)
    const token = checkoutTokenStore.getOrCreate();
    const chosen = Object.fromEntries(ready.map((g) => [g.supplierId, paymentOf(g)]));
    const payload = buildCheckoutPayload({ buyer, groups: ready, payments: chosen, termsVersion: TERMS_VERSION, token });
    setSubmitting(true);
    try {
      const r = await placeOrder(payload);
      // 用 === 比對:tsconfig.app.json 沒開 strict,只靠 if (r.ok) 收窄不了聯集型別
      if (r.ok === false) {
        if (r.code === "TOKEN_REUSED") {
          // 這個 token 之前已經成功下過單(這次內容不同):給舊的查詢頁、換掉 token;購物車留著,不自動重送
          checkoutTokenStore.clear();
          setReusedToken(token);
        }
        setSubmitError(checkoutErrorMessage(r, storeNameOf));
        if (REFETCH_CODES.includes(r.code)) await queryClient.invalidateQueries({ queryKey: ["market", "cart-products"] });
        // 開關在這頁打開之後被關掉了:重新確認,畫面換成「還沒開放」的說明(不留著一張送不出去的表單)
        if (r.code === "MARKET_CLOSED") await queryClient.invalidateQueries({ queryKey: ["market", "checkout-status"] });
        return;
      }
      // 成功(含 duplicate:true —— 同一個 token 重送,伺服器回第一次的結果、沒有重複建單):一樣清空、進查詢頁
      checkoutTokenStore.clear();
      cartStore.remove(ready.flatMap((g) => g.lines.map((l) => l.product.id)));
      navigate(`/market/orders/${CHECKOUT_TOKEN_PATTERN.test(r.token ?? "") ? r.token : token}?new=1`, { replace: true });
    } catch (err) {
      // 沒拿到回覆(斷線、逾時):訂單可能已經建好 → token 留著,請買家再按一次(伺服器認出同一個 token,不會重複下單)
      setSubmitError(checkoutExceptionMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-slate-900">結帳</h1>
        <p className="mt-2 text-slate-600">購物車是空的。</p>
        <Link to="/market" className={`mt-6 inline-flex min-h-11 items-center rounded-md px-5 font-semibold ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}>
          去逛市集
        </Link>
      </div>
    );
  }
  if (status.data && !status.data.can_order) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-slate-900">結帳</h1>
        <p role="status" className="mt-2 text-slate-700">
          {checkoutErrorMessage({ ok: false, code: "MARKET_CLOSED" }, storeNameOf)}
        </p>
        <Link to="/market/cart" className={`mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-5 ${MARKET_FOCUS_RING}`}>
          回購物車
        </Link>
      </div>
    );
  }
  if (productsOffline) return <MarketOffline />;
  if (products.isPending || (status.isPending && !status.isPaused)) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-6" aria-busy="true">
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (products.isLoadingError) return <MarketLoadError title="商品資料載入失敗" onRetry={() => void products.refetch()} />;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="mb-4 text-2xl font-bold text-slate-900">結帳</h1>
      {/* 開關查不到時表單照樣給填(伺服器送出時會再確認),但先講清楚,不要讓人填完才知道還沒開放 */}
      {status.isLoadingError ? (
        <p role="status" className="mb-4 flex flex-wrap items-center gap-x-2 rounded-lg border border-amber-300 bg-amber-50 px-3 text-sm text-amber-900">
          沒辦法確認線上訂購是否開放,請檢查網路;送出訂單時會再確認一次。
          <button type="button" onClick={() => void status.refetch()} className={`min-h-11 font-semibold underline ${MARKET_FOCUS_RING}`}>
            重新確認
          </button>
        </p>
      ) : null}
      {products.isRefetchError ? (
        <div className="mb-4">
          <MarketStaleNotice onRetry={() => void products.refetch()} />
        </div>
      ) : null}
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="space-y-6">
        <fieldset className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
          <legend className="px-1 text-lg font-semibold text-slate-900">收件資料</legend>
          <div>
            <label htmlFor="checkout-name" className="mb-1 block text-sm font-medium">
              收件人姓名
            </label>
            <input {...field("name")} autoComplete="name" maxLength={LIMITS.buyerName} value={buyer.name} onChange={(e) => set("name", e.target.value)} className={INPUT} />
            <FieldError id="checkout-name-error" message={errors.name} />
          </div>
          <div>
            <label htmlFor="checkout-phone" className="mb-1 block text-sm font-medium">
              電話
            </label>
            <input {...field("phone")} type="tel" autoComplete="tel" inputMode="tel" maxLength={20} value={buyer.phone} onChange={(e) => set("phone", e.target.value)} className={INPUT} />
            <FieldError id="checkout-phone-error" message={errors.phone} />
          </div>
          <div>
            <label htmlFor="checkout-email" className="mb-1 block text-sm font-medium">
              Email(訂單通知與查詢連結會寄到這裡)
            </label>
            <input {...field("email")} type="email" autoComplete="email" maxLength={254} value={buyer.email} onChange={(e) => set("email", e.target.value)} className={INPUT} />
            <FieldError id="checkout-email-error" message={errors.email} />
          </div>
          <div>
            <label htmlFor="checkout-city" className="mb-1 block text-sm font-medium">
              收件縣市
            </label>
            <select {...field("city")} autoComplete="address-level1" value={buyer.city} onChange={(e) => set("city", e.target.value as TwCity | "")} className={INPUT}>
              <option value="">請選擇</option>
              {TW_CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <FieldError id="checkout-city-error" message={errors.city} />
          </div>
          <div>
            <label htmlFor="checkout-address" className="mb-1 block text-sm font-medium">
              收件地址(區、路、號、樓)
            </label>
            <input {...field("address")} autoComplete="street-address" maxLength={LIMITS.address} value={buyer.address} onChange={(e) => set("address", e.target.value)} className={INPUT} />
            <FieldError id="checkout-address-error" message={errors.address} />
          </div>
          <div>
            <label htmlFor="checkout-note" className="mb-1 block text-sm font-medium">
              備註(選填,例如:請放管理室)
            </label>
            <textarea {...field("note")} autoComplete="off" rows={2} maxLength={LIMITS.buyerNote} value={buyer.note} onChange={(e) => set("note", e.target.value)} className={`${INPUT} py-2`} />
            <FieldError id="checkout-note-error" message={errors.note} />
          </div>
        </fieldset>

        {blocked.length > 0 || unavailable.length > 0 ? (
          <section aria-labelledby="checkout-blocked" className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <h2 id="checkout-blocked" className="font-semibold text-amber-900">
              這次不能結帳的店家(商品會留在購物車)
            </h2>
            <ul className="mt-2 space-y-2 text-sm text-amber-900">
              {blocked.map((g) => (
                <li key={g.supplierId}>
                  <span className="font-medium">{g.storeName}</span>:{g.problems.join(";")}
                </li>
              ))}
              {unavailable.length > 0 ? <li>{unavailable.length} 項商品已下架或暫停販售,這次不會結帳</li> : null}
            </ul>
            <Link to="/market/cart" className={`mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
              回購物車修改
            </Link>
          </section>
        ) : null}

        {ready.map((g) => {
          const chosen = paymentOf(g);
          return (
            <section key={g.supplierId} aria-labelledby={`checkout-store-${g.supplierId}`} className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 id={`checkout-store-${g.supplierId}`} className="text-lg font-semibold text-slate-900">
                {g.storeName}
              </h2>
              <ul className="mt-2 space-y-1 text-sm">
                {g.lines.map((l) => (
                  <li key={l.product.id} className="flex justify-between gap-2">
                    <span className="min-w-0 break-words">
                      {l.product.name}({l.product.spec})× {l.qty}
                    </span>
                    <span className="shrink-0 whitespace-nowrap">{formatTwd(l.lineTotal)}</span>
                  </li>
                ))}
                <li className="flex justify-between gap-2 text-slate-600">
                  <span>運費</span>
                  <span>{g.shippingFee === 0 ? "免運" : formatTwd(g.shippingFee)}</span>
                </li>
                <li className="flex justify-between gap-2 font-semibold">
                  <span>這家店合計</span>
                  <span>{formatTwd(g.total)}</span>
                </li>
              </ul>
              <fieldset className="mt-3">
                <legend className="text-sm font-medium text-slate-900">付款方式</legend>
                <div className="mt-1 flex flex-wrap gap-x-4">
                  {g.store.payment_methods.map((m) => (
                    <label key={m} className="inline-flex min-h-11 items-center gap-2">
                      <input
                        type="radio"
                        name={`payment-${g.supplierId}`}
                        value={m}
                        checked={chosen === m}
                        onChange={() => setPayments((p) => ({ ...p, [g.supplierId]: m }))}
                        className="h-5 w-5 accent-emerald-700"
                      />
                      {PAYMENT_METHODS[m]}
                    </label>
                  ))}
                </div>
                {chosen === "transfer" ? <p className="text-xs text-slate-600">店家接單後,訂單查詢頁會顯示匯款帳號,也會寄信通知你。</p> : null}
              </fieldset>
            </section>
          );
        })}

        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="flex items-baseline justify-between gap-2 text-lg">
            <span className="font-semibold text-slate-900">應付總額({ready.length} 家店)</span>
            <span className="shrink-0 font-bold text-emerald-800">{formatTwd(grandTotal)}</span>
          </p>
          <p className="text-xs text-slate-600">
            款項直接付給各店家,發票由店家開立。生鮮、冷藏冷凍等易腐食品不適用 7 日解除權(詳見服務條款第五條)。
          </p>
          <div>
            <div className="flex items-start gap-2">
              <input
                id="checkout-agree"
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                aria-invalid={agreeError && !agreed ? true : undefined}
                aria-describedby={agreeError && !agreed ? "checkout-agree-error" : undefined}
                className="mt-1 h-5 w-5 shrink-0 scroll-mt-20 accent-emerald-700"
              />
              <label htmlFor="checkout-agree" className="text-sm">
                我已閱讀並同意服務條款與隱私權政策
              </label>
            </div>
            <p className="ml-7 text-sm">
              <Link to="/market/terms" target="_blank" rel="noopener" className={`inline-flex min-h-11 items-center text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                服務條款
              </Link>
              、
              <Link to="/market/privacy" target="_blank" rel="noopener" className={`inline-flex min-h-11 items-center text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                隱私權政策
              </Link>
              (另開新分頁)
            </p>
            <FieldError id="checkout-agree-error" message={agreeError && !agreed ? "請先勾選同意服務條款與隱私權政策" : undefined} />
          </div>
          {submitError ? (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <p>{submitError}</p>
              {reusedToken ? (
                <Link to={`/market/orders/${reusedToken}`} className={`mt-1 inline-flex min-h-11 items-center font-semibold text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
                  查看訂單
                </Link>
              ) : null}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={submitting}
            className={`inline-flex min-h-11 w-full items-center justify-center rounded-md px-6 font-semibold disabled:opacity-60 ${MARKET_PRIMARY_BUTTON} ${MARKET_FOCUS_RING}`}
          >
            {submitting ? "送出中…" : `送出訂單(${formatTwd(grandTotal)})`}
          </button>
        </div>
      </form>
    </div>
  );
}
