import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
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
import { supabase } from '@/integrations/supabase/client';
import { applyPendingAnalysisFilter } from './adminCounts';
import { CLAIMED_BADGE_CLASS, claimedBadgeLabel, claimedSummary, isClaimed } from './analysisClaim';

type AnalysisStatus = 'pending_review' | 'approved' | 'rejected' | 'sent';
type TabValue = 'all' | AnalysisStatus;

interface AnalysisRecord {
  id: string;
  created_at: string;
  source_type: string;
  summary: string | null;
  status: AnalysisStatus;
  claimed_at: string | null;
  claimed_order_id: string | null;
}

interface ListQuery extends PromiseLike<{ data: AnalysisRecord[] | null }> {
  eq(col: string, val: unknown): ListQuery;
  is(col: string, val: null): ListQuery;
}

const statusBadgeClass: Record<AnalysisStatus, string> = {
  pending_review: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  approved: 'bg-blue-100 text-blue-800 border-blue-300',
  rejected: 'bg-red-100 text-red-800 border-red-300',
  sent: 'bg-emerald-100 text-emerald-800 border-emerald-300',
};

const statusLabel: Record<AnalysisStatus, string> = {
  pending_review: '待審核',
  approved: '已批准',
  rejected: '已拒絕',
  sent: '已發送',
};

const tabs: { value: TabValue; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending_review', label: '待審核' },
  { value: 'sent', label: '已發送' },
  { value: 'rejected', label: '已拒絕' },
];

const AnalysisListPage = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<TabValue>('all');
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!deleteId) return;
    const id = deleteId;
    setDeleting(true);
    const { error } = await (supabase as never)
      .from('analysis_records')
      .delete()
      .eq('id', id);
    setDeleting(false);
    setDeleteId(null);
    if (error) {
      toast({
        title: '刪除失敗 (Delete failed)',
        description: (error as { message?: string }).message,
        variant: 'destructive',
      });
      return;
    }
    toast({ title: '已刪除 (Deleted)' });
    setRecords((prev) => prev.filter((r) => r.id !== id));
  };

  useEffect(() => {
    const fetchRecords = async () => {
      setLoading(true);

      let query = (supabase as never as {
        from: (t: string) => {
          select: (c: string) => { order: (col: string, o: { ascending: boolean }) => ListQuery };
        };
      })
        .from('analysis_records')
        .select('id, created_at, source_type, summary, status, claimed_at, claimed_order_id')
        .order('created_at', { ascending: false });

      if (activeTab === 'pending_review') {
        // 跟今日待辦的「待審分析」同一個定義:已被註冊認領的不算待審
        query = applyPendingAnalysisFilter(query);
      } else if (activeTab !== 'all') {
        query = query.eq('status', activeTab);
      }

      const { data } = await query;
      setRecords((data as AnalysisRecord[] | null) ?? []);
      setLoading(false);
    };

    fetchRecords();
  }, [activeTab]);

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-800 mb-6">分析紀錄 (Analyses)</h1>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabValue)} className="mb-4">
        <TabsList>
          {tabs.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="rounded-md border border-slate-200 bg-white overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="text-slate-600">建立時間</TableHead>
              <TableHead className="text-slate-600">來源</TableHead>
              <TableHead className="text-slate-600">摘要</TableHead>
              <TableHead className="text-slate-600">狀態</TableHead>
              <TableHead className="text-slate-600 w-12 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : records.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-10 text-slate-400">
                  沒有紀錄 (No records found)
                </TableCell>
              </TableRow>
            ) : (
              records.map((record) => (
                <TableRow
                  key={record.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => navigate(`/admin/analyses/${record.id}`)}
                >
                  <TableCell className="text-sm text-slate-600 whitespace-nowrap">
                    {new Date(record.created_at).toLocaleString('zh-TW')}
                  </TableCell>
                  <TableCell className="text-sm text-slate-600">{record.source_type}</TableCell>
                  <TableCell className="text-sm text-slate-600 max-w-xs">
                    {record.summary
                      ? record.summary.length > 60
                        ? record.summary.slice(0, 60) + '…'
                        : record.summary
                      : <span className="text-slate-400 italic">無摘要</span>}
                  </TableCell>
                  <TableCell>
                    {/* 被註冊認領的紀錄 status 仍是 pending_review,但已經不算待審 —— 標成「已轉採購單」 */}
                    {isClaimed(record) ? (
                      <Badge
                        variant="outline"
                        className={CLAIMED_BADGE_CLASS}
                        title={claimedSummary(record)}
                      >
                        {claimedBadgeLabel(record)}
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className={statusBadgeClass[record.status]}
                      >
                        {statusLabel[record.status]}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-slate-400 hover:text-red-600 hover:bg-red-50"
                      onClick={() => setDeleteId(record.id)}
                      aria-label="刪除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
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
    </div>
  );
};

export default AnalysisListPage;
