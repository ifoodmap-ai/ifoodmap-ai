import { useEffect, useState } from "react";
import {
  Store,
  Users,
  Plus,
  Pencil,
  Lock,
  Clock,
  MapPin,
  UserX,
  UserCheck,
  UserPlus,
  Building2,
  Mail,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ROLE_VISIBILITY_HINT, visibilityText } from "@/lib/restaurant-visibility";
import { supabase } from "@/integrations/supabase/client";
import { useRestaurant, canSeeCost, type RestaurantRole } from "@/components/RestaurantRoute";

interface BranchRow {
  id: string;
  restaurant_id: string;
  name: string | null;
  address: string | null;
  receiving_hours: string | null;
  is_active: boolean | null;
  created_at: string;
}

interface MemberRow {
  id: string;
  user_id: string;
  restaurant_id: string;
  branch_id: string | null;
  role: RestaurantRole;
  is_active: boolean | null;
  /** 受邀者按「接受」的時間;null / 沒有 = 還沒接受(邀請中,不是正式成員) */
  accepted_at?: string | null;
  created_at: string;
}

/** 還沒按「接受」的邀請 —— 不是正式成員,不算進「啟用中的老闆」 */
const isPendingInvite = (m: MemberRow) => !m.accepted_at;

/** 算得上「老闆」的列:已接受、啟用中、角色是老闆 */
const isActiveOwner = (m: MemberRow) =>
  m.role === "owner" && m.is_active !== false && !isPendingInvite(m);

interface ProfileRow {
  user_id: string;
  display_name: string | null;
}

/** restaurant_member_directory() 的一列:email 只有老闆拿得到(「邀請中」改看成員列自己的 accepted_at) */
interface DirectoryRow {
  user_id: string;
  email: string | null;
  invited_at: string | null;
  invite_pending: boolean | null;
}

type InviteField = "email" | "name" | "role" | "branch_id";

/** invite-restaurant-member 的回應:成功帶 data,失敗帶 code / message(/ field) */
interface InviteResponse {
  data?: {
    member: MemberRow;
    email: string;
    display_name: string;
    invite_pending: boolean;
  };
  code?: string;
  message?: string;
  field?: string;
}

interface InviteForm {
  email: string;
  name: string;
  role: RestaurantRole;
  /** ALL_BRANCHES = 全店(不限分店) */
  branchId: string;
}

/** Radix Select 不收空字串當值,「全店」用這個代號,送出時轉成 null */
const ALL_BRANCHES = "__all__";

// 與 Edge Function(supabase/functions/invite-restaurant-member/validate.ts)同一套規則與訊息;
// 前端只是讓使用者早點看到錯,真正的把關在伺服器端。
const INVITE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_NAME_MAX = 50;

const inviteFnUrl = () =>
  `${String(import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "")}/functions/v1/invite-restaurant-member`;

const validateInvite = (f: InviteForm): Partial<Record<InviteField, string>> => {
  const errors: Partial<Record<InviteField, string>> = {};
  const email = f.email.trim();
  if (!email) errors.email = "請輸入 Email";
  else if (email.length > 254 || !INVITE_EMAIL_RE.test(email)) errors.email = "Email 格式不正確";
  const name = f.name.trim();
  if (!name) errors.name = "請輸入姓名";
  else if ([...name].length > INVITE_NAME_MAX) errors.name = `姓名最多 ${INVITE_NAME_MAX} 個字`;
  return errors;
};

interface BranchForm {
  id: string | null;
  name: string;
  address: string;
  receiving_hours: string;
  is_active: boolean;
}

const emptyBranch: BranchForm = {
  id: null,
  name: "",
  address: "",
  receiving_hours: "",
  is_active: true,
};

const ROLE_OPTIONS: { value: RestaurantRole; label: string; hint: string }[] = [
  { value: "owner", label: "老闆", hint: ROLE_VISIBILITY_HINT.owner },
  { value: "manager", label: "店長", hint: ROLE_VISIBILITY_HINT.manager },
  { value: "purchaser", label: "採購員", hint: ROLE_VISIBILITY_HINT.purchaser },
];

/** 新增成員表單:權限由小到大排,預設選最小的「採購員」 */
const INVITE_ROLE_OPTIONS = (["purchaser", "manager", "owner"] as const).map(
  (v) => ROLE_OPTIONS.find((r) => r.value === v)!,
);

const ROLE_LABEL: Record<RestaurantRole, string> = {
  owner: "老闆",
  manager: "店長",
  purchaser: "採購員",
};

const ROLE_CLASS: Record<RestaurantRole, string> = {
  owner: "bg-emerald-50 text-emerald-700 border-emerald-200",
  manager: "bg-blue-50 text-blue-700 border-blue-200",
  purchaser: "bg-slate-100 text-slate-600 border-slate-300",
};

/** 查不到 profile 時的顯示名稱 */
const shortId = (userId: string) => `${userId.slice(0, 8)}…`;

const RestaurantTeamPage = () => {
  const account = useRestaurant();
  const isOwner = account.role === "owner";
  // 分店由老闆 / 店長維護;成員只有老闆能動
  const canEditBranch = canSeeCost(account.role);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [myEmail, setMyEmail] = useState<string | null>(null);

  const [branchForm, setBranchForm] = useState<BranchForm>(emptyBranch);
  const [branchOpen, setBranchOpen] = useState(false);
  const [savingBranch, setSavingBranch] = useState(false);
  const [toggleTarget, setToggleTarget] = useState<MemberRow | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);

  // 成員 email(只有老闆拿得到,來自 restaurant_member_directory)
  const [memberEmails, setMemberEmails] = useState<Record<string, string>>({});

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState<InviteForm>({
    email: "",
    name: "",
    role: "purchaser",
    branchId: ALL_BRANCHES,
  });
  const [inviteErrors, setInviteErrors] = useState<Partial<Record<InviteField, string>>>({});
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const fetchBranches = async (): Promise<BranchRow[] | null> => {
    const { data, error } = (await (supabase as never as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (
            col: string,
            v: string,
          ) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => Promise<{ data: BranchRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    })
      .from("restaurant_branches")
      .select("*")
      .eq("restaurant_id", account.restaurant_id)
      .order("created_at", { ascending: true })) as {
      data: BranchRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      toast.error("載入分店失敗", { description: error.message });
      return null;
    }
    return data ?? [];
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError(null);

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!cancelled) {
        setMyUserId(session?.user.id ?? null);
        setMyEmail(session?.user.email ?? null);
      }

      const branchRows = await fetchBranches();
      if (cancelled) return;
      if (branchRows) setBranches(branchRows);

      const { data: memberRows, error: memberErr } = (await (supabase as never as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (
              col: string,
              v: string,
            ) => {
              order: (
                c: string,
                o: { ascending: boolean },
              ) => Promise<{ data: MemberRow[] | null; error: { message: string } | null }>;
            };
          };
        };
      })
        .from("restaurant_accounts")
        .select("id, user_id, restaurant_id, branch_id, role, is_active, accepted_at, created_at")
        .eq("restaurant_id", account.restaurant_id)
        .order("created_at", { ascending: true })) as {
        data: MemberRow[] | null;
        error: { message: string } | null;
      };

      if (cancelled) return;

      if (memberErr) {
        setLoadError(memberErr.message);
        toast.error("載入成員失敗", { description: memberErr.message });
        setLoading(false);
        return;
      }

      const list = memberRows ?? [];
      setMembers(list);

      const ids = [...new Set(list.map((m) => m.user_id).filter(Boolean))];
      if (ids.length > 0) {
        const { data: profileRows } = (await (supabase as never as {
          from: (t: string) => {
            select: (c: string) => {
              in: (
                col: string,
                v: string[],
              ) => Promise<{ data: ProfileRow[] | null; error: { message: string } | null }>;
            };
          };
        })
          .from("profiles")
          .select("user_id, display_name")
          .in("user_id", ids)) as {
          data: ProfileRow[] | null;
          error: { message: string } | null;
        };

        if (cancelled) return;
        const map: Record<string, string> = {};
        (profileRows ?? []).forEach((p) => {
          if (p.display_name?.trim()) map[p.user_id] = p.display_name.trim();
        });
        setProfiles(map);
      }

      // email 讀不到不影響主要功能(「邀請中」看的是成員列自己的 accepted_at),所以不跳錯誤
      let dirRows: DirectoryRow[] | null = null;
      try {
        ({ data: dirRows } = (await (supabase as never as {
          rpc: (
            fn: string,
            args: Record<string, unknown>,
          ) => PromiseLike<{ data: DirectoryRow[] | null; error: { message: string } | null }>;
        }).rpc("restaurant_member_directory", { p_restaurant: account.restaurant_id })) as {
          data: DirectoryRow[] | null;
          error: { message: string } | null;
        });
      } catch {
        dirRows = null;
      }

      if (cancelled) return;
      const emailMap: Record<string, string> = {};
      (dirRows ?? []).forEach((d) => {
        if (d.email) emailMap[d.user_id] = d.email;
      });
      setMemberEmails(emailMap);

      setLoading(false);
    };

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.restaurant_id]);

  /* ---------------- 分店 ---------------- */

  const openCreateBranch = () => {
    setBranchForm(emptyBranch);
    setBranchOpen(true);
  };

  const openEditBranch = (b: BranchRow) => {
    setBranchForm({
      id: b.id,
      name: b.name ?? "",
      address: b.address ?? "",
      receiving_hours: b.receiving_hours ?? "",
      is_active: b.is_active ?? true,
    });
    setBranchOpen(true);
  };

  const handleSaveBranch = async () => {
    if (!canEditBranch) return;
    if (!branchForm.name.trim()) {
      toast.error("請填寫分店名稱");
      return;
    }

    setSavingBranch(true);
    const payload = {
      name: branchForm.name.trim(),
      address: branchForm.address.trim() || null,
      receiving_hours: branchForm.receiving_hours.trim() || null,
      is_active: branchForm.is_active,
    };

    const { error } = branchForm.id
      ? ((await (supabase as never as {
          from: (t: string) => {
            update: (v: unknown) => {
              eq: (col: string, v: string) => Promise<{ error: { message: string } | null }>;
            };
          };
        })
          .from("restaurant_branches")
          .update(payload)
          .eq("id", branchForm.id)) as { error: { message: string } | null })
      : ((await (supabase as never as {
          from: (t: string) => {
            insert: (v: unknown) => Promise<{ error: { message: string } | null }>;
          };
        })
          .from("restaurant_branches")
          .insert({ ...payload, restaurant_id: account.restaurant_id })) as {
          error: { message: string } | null;
        });

    setSavingBranch(false);

    if (error) {
      toast.error("儲存失敗", { description: error.message });
      return;
    }

    setBranchOpen(false);
    toast.success(branchForm.id ? "已更新分店" : "已新增分店");
    const rows = await fetchBranches();
    if (rows) setBranches(rows);
  };

  /* ---------------- 成員 ---------------- */

  const handleChangeRole = async (m: MemberRow, role: RestaurantRole) => {
    if (!isOwner || role === m.role) return;

    // 不能把自己降級,避免整家店沒有老闆
    if (m.user_id === myUserId) {
      toast.error("不能變更自己的角色", { description: "請由其他老闆帳號操作。" });
      return;
    }
    // 至少要留一位啟用中的老闆(還沒接受的「老闆邀請」不算;資料庫也有 trigger 擋)
    const activeOwners = members.filter(isActiveOwner);
    if (isActiveOwner(m) && activeOwners.length <= 1) {
      toast.error("至少要保留一位老闆");
      return;
    }

    setBusyMemberId(m.id);
    const prev = m.role;
    setMembers((list) => list.map((x) => (x.id === m.id ? { ...x, role } : x)));

    const { error } = (await (supabase as never as {
      from: (t: string) => {
        update: (v: unknown) => {
          eq: (col: string, v: string) => Promise<{ error: { message: string } | null }>;
        };
      };
    })
      .from("restaurant_accounts")
      .update({ role })
      .eq("id", m.id)) as { error: { message: string } | null };

    setBusyMemberId(null);

    if (error) {
      setMembers((list) => list.map((x) => (x.id === m.id ? { ...x, role: prev } : x)));
      toast.error("角色更新失敗", { description: error.message });
      return;
    }
    toast.success(`已將角色改為${ROLE_LABEL[role]}`);
  };

  const handleToggleActive = async () => {
    const m = toggleTarget;
    setToggleTarget(null);
    if (!m || !isOwner) return;

    const next = !(m.is_active ?? true);

    if (!next) {
      if (m.user_id === myUserId) {
        toast.error("不能停用自己的帳號");
        return;
      }
      const activeOwners = members.filter(isActiveOwner);
      if (isActiveOwner(m) && activeOwners.length <= 1) {
        toast.error("至少要保留一位啟用中的老闆");
        return;
      }
    }

    setBusyMemberId(m.id);
    setMembers((list) => list.map((x) => (x.id === m.id ? { ...x, is_active: next } : x)));

    const { error } = (await (supabase as never as {
      from: (t: string) => {
        update: (v: unknown) => {
          eq: (col: string, v: string) => Promise<{ error: { message: string } | null }>;
        };
      };
    })
      .from("restaurant_accounts")
      .update({ is_active: next })
      .eq("id", m.id)) as { error: { message: string } | null };

    setBusyMemberId(null);

    if (error) {
      setMembers((list) =>
        list.map((x) => (x.id === m.id ? { ...x, is_active: !next } : x)),
      );
      toast.error("更新失敗", { description: error.message });
      return;
    }
    toast.success(next ? "已重新啟用成員" : "已停用成員");
  };

  /* ---------------- 新增成員(寄邀請信) ---------------- */

  const activeBranches = branches.filter((b) => b.is_active !== false);

  const openInvite = () => {
    // 預設分店:老闆自己的分店 → 第一個啟用中的分店 → 全店
    const defaultBranch = activeBranches.some((b) => b.id === account.branch_id)
      ? (account.branch_id as string)
      : (activeBranches[0]?.id ?? ALL_BRANCHES);
    setInviteForm({ email: "", name: "", role: "purchaser", branchId: defaultBranch });
    setInviteErrors({});
    setInviteError(null);
    setInviteOpen(true);
  };

  const updateInvite = <K extends keyof InviteForm>(key: K, value: InviteForm[K]) => {
    setInviteForm((f) => ({ ...f, [key]: value }));
    const field: InviteField = key === "branchId" ? "branch_id" : (key as InviteField);
    setInviteErrors((errs) => (errs[field] ? { ...errs, [field]: undefined } : errs));
    setInviteError(null);
  };

  const handleInvite = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!isOwner || inviting) return;

    const errors = validateInvite(inviteForm);
    setInviteErrors(errors);
    setInviteError(null);
    if (Object.keys(errors).length > 0) return;

    setInviting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setInviteError("登入已過期,請重新登入後再試");
        return;
      }

      let res: Response;
      try {
        // 建帳號、寄信一定要在伺服器端(service role)做 —— 瀏覽器只負責呼叫
        res = await fetch(inviteFnUrl(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ""),
          },
          body: JSON.stringify({
            email: inviteForm.email.trim().toLowerCase(),
            name: inviteForm.name.trim(),
            role: inviteForm.role,
            branch_id: inviteForm.branchId === ALL_BRANCHES ? null : inviteForm.branchId,
            // 只用來指定「哪一家」;伺服器會再確認你是這家店的老闆
            restaurant_id: account.restaurant_id,
          }),
        });
      } catch {
        setInviteError("連線失敗,請檢查網路後再試一次");
        return;
      }

      const json = (await res.json().catch(() => null)) as InviteResponse | null;
      const result = json?.data;
      if (!res.ok || !result?.member) {
        const message = json?.message || `新增失敗(${res.status}),請稍後再試`;
        const field = json?.field;
        if (field === "email" || field === "name" || field === "role" || field === "branch_id") {
          setInviteErrors({ [field]: message });
        } else {
          setInviteError(message);
        }
        return;
      }

      const { member, email, display_name } = result;
      setMembers((list) => [...list.filter((x) => x.id !== member.id), member]);
      setProfiles((p) => ({ ...p, [member.user_id]: display_name }));
      setMemberEmails((m) => ({ ...m, [member.user_id]: email }));
      setInviteOpen(false);
      toast.success(`已寄出邀請信給 ${display_name}`, {
        description: `請對方到 ${email} 收信,點連結設定密碼、登入後按「接受」才會加入(連結 1 小時內有效)。`,
      });
    } finally {
      setInviting(false);
    }
  };

  const memberName = (m: MemberRow) => {
    if (profiles[m.user_id]) return profiles[m.user_id];
    if (m.user_id === myUserId && myEmail) return myEmail;
    return shortId(m.user_id);
  };

  const branchName = (id: string | null) =>
    id ? (branches.find((b) => b.id === id)?.name ?? "已移除的分店") : "全店";
  /** 沒指派分店(或分店已被移除)= null,「看得到什麼」的說明用 */
  const branchNameOrNull = (id: string) => branches.find((b) => b.id === id)?.name ?? null;

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">分店與成員</h1>
        <p className="text-sm text-slate-500 mt-1">
          管理 {account.restaurant_name} 的收貨據點與後台使用者
        </p>
      </div>

      {loadError && (
        <div className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          載入失敗:{loadError}
        </div>
      )}

      {/* ── 分店管理 ── */}
      <Card className="border-slate-200 mb-6">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base text-slate-700 flex items-center gap-2">
                <Store className="h-4 w-4 text-emerald-600" />
                分店管理
              </CardTitle>
              <p className="text-xs text-slate-400 mt-1">
                每個收貨據點一筆,供應商送貨會依這裡的地址與收貨時段安排
              </p>
            </div>
            {canEditBranch && (
              <Button
                size="sm"
                onClick={openCreateBranch}
                className="bg-emerald-600 hover:bg-emerald-700 text-white shrink-0"
              >
                <Plus className="h-4 w-4 mr-1.5" />
                新增分店
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : branches.length === 0 ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              <Building2 className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p>還沒有建立分店</p>
              {canEditBranch && (
                <p className="mt-1 text-xs">點右上角「新增分店」建立第一個收貨據點</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {branches.map((b) => (
                <div
                  key={b.id}
                  className="flex items-start justify-between gap-3 rounded-md border border-slate-200 px-4 py-3 hover:bg-slate-50 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-slate-800">{b.name ?? "未命名分店"}</p>
                      {b.is_active === false && (
                        <Badge
                          variant="outline"
                          className="bg-slate-100 text-slate-500 border-slate-300"
                        >
                          已停用
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-slate-500 mt-1 flex items-start gap-1.5">
                      <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
                      {b.address || "尚未填寫地址"}
                    </p>
                    <p className="text-sm text-slate-500 mt-0.5 flex items-start gap-1.5">
                      <Clock className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
                      {b.receiving_hours || "尚未設定收貨時段"}
                    </p>
                  </div>
                  {canEditBranch && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-slate-400 hover:text-slate-700 shrink-0"
                      onClick={() => openEditBranch(b)}
                      aria-label="編輯分店"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {!canEditBranch && !loading && (
            <p className="mt-4 flex items-center gap-1.5 text-xs text-slate-400">
              <Lock className="h-3.5 w-3.5" />
              你的角色為採購員,分店資料為唯讀。
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 成員管理 ── */}
      <Card className="border-slate-200">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base text-slate-700 flex items-center gap-2">
                <Users className="h-4 w-4 text-emerald-600" />
                成員管理
              </CardTitle>
              <p className="text-xs text-slate-400 mt-1">
                調整每位同事的權限;採購員看不到任何成本與毛利數字
              </p>
            </div>
            {isOwner && (
              <Button
                onClick={openInvite}
                disabled={loading}
                className="h-11 bg-emerald-600 hover:bg-emerald-700 text-white shrink-0"
              >
                <UserPlus className="h-4 w-4 mr-1.5" />
                新增成員
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!isOwner && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <Lock className="h-4 w-4 shrink-0 mt-0.5" />
              <span>只有老闆可以新增成員、調整角色或停用帳號,以下為唯讀檢視。</span>
            </div>
          )}

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : members.length === 0 ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              <Users className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p>目前沒有其他成員</p>
              {isOwner && (
                <p className="mt-1 text-xs">點右上角「新增成員」寄邀請信給同事</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {members.map((m) => {
                const active = m.is_active ?? true;
                const isSelf = m.user_id === myUserId;
                const busy = busyMemberId === m.id;
                const invitePending = isPendingInvite(m);
                const email = isOwner ? memberEmails[m.user_id] : undefined;
                return (
                  <div
                    key={m.id}
                    className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-md border px-4 py-3 ${
                      active ? "border-slate-200" : "border-slate-200 bg-slate-50 opacity-70"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-slate-800 truncate">{memberName(m)}</p>
                        {isSelf && (
                          <Badge
                            variant="outline"
                            className="bg-emerald-50 text-emerald-700 border-emerald-200"
                          >
                            你自己
                          </Badge>
                        )}
                        {invitePending && (
                          <Badge
                            variant="outline"
                            className="bg-amber-50 text-amber-700 border-amber-200"
                            title="已寄出邀請,對方登入後按「接受」才會成為成員"
                          >
                            <Mail className="h-3 w-3 mr-1" aria-hidden="true" />
                            邀請中
                          </Badge>
                        )}
                        {!active && (
                          <Badge
                            variant="outline"
                            className="bg-slate-100 text-slate-500 border-slate-300"
                          >
                            已停用
                          </Badge>
                        )}
                      </div>
                      {email && email !== memberName(m) && (
                        <p className="text-xs text-slate-500 mt-0.5 break-all">{email}</p>
                      )}
                      <p className="text-xs text-slate-400 mt-1">
                        {branchName(m.branch_id)} · {invitePending ? "邀請於" : "加入於"}{" "}
                        {new Date(m.created_at).toLocaleDateString("zh-TW")}
                      </p>
                      <p className="text-xs text-slate-500 mt-1" data-testid={`visibility-${m.id}`}>
                        看得到:{visibilityText(m.role, m.branch_id ? branchNameOrNull(m.branch_id) : null)}
                      </p>
                      {invitePending && isOwner && (
                        <p className="text-xs text-amber-700 mt-1">
                          對方登入後按「接受」才會加入。邀請信連結 1 小時內有效,過期請對方到登入頁按「忘記密碼」,用這個 Email 設定密碼後登入。
                        </p>
                      )}
                    </div>

                    {isOwner ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <Select
                          value={m.role}
                          disabled={busy || isSelf || !active}
                          onValueChange={(v) => handleChangeRole(m, v as RestaurantRole)}
                        >
                          <SelectTrigger className="h-9 w-[132px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {/* 只放純文字 —— SelectItem 的 children 會被 Radix 鏡射到 trigger 上 */}
                            {ROLE_OPTIONS.map((r) => (
                              <SelectItem key={r.value} value={r.value}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || isSelf}
                          onClick={() => setToggleTarget(m)}
                          className={
                            active
                              ? "text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                              : "text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                          }
                        >
                          {active ? (
                            <>
                              <UserX className="h-4 w-4 mr-1.5" />
                              停用
                            </>
                          ) : (
                            <>
                              <UserCheck className="h-4 w-4 mr-1.5" />
                              啟用
                            </>
                          )}
                        </Button>
                      </div>
                    ) : (
                      <Badge variant="outline" className={`${ROLE_CLASS[m.role]} shrink-0`}>
                        {ROLE_LABEL[m.role] ?? m.role}
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!loading && members.length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-100 space-y-1.5">
              <p className="text-xs font-medium text-slate-500">角色權限說明</p>
              {ROLE_OPTIONS.map((r) => (
                <p key={r.value} className="text-xs text-slate-400">
                  <span className="text-slate-600 font-medium">{r.label}</span>
                  {" — "}
                  {r.hint}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 分店編輯 Dialog */}
      <Dialog open={branchOpen} onOpenChange={setBranchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{branchForm.id ? "編輯分店" : "新增分店"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="branch-name" className="text-slate-600">
                分店名稱 *
              </Label>
              <Input
                id="branch-name"
                value={branchForm.name}
                onChange={(e) => setBranchForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例:信義店"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="branch-address" className="text-slate-600">
                收貨地址
              </Label>
              <Input
                id="branch-address"
                value={branchForm.address}
                onChange={(e) => setBranchForm((f) => ({ ...f, address: e.target.value }))}
                placeholder="例:臺北市信義區松高路 11 號 B1"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="branch-hours" className="text-slate-600">
                收貨時段
              </Label>
              <Input
                id="branch-hours"
                value={branchForm.receiving_hours}
                onChange={(e) =>
                  setBranchForm((f) => ({ ...f, receiving_hours: e.target.value }))
                }
                placeholder="例:週一至週六 08:00–11:00"
              />
              <p className="text-xs text-slate-400">供應商會依這個時段安排配送</p>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Switch
                checked={branchForm.is_active}
                onCheckedChange={(v) => setBranchForm((f) => ({ ...f, is_active: v }))}
              />
              <span className="text-sm text-slate-600">啟用中(可接收訂單)</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBranchOpen(false)}>
              取消
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={savingBranch || !branchForm.name.trim()}
              onClick={handleSaveBranch}
            >
              {savingBranch ? "儲存中…" : "儲存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新增成員 Dialog(只有老闆打得開) */}
      <Dialog
        open={inviteOpen && isOwner}
        onOpenChange={(o) => {
          if (!inviting) setInviteOpen(o);
        }}
      >
        {/* 右上角關閉鈕是 shadcn 內建的 16px 小圖示;手機上放大到 44px 點擊區(只影響這個 Dialog) */}
        <DialogContent className="max-h-[90dvh] overflow-y-auto [&>button.absolute]:right-1.5 [&>button.absolute]:top-1.5 [&>button.absolute]:flex [&>button.absolute]:h-11 [&>button.absolute]:w-11 [&>button.absolute]:items-center [&>button.absolute]:justify-center">
          <DialogHeader>
            <DialogTitle>新增成員</DialogTitle>
            <DialogDescription>
              我們會寄一封邀請信到對方的信箱,對方點信中連結設定密碼後,就能用這個 Email 登入{" "}
              {account.restaurant_name} 的後台。
            </DialogDescription>
          </DialogHeader>

          <form
            id="invite-member-form"
            onSubmit={handleInvite}
            noValidate
            className="space-y-4 py-1"
          >
            <div className="space-y-1.5">
              <Label htmlFor="invite-email" className="text-slate-600">
                Email *
              </Label>
              <Input
                id="invite-email"
                type="email"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="h-11"
                value={inviteForm.email}
                onChange={(e) => updateInvite("email", e.target.value)}
                placeholder="例:staff@example.com"
                aria-invalid={!!inviteErrors.email}
                aria-describedby={inviteErrors.email ? "invite-email-error" : undefined}
                disabled={inviting}
              />
              {inviteErrors.email && (
                <p id="invite-email-error" className="text-xs text-red-600">
                  {inviteErrors.email}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invite-name" className="text-slate-600">
                姓名 *
              </Label>
              <Input
                id="invite-name"
                autoComplete="off"
                className="h-11"
                value={inviteForm.name}
                onChange={(e) => updateInvite("name", e.target.value)}
                placeholder="例:王小明"
                maxLength={INVITE_NAME_MAX + 10}
                aria-invalid={!!inviteErrors.name}
                aria-describedby={inviteErrors.name ? "invite-name-error" : undefined}
                disabled={inviting}
              />
              {inviteErrors.name && (
                <p id="invite-name-error" className="text-xs text-red-600">
                  {inviteErrors.name}
                </p>
              )}
            </div>

            <fieldset className="space-y-1.5" disabled={inviting}>
              <legend className="text-sm font-medium text-slate-600 mb-1.5">角色</legend>
              <RadioGroup
                value={inviteForm.role}
                onValueChange={(v) => updateInvite("role", v as RestaurantRole)}
                className="gap-2"
              >
                {INVITE_ROLE_OPTIONS.map((r) => {
                  const selected = inviteForm.role === r.value;
                  return (
                    <Label
                      key={r.value}
                      htmlFor={`invite-role-${r.value}`}
                      className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 leading-normal transition-colors ${
                        selected
                          ? "border-emerald-500 bg-emerald-50/60"
                          : "border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <RadioGroupItem
                        id={`invite-role-${r.value}`}
                        value={r.value}
                        className="mt-0.5 shrink-0"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800">
                          {r.label}
                        </span>
                        <span className="block text-xs font-normal text-slate-500 mt-0.5">
                          {r.hint}
                        </span>
                      </span>
                    </Label>
                  );
                })}
              </RadioGroup>
              {inviteForm.role === "owner" && (
                <p className="text-xs text-amber-700">
                  老闆擁有全部權限,包括新增、停用其他成員。請只給信得過的人。
                </p>
              )}
              {inviteErrors.role && <p className="text-xs text-red-600">{inviteErrors.role}</p>}
            </fieldset>

            {branches.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="invite-branch" className="text-slate-600">
                  分店
                </Label>
                <Select
                  value={inviteForm.branchId}
                  onValueChange={(v) => updateInvite("branchId", v)}
                  disabled={inviting}
                >
                  <SelectTrigger
                    id="invite-branch"
                    className="h-11"
                    aria-invalid={!!inviteErrors.branch_id}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* 只放純文字 —— SelectItem 的 children 會被 Radix 鏡射到 trigger 上 */}
                    <SelectItem value={ALL_BRANCHES} className="min-h-11">
                      全店(不限分店)
                    </SelectItem>
                    {activeBranches.map((b) => (
                      <SelectItem key={b.id} value={b.id} className="min-h-11">
                        {b.name ?? "未命名分店"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-400">這位成員建立的採購單會記在這個分店</p>
                <p className="text-xs text-slate-500" data-testid="invite-visibility">
                  這位成員看得到:{visibilityText(inviteForm.role, inviteForm.branchId === ALL_BRANCHES ? null : (branches.find((b) => b.id === inviteForm.branchId)?.name ?? null))}
                </p>
                {inviteErrors.branch_id && (
                  <p className="text-xs text-red-600">{inviteErrors.branch_id}</p>
                )}
              </div>
            )}

            {inviteError && (
              <div
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                {inviteError}
              </div>
            )}
          </form>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setInviteOpen(false)}
              disabled={inviting}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="invite-member-form"
              className="h-11 bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={inviting}
            >
              {inviting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  寄送中…
                </>
              ) : (
                <>
                  <Mail className="h-4 w-4 mr-1.5" />
                  寄出邀請
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 停用 / 啟用確認 */}
      <AlertDialog
        open={!!toggleTarget}
        onOpenChange={(o) => {
          if (!o) setToggleTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {toggleTarget && (toggleTarget.is_active ?? true)
                ? "確定停用這位成員?"
                : "確定重新啟用這位成員?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {toggleTarget && (toggleTarget.is_active ?? true)
                ? `${toggleTarget ? memberName(toggleTarget) : ""} 將無法再登入餐廳後台,既有訂單紀錄會完整保留。`
                : "該成員將可以重新登入餐廳後台。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleToggleActive}
              className={
                toggleTarget && (toggleTarget.is_active ?? true)
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-emerald-600 hover:bg-emerald-700"
              }
            >
              確定
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default RestaurantTeamPage;
