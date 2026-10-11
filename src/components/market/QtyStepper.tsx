// 數量選擇:− [數字] +(按鈕至少 44px;數字框可以直接打)。label 給螢幕閱讀器用,例如「有機高麗菜 數量」。
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
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-1">
      <button type="button" className={BTN} aria-label="減少一件" disabled={disabled || value <= min} onClick={() => onChange(clamp(value - 1))}>
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        aria-label="數量"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className={`h-11 w-14 rounded-md border border-slate-300 bg-white text-center text-base ${MARKET_FOCUS_RING}`}
      />
      <button type="button" className={BTN} aria-label="增加一件" disabled={disabled || value >= max} onClick={() => onChange(clamp(value + 1))}>
        +
      </button>
    </div>
  );
}
