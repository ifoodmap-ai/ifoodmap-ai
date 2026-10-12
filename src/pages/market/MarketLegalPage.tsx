// /market/terms、/market/privacy:食材市集的服務條款與隱私權政策(內容在 src/lib/market/legal.ts)。
// LEGAL_DRAFT = true 時最上面顯示「草稿」提示(2026-10-12 定稿後是 false,不顯示)。
// 有 id 的條文(例如第六條 #withdrawal)是固定錨點:商品頁、結帳頁、店家頁連過來時捲到那一條(scroll-mt-20:不被頁首蓋住)。
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { MARKET_FOCUS_RING, useMarketTitle } from "@/components/market/MarketLayout";
import { LEGAL_DOCS, LEGAL_DRAFT, type LegalDocKey } from "@/lib/market/legal";

export default function MarketLegalPage({ doc }: { doc: LegalDocKey }) {
  const d = LEGAL_DOCS[doc];
  useMarketTitle(d.title);
  const { hash } = useLocation();
  // MarketLayout 換頁時捲回頂端,網址帶 #錨點 時不捲(見 MarketLayout),由這裡捲到那一條
  useEffect(() => {
    if (!hash) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView?.({ block: "start" });
  }, [hash, doc]);
  const other = doc === "terms" ? { to: "/market/privacy", label: "隱私權政策" } : { to: "/market/terms", label: "服務條款" };
  return (
    <article className="mx-auto max-w-3xl px-4 py-8">
      {LEGAL_DRAFT ? (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          草稿:本文件待業主與法律專業確認後定稿。
        </p>
      ) : null}
      <h1 className="text-2xl font-bold text-slate-900">{d.title}</h1>
      <p className="mt-1 text-sm text-slate-500">最後更新:{d.updated}</p>
      <div className="mt-6 space-y-6">
        {d.sections.map((s) => (
          <section key={s.heading} id={s.id} className="scroll-mt-20">
            <h2 className="mb-2 text-lg font-semibold text-slate-900">{s.heading}</h2>
            {s.paragraphs.map((p) => (
              <p key={p} className="mb-2 leading-relaxed text-slate-700">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
      <p className="mt-8 text-sm">
        <Link to={other.to} className={`inline-flex min-h-11 items-center text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
          看{other.label}
        </Link>
      </p>
    </article>
  );
}
