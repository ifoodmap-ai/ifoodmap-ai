// 數量選擇:− [數字] +(按鈕至少 44px;數字框可以直接打)。label 給螢幕閱讀器用,例如「有機高麗菜 數量」。
// 數字框打字時先放在 draft:清空的當下不送出(不然受控的框會立刻跳回 1,接著打「5」就變成「15」),
// 打出看得懂的數字才夾在範圍內送出;離開欄位時丟掉 draft,框裡顯示實際的數量(清空就離開 = 不改)。
// draft 記著它對應的數量:數量被外面改掉(加入購物車後歸 1、別的分頁改了)就改顯示實際的數量 ——
// iOS 點按鈕不會讓數字框失去焦點(沒有 blur),不能只靠 blur 清掉 draft。
import { useState } from "react";
import { MARKET_FOCUS_RING } from "./MarketLayout";

interface QtyStepperProps {
  value: number;
  max: number;
  onChange: (qty: number) => void;
  label: string;
  min?: number;
  disabled?: boolean;
}

const BTN = `inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-lg text-slate-800 hover:bg-slate-50 disabled:opacity-40 ${MARKET_FOCUS_RING}`;

export default function QtyStepper({ value, max, onChange, label, min = 1, disabled = false }: QtyStepperProps) {
  const clamp = (n: number) => Math.max(min, Math.min(Number.isFinite(n) ? Math.floor(n) : min, Math.max(min, max)));
  const [draft, setDraft] = useState<{ text: string; value: number } | null>(null);
  const shown = draft !== null && draft.value === value ? draft.text : value;
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-1">
      {/* 按鈕也丟掉 draft:iOS 點按鈕不會讓數字框失去焦點(沒有 blur),框裡會一直顯示剛剛打的字 */}
      <button
        type="button"
        className={BTN}
        aria-label="減少一件"
        disabled={disabled || value <= min}
        onClick={() => {
          setDraft(null);
          onChange(clamp(value - 1));
        }}
      >
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        aria-label="數量"
        min={min}
        max={max}
        value={shown}
        disabled={disabled}
        onChange={(e) => {
          const text = e.target.value;
          const n = Number(text);
          if (text.trim() !== "" && Number.isFinite(n)) {
            const next = clamp(n);
            setDraft({ text, value: next });
            onChange(next);
          } else {
            setDraft({ text, value });
          }
        }}
        onBlur={() => setDraft(null)}
        className={`h-11 w-14 rounded-md border border-slate-300 bg-white text-center text-base ${MARKET_FOCUS_RING}`}
      />
      <button
        type="button"
        className={BTN}
        aria-label="增加一件"
        disabled={disabled || value >= max}
        onClick={() => {
          setDraft(null);
          onChange(clamp(value + 1));
        }}
      >
        +
      </button>
    </div>
  );
}
