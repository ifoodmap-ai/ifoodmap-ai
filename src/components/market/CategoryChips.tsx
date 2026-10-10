// 分類切換(首頁、店家頁):「全部」+ 12 類(或只列這家店有的分類),圖示用形象站的 cat-*.svg。
// 手機上是一列可以橫向滑動的按鈕(自己捲,不把頁面撐寬);桌機換行排開。切換鈕用 aria-pressed。
// 捲動列四周要留 ≥ 4px 給焦點框(ring-2 + ring-offset-2 畫在按鈕外面):overflow-x-auto 會讓 overflow-y 也變 auto,
// 上緣沒 padding 就被切掉。按鈕得到焦點時自己捲進可見範圍(scrollIntoViewOnFocus;Chrome 不會捲露出一半的按鈕),
// scroll-px-4 讓捲完離邊緣留 16px,左右也不會被切。
import { CATEGORY_ICON } from "@/lib/market/categoryIcons";
import { MARKET_CATEGORIES, type MarketCategoryKey } from "@/lib/market/constants";
import { scrollIntoViewOnFocus } from "./focus";
import { MARKET_FOCUS_RING } from "./MarketLayout";

interface CategoryChipsProps {
  value: MarketCategoryKey | null;
  onChange: (value: MarketCategoryKey | null) => void;
  /** 只列這些分類(店家頁用);不給就是全部 12 類 */
  available?: MarketCategoryKey[];
}

const chipClass = (active: boolean) =>
  `inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-sm ${
    active ? "border-emerald-700 bg-emerald-50 font-semibold text-emerald-800" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
  } ${MARKET_FOCUS_RING}`;

export default function CategoryChips({ value, onChange, available }: CategoryChipsProps) {
  const categories = available ? MARKET_CATEGORIES.filter((c) => available.includes(c.key)) : MARKET_CATEGORIES;
  return (
    <div
      role="group"
      aria-label="食材分類"
      className="-mx-4 flex scroll-px-4 gap-2 overflow-x-auto px-4 pb-2 pt-1.5 min-[881px]:mx-0 min-[881px]:flex-wrap min-[881px]:overflow-visible min-[881px]:px-0 min-[881px]:pt-0"
    >
      <button
        type="button"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        onFocus={scrollIntoViewOnFocus}
        className={chipClass(value === null)}
      >
        全部
      </button>
      {categories.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-pressed={value === c.key}
          onClick={() => onChange(c.key)}
          onFocus={scrollIntoViewOnFocus}
          className={chipClass(value === c.key)}
        >
          <img src={CATEGORY_ICON[c.key]} alt="" width={24} height={24} className="h-6 w-6 rounded" />
          {c.label}
        </button>
      ))}
    </div>
  );
}
