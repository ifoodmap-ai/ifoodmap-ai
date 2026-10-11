// 改零售訂單狀態的確認視窗(供應商「零售訂單」頁用;管理後台的零售訂單總覽是唯讀的,沒有任何動作)。
// 每個動作都先確認一次並說明後果:拒單 / 取消要填原因(會寄給消費者)、出貨要填物流(單號選填),其他動作只確認一次。
// 送出前用 orders.ts 的 validateOrderAction 檢查(跟資料庫的 guard 同一套:只有空白、全形空白、零寬字元也算沒填)。
// 送出 = addOrderEvent(新增一筆狀態紀錄);資料庫說畫面過期(stale_order_status)時顯示原因、關掉視窗、重新整理清單;
// 其他錯誤視窗留著(填的內容還在),可以再按一次。
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LIMITS } from "@/lib/market/constants";
import { friendlyDbError, MarketDbError } from "@/lib/market/db";
import { addOrderEvent, ORDER_ACTIONS, ORDER_STATUS_LABEL, validateOrderAction, type MarketOrderRow, type OrderStatus } from "@/lib/market/orders";
import { formatOrderNo } from "@/lib/order-number";

export interface OrderActionTarget {
  order: MarketOrderRow;
  to: OrderStatus;
}

interface OrderActionDialogProps {
  target: OrderActionTarget | null;
  onClose: () => void;
  /** 成功或畫面過期:重新抓清單 */
  onChanged: () => void;
}

/** 這個動作的後果(寄信規則見 supabase/functions/market-notify/render.ts 的 resolveEventMails) */
const consequence = ({ order, to }: OrderActionTarget): string => {
  switch (to) {
    case "confirmed":
      return order.payment_method === "transfer"
        ? "接單後會自動轉成「待匯款」,消費者會收到 Email,裡面有你的匯款資訊;確認收到款項後再出貨。"
        : "接單後消費者會收到 Email 通知,接著請準備出貨。";
    case "rejected":
      return "拒單後訂單不成立,商品庫存會加回去。原因會寄給消費者。";
    case "paid":
      return "確認你已經收到這筆轉帳,接著就可以出貨。";
    case "shipped":
      return "消費者會收到出貨通知,信裡有物流與單號。";
    case "completed":
      return "確認消費者已經收到貨,這筆訂單就結束了。";
    case "cancelled":
      return "取消後訂單不成立,商品庫存會加回去。原因會寄給消費者。";
    default:
      return "";
  }
};

/** 取消已收款 / 待匯款的轉帳單:款項要由店家自己退(平台不經手) */
const refundWarning = ({ order, to }: OrderActionTarget): string | null => {
  if (to !== "cancelled") return null;
  if (order.status === "paid") return "這筆訂單你已確認收款,取消後要由你自行退款給消費者(取消通知信會請消費者直接聯絡你)。";
  if (order.status === "awaiting_payment") return "如果消費者已經匯款,請退款給他。";
  return null;
};

/** validateOrderAction 的訊息是哪一欄的(標 aria-invalid、移焦點用) */
const fieldOf = (message: string): "reason" | "carrier" | "tracking" =>
  message.startsWith("物流單號") ? "tracking" : message.includes("物流") ? "carrier" : "reason";

const ERROR_ID = "market-order-action-error";
/** 出錯的欄位框線變紅(搭配 aria-invalid) */
const INVALID = "aria-[invalid=true]:border-red-600";

export default function OrderActionDialog({ target, onClose, onChanged }: OrderActionDialogProps) {
  const [reason, setReason] = useState("");
  const [carrier, setCarrier] = useState("");
  const [trackingNo, setTrackingNo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const carrierRef = useRef<HTMLInputElement>(null);
  const trackingRef = useRef<HTMLInputElement>(null);

  // 每次打開都從空白開始:上一張單沒送出的原因不能帶到下一張
  useEffect(() => {
    setReason("");
    setCarrier("");
    setTrackingNo("");
    setError(null);
  }, [target]);

  const meta = target ? ORDER_ACTIONS[target.to] : undefined;
  const errorField = error ? fieldOf(error) : null;
  const invalidProps = (field: "reason" | "carrier" | "tracking") =>
    errorField === field ? { "aria-invalid": true, "aria-describedby": ERROR_ID } : {};

  // 送出中不能關:關掉再打開另一張單的話,這次回來時的「關掉視窗」會把另一張的視窗關掉
  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (!target) return;
    const input = { reason, carrier, trackingNo };
    const invalid = validateOrderAction(target.to, input);
    if (invalid) {
      setError(invalid);
      const field = fieldOf(invalid);
      (field === "tracking" ? trackingRef : field === "carrier" ? carrierRef : reasonRef).current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await addOrderEvent(target.order, target.to, input);
      toast.success(`訂單 ${formatOrderNo(target.order.id)} 已改成「${ORDER_STATUS_LABEL[target.to]}」`);
      setBusy(false);
      onClose();
      onChanged();
    } catch (e) {
      setBusy(false);
      const stale = e instanceof MarketDbError && e.hint === "stale_order_status";
      toast.error("沒有改成功", { description: friendlyDbError(e, "請稍後再試一次") });
      if (stale) {
        onClose();
        onChanged();
      }
    }
  };

  const warning = target ? refundWarning(target) : null;

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {target && meta ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {meta.label}:訂單 {formatOrderNo(target.order.id)}
              </DialogTitle>
              <DialogDescription>{consequence(target)}</DialogDescription>
            </DialogHeader>
            {warning ? <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{warning}</p> : null}
            {meta.needsReason ? (
              <div className="space-y-1.5">
                <Label htmlFor="market-order-reason">原因(必填,會寄給消費者)</Label>
                <Textarea
                  id="market-order-reason"
                  ref={reasonRef}
                  className={INVALID}
                  rows={3}
                  maxLength={LIMITS.orderNote}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  {...invalidProps("reason")}
                />
              </div>
            ) : null}
            {meta.needsCarrier ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="market-order-carrier">物流(必填)</Label>
                  <Input
                    id="market-order-carrier"
                    ref={carrierRef}
                    className={`min-h-11 ${INVALID}`}
                    placeholder="例如:黑貓宅急便、自行配送"
                    maxLength={LIMITS.carrier}
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                    {...invalidProps("carrier")}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="market-order-tracking">物流單號(選填)</Label>
                  <Input
                    id="market-order-tracking"
                    ref={trackingRef}
                    className={`min-h-11 ${INVALID}`}
                    maxLength={LIMITS.trackingNo}
                    value={trackingNo}
                    onChange={(e) => setTrackingNo(e.target.value)}
                    {...invalidProps("tracking")}
                  />
                </div>
              </div>
            ) : null}
            {error ? (
              <p id={ERROR_ID} role="alert" className="text-sm text-red-700">
                {error}
              </p>
            ) : null}
            <DialogFooter className="gap-2">
              <Button variant="outline" className="min-h-11" disabled={busy} onClick={close}>
                返回
              </Button>
              <Button
                className={`min-h-11 ${meta.danger ? "bg-red-600 text-white hover:bg-red-700" : "bg-emerald-700 text-white hover:bg-emerald-800"}`}
                disabled={busy}
                onClick={() => void submit()}
              >
                確定{meta.label}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
