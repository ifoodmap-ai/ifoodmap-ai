import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { track } from "@/lib/analytics";

interface ContactGateProps {
  analysisId: string | null;
  names: string[];
  onDone: () => void;
}

/** landing_leads 的 trigger 擋下同一人/全站太多筆時(raise 'LEAD_RATE_LIMITED',PostgREST 回 400、code P0001) */
export const LEAD_RATE_LIMITED_TEXT = "今天留資料的次數太多了，請明天再試，或直接聯絡我們";
/** 其他寫入失敗(constraint、RLS、網路)一律這句 —— 不把 DB 錯誤或 constraint 名稱秀給使用者 */
export const LEAD_SUBMIT_FAILED_TEXT = "送出失敗，請稍後再試，或直接聯絡我們";

interface LeadInsertError {
  message?: string;
  code?: string;
}

const leadErrorText = (error: LeadInsertError | null | undefined): string =>
  error?.message?.includes("LEAD_RATE_LIMITED") ? LEAD_RATE_LIMITED_TEXT : LEAD_SUBMIT_FAILED_TEXT;

const ContactGate = ({ analysisId, names, onDone }: ContactGateProps) => {
  const [companyName, setCompanyName] = useState("");
  const [line, setLine] = useState("");
  const [phone, setPhone] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const company = companyName.trim();
    const lineId = line.trim();
    const phoneNo = phone.trim();

    if (!company) {
      toast.error("請填寫店家/公司名稱");
      return;
    }
    if (!lineId && !phoneNo) {
      toast.error("請至少留下 LINE ID 或手機其中一項");
      return;
    }

    setIsSubmitting(true);

    try {
      const { error } = await (supabase as never as {
        from: (t: string) => { insert: (row: object) => Promise<{ error: LeadInsertError | null }> };
      })
        .from("landing_leads")
        .insert({
          company_name: company,
          contact_phone: phoneNo || null,
          contact_line: lineId || null,
          items_text: names.join("、"),
          source: "app",
          analysis_id: analysisId,
          user_agent: navigator.userAgent,
        });

      if (error) {
        toast.error(leadErrorText(error));
        return;
      }

      track("contact_captured", { analysis_id: analysisId });
      toast.success("已收到您的聯絡方式,正在為您媒合供應商!");
      onDone();
    } catch {
      // 網路斷線之類(insert 直接丟錯)
      toast.error(LEAD_SUBMIT_FAILED_TEXT);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="py-16 bg-background">
      <div className="container px-4 mx-auto">
        <div className="max-w-xl mx-auto space-y-6">
          <div className="text-center space-y-3">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
              <Sparkles className="w-6 h-6 text-primary" />
            </div>
            <h2 className="text-3xl md:text-4xl font-bold">媒合結果已就緒</h2>
            <p className="text-lg text-muted-foreground">
              留下聯絡方式,媒合結果與供應商報價將同步通知您
            </p>
          </div>

          <Card className="p-8 shadow-medium">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="contact-gate-company">
                  店家/公司名稱 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="contact-gate-company"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="例:好味小館"
                  maxLength={100}
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contact-gate-line">LINE ID</Label>
                  <Input
                    id="contact-gate-line"
                    value={line}
                    onChange={(e) => setLine(e.target.value)}
                    placeholder="例:foodie888"
                    maxLength={100}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contact-gate-phone">手機</Label>
                  <Input
                    id="contact-gate-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="例:0912-345-678"
                    maxLength={30}
                  />
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                LINE ID 或手機至少填一項,我們不會將您的資料提供給第三方。
              </p>

              <Button
                type="submit"
                variant="hero"
                size="lg"
                className="w-full text-lg py-6"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    送出中…
                  </>
                ) : (
                  "查看媒合供應商"
                )}
              </Button>
            </form>
          </Card>
        </div>
      </div>
    </section>
  );
};

export default ContactGate;
