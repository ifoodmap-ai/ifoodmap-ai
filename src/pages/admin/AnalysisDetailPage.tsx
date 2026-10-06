// 單筆 AI 分析紀錄 /admin/analyses/:id(需求與媒合 › AI 分析紀錄)。
//
// 業主拍板 Q3-A:分析紀錄保留當「潛在客戶名單」,拿掉「批准並發送」。
// 那顆按鈕會直接 insert 一張舊狀態(pending)的 supplier_orders —— 沒有餐廳、沒有事件履歷、
// 餐廳後台看不到,兩個寫入都沒檢查 error,失敗也照樣顯示成功。要成交請對方註冊餐廳後台叫貨,走正式訂單流程。
// 這一頁因此不會再寫 supplier_orders,也不需要再讀供應商清單;拒絕與刪除照舊。
import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Trash2, UserCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { formatOrderNo } from '@/lib/order-number';
import { CLAIMED_BADGE_CLASS, claimedBadgeLabel, claimedSummary, isClaimed } from './analysisClaim';

interface Ingredient {
  name: string;
  quantity?: string;
  unit?: string;
  category?: string;
}

interface AnalysisRecord {
  id: string;
  created_at: string;
  source_type: string;
  summary: string | null;
  status: 'pending_review' | 'approved' | 'rejected' | 'sent';
  ingredient_list: Ingredient[] | null;
  admin_notes: string | null;
  reviewed_at: string | null;
  transcript: string | null;
  images: string[] | null;
  messages: { role: string; text: string; image?: string }[] | null;
  /** 形象站訪客註冊後認領的時間(claim_landing_analysis 押的);有值 = 已轉成採購單草稿,不算待審 */
  claimed_at?: string | null;
  claimed_order_id?: string | null;
}

const asDataUrl = (s: string) => (s.startsWith('data:') ? s : `data:image/jpeg;base64,${s}`);

interface BuyerLead {
  company_name: string | null;
  contact_phone: string | null;
  contact_line: string | null;
  /** 形象站「留 Email 讓專人聯絡」(不再收電話之後的主要聯絡方式) */
  contact_email: string | null;
}

/* analysis_records / landing_leads 還沒進 types.ts,沿用專案既有的 cast 慣例,只描述這頁用得到的 builder */
type PgError = { message: string } | null;
type WriteRes = { error: PgError };

const db = supabase as never as {
  from: (t: string) => {
    select: (c: string) => {
      eq: (col: string, v: unknown) => {
        single: () => PromiseLike<{ data: AnalysisRecord | null; error: PgError }>;
        order: (col: string, o: { ascending: boolean }) => {
          limit: (n: number) => PromiseLike<{ data: BuyerLead[] | null; error: PgError }>;
        };
      };
    };
    update: (v: Record<string, unknown>) => { eq: (col: string, v: unknown) => PromiseLike<WriteRes> };
    delete: () => { eq: (col: string, v: unknown) => PromiseLike<WriteRes> };
  };
};

const statusBadgeClass: Record<AnalysisRecord['status'], string> = {
  pending_review: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  approved: 'bg-blue-100 text-blue-800 border-blue-300',
  rejected: 'bg-red-100 text-red-800 border-red-300',
  sent: 'bg-emerald-100 text-emerald-800 border-emerald-300',
};

const statusLabel: Record<AnalysisRecord['status'], string> = {
  pending_review: '待審核',
  approved: '已批准',
  rejected: '已拒絕',
  sent: '已發送',
};

const AnalysisDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [record, setRecord] = useState<AnalysisRecord | null>(null);
  const [buyer, setBuyer] = useState<BuyerLead | null>(null);
  const [loading, setLoading] = useState(true);

  // Reject dialog state
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // Delete state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [lightbox, setLightbox] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!record) return;
    setDeleting(true);
    const { error } = await db.from('analysis_records').delete().eq('id', record.id);
    setDeleting(false);
    setDeleteOpen(false);
    if (error) {
      toast({
        title: '刪除失敗 (Delete failed)',
        description: (error as { message?: string }).message,
        variant: 'destructive',
      });
      return;
    }
    toast({ title: '已刪除 (Deleted)' });
    navigate('/admin/analyses');
  };

  const fetchRecord = async () => {
    const { data } = await db.from('analysis_records').select('*').eq('id', id).single();
    setRecord(data);

    const { data: leads } = await db
      .from('landing_leads')
      .select('company_name, contact_phone, contact_line, contact_email')
      .eq('analysis_id', id)
      .order('created_at', { ascending: false })
      .limit(1);
    setBuyer((leads && leads[0]) ?? null);
  };

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await fetchRecord();
      setLoading(false);
    };
    init();
  }, [id]);

  const handleReject = async () => {
    if (!record) return;
    setRejecting(true);

    const { data: { session } } = await supabase.auth.getSession();
    const currentUserId = session?.user?.id;

    const { error } = await db
      .from('analysis_records')
      .update({
        status: 'rejected',
        admin_notes: rejectReason,
        reviewed_at: new Date().toISOString(),
        reviewed_by: currentUserId,
      })
      .eq('id', record.id);

    if (error) {
      // 以前這裡不看 error,寫入失敗也跳「已拒絕」。失敗就照實說,對話框留著讓人重試
      setRejecting(false);
      toast({
        title: '拒絕失敗 (Reject failed)',
        description: error.message,
        variant: 'destructive',
      });
      return;
    }

    await fetchRecord();
    setRejecting(false);
    setRejectOpen(false);
    setRejectReason('');
    toast({ title: '已拒絕 (Rejected)' });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!record) {
    return (
      <div className="text-center py-20 text-slate-500">
        找不到紀錄 (Record not found)
      </div>
    );
  }

  const claimed = isClaimed(record);
  // 已被註冊認領(轉成採購單草稿)的不算待審:不再顯示「潛在客戶名單」說明與拒絕鈕
  const isPending = record.status === 'pending_review' && !claimed;

  return (
    <div className="max-w-3xl">
      <button
        onClick={() => navigate('/admin/analyses')}
        className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-5 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        返回列表 (Back to list)
      </button>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-800">分析詳情 (Analysis Detail)</h1>
        <div className="flex items-center gap-3">
          {claimed ? (
            <Badge variant="outline" className={CLAIMED_BADGE_CLASS}>
              {claimedBadgeLabel(record)}
            </Badge>
          ) : (
            <Badge variant="outline" className={statusBadgeClass[record.status]}>
              {statusLabel[record.status]}
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            刪除
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {claimed && (
          <Card className="border-emerald-200 bg-emerald-50/60" data-testid="claimed-card">
            <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2.5">
                <UserCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-emerald-900">{claimedSummary(record)}</p>
                  <p className="mt-0.5 text-xs text-emerald-700">
                    帶入時間 {new Date(record.claimed_at as string).toLocaleString('zh-TW')}
                  </p>
                </div>
              </div>
              {record.claimed_order_id && (
                <Button asChild variant="outline" size="sm" className="shrink-0 border-emerald-300 bg-white">
                  <Link to={`/admin/orders/${record.claimed_order_id}`}>
                    查看採購單 {formatOrderNo(record.claimed_order_id)} →
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base text-slate-700">基本資訊 (Basic Info)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex gap-2">
              <span className="text-slate-500 w-28 shrink-0">建立時間</span>
              <span className="text-slate-800">{new Date(record.created_at).toLocaleString('zh-TW')}</span>
            </div>
            <div className="flex gap-2">
              <span className="text-slate-500 w-28 shrink-0">來源類型</span>
              <span className="text-slate-800">{record.source_type}</span>
            </div>
            {record.reviewed_at && (
              <div className="flex gap-2">
                <span className="text-slate-500 w-28 shrink-0">審核時間</span>
                <span className="text-slate-800">{new Date(record.reviewed_at).toLocaleString('zh-TW')}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base text-slate-700">摘要 (Summary)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">
              {record.summary ?? <span className="italic text-slate-400">無摘要 (No summary)</span>}
            </p>
          </CardContent>
        </Card>

        {buyer && (
          <Card className="border-emerald-200">
            <CardHeader>
              <CardTitle className="text-base text-emerald-700">買方聯絡資訊 (Buyer Contact)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex gap-2">
                <span className="text-slate-500 w-28 shrink-0">姓名 / 名稱</span>
                <span className="text-slate-800">{buyer.company_name || '—'}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-slate-500 w-28 shrink-0">聯絡電話</span>
                <span className="text-slate-800">{buyer.contact_phone || '—'}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-slate-500 w-28 shrink-0">LINE ID</span>
                <span className="text-slate-800">{buyer.contact_line || '—'}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-slate-500 w-28 shrink-0">Email</span>
                <span className="text-slate-800 break-all">{buyer.contact_email || '—'}</span>
              </div>
            </CardContent>
          </Card>
        )}

        {record.ingredient_list && record.ingredient_list.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-slate-700">食材列表 (Ingredient List)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {record.ingredient_list.map((item, idx) => (
                  <span
                    key={idx}
                    className="px-2.5 py-1 text-xs rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200"
                  >
                    {typeof item === 'string'
                      ? item
                      : `${item.name}${item.quantity ? ` · ${item.quantity}${item.unit ?? ''}` : ''}`}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 對話紀錄：有結構化訊息 → 聊天泡泡（圖文穿插）；否則退回純文字逐字稿 */}
        {record.messages && record.messages.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-slate-700">完整對話紀錄 (Conversation Log)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {record.messages.map((m, i) => {
                  const isUser = m.role === 'user';
                  return (
                    <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm ${
                          isUser
                            ? 'bg-emerald-600 text-white rounded-br-sm'
                            : 'bg-slate-100 text-slate-800 rounded-bl-sm'
                        }`}
                      >
                        {m.text && <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>}
                        {m.image && (
                          <img
                            src={asDataUrl(m.image)}
                            alt="上傳圖片"
                            onClick={() => setLightbox(asDataUrl(m.image as string))}
                            className={`${m.text ? 'mt-2 ' : ''}max-h-56 w-auto rounded-lg cursor-zoom-in`}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        ) : record.transcript ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-slate-700">完整對話紀錄 (Conversation Log)</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-sm text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                {record.transcript}
              </pre>
            </CardContent>
          </Card>
        ) : null}

        {/* 沒有結構化訊息時，才另外顯示上傳圖片卡（避免與對話內嵌圖重複） */}
        {record.images && record.images.length > 0 && !(record.messages && record.messages.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-slate-700">上傳的圖片 (Uploaded Images)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                {record.images.map((src, i) => (
                  <img
                    key={i}
                    src={asDataUrl(src)}
                    alt={`上傳圖片 ${i + 1}`}
                    onClick={() => setLightbox(asDataUrl(src))}
                    className="h-40 w-auto rounded-lg border border-slate-200 object-cover cursor-zoom-in hover:opacity-90 transition"
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {record.admin_notes && (
          <Card className="border-red-200">
            <CardHeader>
              <CardTitle className="text-base text-red-700">拒絕原因 (Rejection Notes)</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{record.admin_notes}</p>
            </CardContent>
          </Card>
        )}

        {isPending && (
          <div className="space-y-3 pt-2">
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              這筆是潛在客戶名單:要成交,請對方註冊餐廳後台叫貨,走正式的訂單流程。
              {buyer ? '聯絡方式見上方「買方聯絡資訊」。' : ''}
            </p>
            <div className="flex gap-3">
              <Button
                variant="destructive"
                onClick={() => setRejectOpen(true)}
              >
                拒絕 (Reject)
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Reject Dialog */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>拒絕原因 (Rejection Reason)</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Textarea
              placeholder="請輸入拒絕原因…"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>取消</Button>
            <Button
              variant="destructive"
              disabled={rejecting}
              onClick={handleReject}
            >
              {rejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : '確認拒絕'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定刪除這筆紀錄？</AlertDialogTitle>
            <AlertDialogDescription>此操作無法復原，紀錄將永久刪除。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? '刪除中…' : '確定刪除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="放大圖片" className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
};

export default AnalysisDetailPage;
