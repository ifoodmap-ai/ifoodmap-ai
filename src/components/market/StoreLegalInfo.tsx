// 店家的法定資訊(消保法 §18 Ⅰ①、零售業網路交易應記載事項第 1 點、食品通訊交易應記載事項第 1、3 點):店家頁、訂單查詢頁共用。
// 必填的五項(登記名稱、負責人、營業所地址、電話、客服 Email)沒有值就寫「未提供」—— 資料庫要求開放零售前填好,
// 舊資料或還沒套 migration 時看得出缺;選填的食品業者登錄字號、產品責任險有填才顯示。
// 用 ul / li(不用 dl):每一列「標籤:值」在螢幕閱讀器裡是完整的一句。
import type { ReactNode } from "react";
import { MARKET_FOCUS_RING } from "./MarketLayout";

export interface StoreLegal {
  legalName?: string | null;
  representative?: string | null;
  businessAddress?: string | null;
  phone?: string | null;
  serviceEmail?: string | null;
  foodRegistrationNo?: string | null;
  liabilityInsurance?: string | null;
}

const filled = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

export default function StoreLegalInfo({ info }: { info: StoreLegal }) {
  const link = (href: string, text: string) => (
    <a href={href} className={`break-all text-emerald-800 underline ${MARKET_FOCUS_RING}`}>
      {text}
    </a>
  );
  const phone = filled(info.phone);
  const email = filled(info.serviceEmail);
  const rows: Array<[string, ReactNode | null, boolean]> = [
    ["登記名稱", filled(info.legalName), true],
    ["負責人", filled(info.representative), true],
    ["營業所地址", filled(info.businessAddress), true],
    ["電話", phone ? link(`tel:${phone}`, phone) : null, true],
    ["客服 Email", email ? link(`mailto:${email}`, email) : null, true],
    ["食品業者登錄字號", filled(info.foodRegistrationNo), false],
    ["產品責任險", filled(info.liabilityInsurance), false],
  ];
  return (
    <ul aria-label="店家資訊" className="space-y-1 text-sm text-slate-700">
      {rows
        .filter(([, value, required]) => required || value !== null)
        .map(([label, value]) => (
          <li key={label} className="break-words">
            <span className="text-slate-500">{label}:</span>
            {value ?? <span className="text-slate-500">未提供</span>}
          </li>
        ))}
    </ul>
  );
}
