// 訂單明細表(查詢頁、供應商零售訂單、管理員總覽共用):品名、規格、單價 × 數量、小計;下面運費與總額。
// 金額欄一律 whitespace-nowrap:360px 寬時品名欄會吃掉剩下的寬度,粗體的總額會被拆成「NT$」與數字兩行。
import { TEMPERATURES, type Temperature } from "@/lib/market/constants";
import { formatTwd } from "@/lib/market/format";

interface OrderItemsProps {
  items: Array<{ product_name: string; spec: string; temperature: Temperature; unit_price: number; qty: number; line_total: number }>;
  subtotal: number;
  shippingFee: number;
  total: number;
}

export default function OrderItems({ items, subtotal, shippingFee, total }: OrderItemsProps) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">訂單明細</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">商品</th>
          <th scope="col">金額</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i, n) => (
          <tr key={`${i.product_name}-${n}`} className="border-b border-slate-100">
            {/* overflow-wrap:anywhere:很長的英文品名在 360px 寬也會換行,表格不會撐出橫向捲動 */}
            <td className="py-2 pr-2 [overflow-wrap:anywhere]">
              <span className="font-medium text-slate-900">{i.product_name}</span>
              <span className="block text-xs text-slate-500">
                {i.spec}・{TEMPERATURES[i.temperature]}・{formatTwd(i.unit_price)} × {i.qty}
              </span>
            </td>
            <td className="whitespace-nowrap py-2 text-right align-top text-slate-900">{formatTwd(i.line_total)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" className="pt-2 text-left font-normal text-slate-600">
            小計
          </th>
          <td className="whitespace-nowrap pt-2 text-right">{formatTwd(subtotal)}</td>
        </tr>
        <tr>
          <th scope="row" className="text-left font-normal text-slate-600">
            運費
          </th>
          <td className="whitespace-nowrap text-right">{shippingFee === 0 ? "免運" : formatTwd(shippingFee)}</td>
        </tr>
        <tr>
          <th scope="row" className="text-left font-semibold text-slate-900">
            總額
          </th>
          <td className="whitespace-nowrap text-right font-bold text-emerald-800">{formatTwd(total)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
