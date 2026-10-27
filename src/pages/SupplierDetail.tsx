import { Link, useParams, useNavigate } from "react-router-dom";
import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Star, MapPin, Phone, Mail, ArrowLeft, CheckCircle2, Search, ShoppingCart, Building2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { supplyImageUrl } from "@/lib/supply-images";

interface SupplierRow {
  id: string;
  name: string;
  description: string | null;
  contact_email: string | null;
  phone: string | null;
  service_areas: string[] | null;
  is_active?: boolean | null;
}

interface SupplyRow {
  id: string;
  supplier_id: string;
  name: string;
  category: string | null;
  unit: string | null;
  pack_size: string | null;
  price: number | null;
  currency: string | null;
  description: string | null;
  is_available: boolean | null;
  image_path: string | null;
}

/**
 * 後台精簡方案 Q7-A(業主拍板):公開頁的「詢價」退場。
 * 原本送出詢價寫進 inquiries,但那張表只有送出者本人讀得到 —— 供應商、管理員都看不到,
 * 頁面卻說「供應商將會收到您的詢價通知」。改成引導註冊餐廳,在餐廳後台線上叫貨(走正式訂單流程)。
 * 既有的 inquiries 資料保留,不刪。
 */
const REGISTER_PATH = "/register/restaurant";
const ORDER_CTA = "註冊餐廳即可線上叫貨";

/* 這幾張表的型別不在 types.ts 裡 —— 沿用專案既有的 loose cast 慣例(原本的 `as never` 過不了 tsc) */
type PgError = { message: string } | null;
interface LooseQuery<T> extends PromiseLike<{ data: T | null; error: PgError }> {
  select: (cols: string) => LooseQuery<T>;
  eq: (col: string, val: unknown) => LooseQuery<T>;
  order: (col: string, opts: { ascending: boolean }) => LooseQuery<T>;
  insert: (values: unknown) => LooseQuery<T>;
  maybeSingle: () => PromiseLike<{ data: T | null; error: PgError }>;
}
const db = <T,>(table: string): LooseQuery<T> =>
  (supabase as never as { from: (t: string) => LooseQuery<T> }).from(table);

const fetchSupplier = async (id: string): Promise<SupplierRow | null> => {
  const { data, error } = await db<SupplierRow>("suppliers")
    .select("*")
    .eq("id", id)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
};

const fetchAllSupplies = async (): Promise<SupplyRow[]> => {
  const { data, error } = await db<SupplyRow[]>("supplies")
    .select("*")
    .eq("is_available", true);
  if (error) throw new Error(error.message);
  return data ?? [];
};

// Deterministic soft color for category placeholder tiles (no external images).
const CATEGORY_COLORS = [
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700",
  "bg-sky-100 text-sky-700",
  "bg-rose-100 text-rose-700",
  "bg-violet-100 text-violet-700",
  "bg-lime-100 text-lime-700",
];

const categoryColor = (category: string | null): string => {
  const key = category ?? "其他";
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return CATEGORY_COLORS[hash % CATEGORY_COLORS.length];
};

/** 商品卡片的圖片:有上傳圖片就顯示(縮圖、lazy),沒有或載入失敗就退回分類色塊 */
const ProductImage = ({ product }: { product: SupplyRow }) => {
  const [failed, setFailed] = useState(false);
  const url = failed ? null : supplyImageUrl(product.image_path, true);
  if (url) {
    return (
      <img
        src={url}
        alt={product.name}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="aspect-square w-full object-cover bg-muted"
      />
    );
  }
  return (
    <div className={`aspect-square flex items-center justify-center ${categoryColor(product.category)}`}>
      <span className="text-lg font-bold px-3 text-center">{product.category || "食材"}</span>
    </div>
  );
};

const formatPrice = (s: { price: number | null; currency: string | null; unit: string | null }): string => {
  if (s.price == null) return "價格請洽詢";
  const cur = !s.currency || s.currency.toUpperCase() === "TWD" ? "NT$" : s.currency;
  return `${cur} ${s.price}${s.unit ? ` / ${s.unit}` : ""}`;
};

const SupplierDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { toast } = useToast();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("全部商品");

  // Supplier + supplies (Railway API; supplies filtered client-side by supplier_id)
  const {
    data: supplier,
    isLoading: supplierLoading,
    isError: supplierError,
  } = useQuery({
    queryKey: ["supplier", id],
    queryFn: () => fetchSupplier(id!),
    enabled: !!id,
  });

  const { data: allSupplies, isLoading: suppliesLoading } = useQuery({
    queryKey: ["all-supplies"],
    queryFn: fetchAllSupplies,
    enabled: !!supplier,
  });

  const products = useMemo(
    () =>
      (allSupplies ?? []).filter(
        (s) => s.supplier_id === id && s.is_available !== false
      ),
    [allSupplies, id]
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => set.add(p.category || "其他"));
    return Array.from(set);
  }, [products]);

  // Reviews (Supabase; uuid supplier_id column)
  interface Review { id: string; rating: number; comment: string | null; reviewer_name: string | null; created_at: string; }
  const [reviews, setReviews] = useState<Review[]>([]);
  const [newRating, setNewRating] = useState(5);
  const [newComment, setNewComment] = useState("");
  const [newName, setNewName] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);

  const fetchReviews = async () => {
    if (!id) return;
    const { data } = await db<Review[]>("supplier_reviews")
      .select("id, rating, comment, reviewer_name, created_at")
      .eq("supplier_id", id)
      .order("created_at", { ascending: false });
    setReviews(data ?? []);
  };

  useEffect(() => { fetchReviews(); /* eslint-disable-next-line */ }, [id]);

  const reviewStats = useMemo(() => {
    if (reviews.length === 0) return null;
    const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
    const dist = [5, 4, 3, 2, 1].map((star) => ({
      star,
      count: reviews.filter((r) => r.rating === star).length,
    }));
    return { avg, dist };
  }, [reviews]);

  const submitReview = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast({ title: "請先登入", description: "登入後即可撰寫評價", variant: "destructive" }); navigate("/auth"); return; }
    setSubmittingReview(true);
    const { error } = await db("supplier_reviews").insert({
      supplier_id: id,
      supplier_ref: 0, // legacy NOT NULL column, uuid supplier_id is authoritative
      rating: newRating,
      comment: newComment.trim() || null,
      reviewer_name: newName.trim() || user.email?.split("@")[0] || "匿名買家",
      user_id: user.id,
    });
    setSubmittingReview(false);
    if (error) { toast({ title: "送出失敗", description: (error as { message?: string }).message, variant: "destructive" }); return; }
    toast({ title: "感謝您的評價!" });
    setNewComment(""); setNewName(""); setNewRating(5);
    await fetchReviews();
  };

  // Filter products based on search and category
  const filteredProducts = useMemo(() => {
    return products.filter((product) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch =
        product.name.toLowerCase().includes(q) ||
        (product.description ?? "").toLowerCase().includes(q) ||
        (product.category ?? "").toLowerCase().includes(q);
      const matchesCategory =
        selectedCategory === "全部商品" ||
        (product.category || "其他") === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [products, searchQuery, selectedCategory]);

  if (supplierLoading) {
    return (
      <div className="min-h-screen bg-muted/30">
        <div className="container px-4 py-8 mx-auto max-w-6xl space-y-6">
          <Skeleton className="h-10 w-24" />
          <Card className="p-8">
            <div className="flex flex-col md:flex-row gap-6">
              <Skeleton className="w-32 h-32 md:w-40 md:h-40 rounded-full flex-shrink-0" />
              <div className="flex-1 space-y-4">
                <Skeleton className="h-10 w-64" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <div className="flex gap-2">
                  <Skeleton className="h-6 w-16 rounded-full" />
                  <Skeleton className="h-6 w-16 rounded-full" />
                </div>
              </div>
            </div>
          </Card>
          <Card className="p-8">
            <Skeleton className="h-10 w-full max-w-lg mb-6" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square" />
              ))}
            </div>
          </Card>
        </div>
      </div>
    );
  }

  if (!supplier || supplierError) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="p-8 text-center">
          <h2 className="text-2xl font-bold mb-4">Supplier Not Found</h2>
          <Button onClick={() => navigate("/")}>Return Home</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="container px-4 py-8 mx-auto max-w-6xl">
        <Button
          variant="ghost"
          onClick={() => navigate(-1)}
          className="mb-6"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('supplier.back') || 'Back'}
        </Button>

        <div className="space-y-6">
          {/* Header Section */}
          <Card className="p-8">
            <div className="flex flex-col md:flex-row gap-6">
              {/* Logo placeholder */}
              <div className="flex-shrink-0">
                <div className="w-32 h-32 md:w-40 md:h-40 rounded-full bg-primary/10 flex items-center justify-center">
                  <Building2 className="w-16 h-16 text-primary" />
                </div>
              </div>

              {/* Company Info */}
              <div className="flex-1 space-y-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h1 className="text-3xl md:text-4xl font-bold">{supplier.name}</h1>
                      <Badge variant="secondary" className="bg-primary/10 text-primary hover:bg-primary/20">
                        <CheckCircle2 className="w-4 h-4 mr-1" />
                        合作供應商
                      </Badge>
                    </div>
                    {supplier.description && (
                      <p className="text-muted-foreground leading-relaxed max-w-2xl">
                        {supplier.description}
                      </p>
                    )}
                  </div>
                  <div className="flex w-full flex-col gap-2 md:w-auto md:items-end">
                    <Button size="lg" variant="hero" className="w-full md:w-auto" asChild>
                      <Link to={REGISTER_PATH}>
                        <ShoppingCart className="w-4 h-4 mr-2" />
                        {ORDER_CTA}
                      </Link>
                    </Button>
                    {(supplier.contact_email || supplier.phone) && (
                      <Button size="lg" variant="outline" className="w-full md:w-auto" asChild>
                        <a
                          href={
                            supplier.contact_email
                              ? `mailto:${supplier.contact_email}`
                              : `tel:${supplier.phone}`
                          }
                        >
                          <Phone className="w-4 h-4 mr-2" />
                          立即連繫
                        </a>
                      </Button>
                    )}
                    <Link to="/restaurant/purchase" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
                      已經是餐廳會員?到後台叫貨
                    </Link>
                  </div>
                </div>

                {/* Real contact fields only */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3 pt-4 border-t">
                  {supplier.contact_email && (
                    <div className="flex items-start gap-2">
                      <span className="font-medium min-w-[80px] flex items-center gap-1">
                        <Mail className="w-4 h-4" />
                        Email：
                      </span>
                      <span className="text-muted-foreground break-all">{supplier.contact_email}</span>
                    </div>
                  )}
                  {supplier.phone && (
                    <div className="flex items-start gap-2">
                      <span className="font-medium min-w-[80px] flex items-center gap-1">
                        <Phone className="w-4 h-4" />
                        電話：
                      </span>
                      <span className="text-muted-foreground">{supplier.phone}</span>
                    </div>
                  )}
                  {(supplier.service_areas?.length ?? 0) > 0 && (
                    <div className="flex items-start gap-2 md:col-span-2">
                      <span className="font-medium min-w-[80px] flex items-center gap-1">
                        <MapPin className="w-4 h-4" />
                        服務區域：
                      </span>
                      <span className="flex flex-wrap gap-2">
                        {supplier.service_areas!.map((area, index) => (
                          <Badge key={index} variant="outline" className="border-primary/30">
                            {area}
                          </Badge>
                        ))}
                      </span>
                    </div>
                  )}
                </div>

                {/* Supply categories */}
                {categories.length > 0 && (
                  <div className="pt-4 border-t">
                    <div className="flex flex-wrap gap-2">
                      {categories.map((category, index) => (
                        <Badge key={index} variant="secondary" className="text-sm">
                          {category}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Tabs for Content */}
          <Card className="p-8">
            <Tabs defaultValue="products" className="w-full">
              <TabsList className="grid w-full max-w-lg grid-cols-3">
                <TabsTrigger value="products">食材目錄</TabsTrigger>
                <TabsTrigger value="about">供應商介紹</TabsTrigger>
                <TabsTrigger value="reviews">
                  買家評價{reviews.length > 0 ? ` (${reviews.length})` : ""}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="products" className="mt-6">
                <div className="flex flex-col lg:flex-row gap-6">
                  {/* Category Sidebar */}
                  <Card className="lg:w-64 p-4 h-fit">
                    <h3 className="font-bold mb-4">所有分類</h3>
                    <div className="space-y-2">
                      <Button
                        variant={selectedCategory === "全部商品" ? "default" : "ghost"}
                        className="w-full justify-start"
                        onClick={() => setSelectedCategory("全部商品")}
                      >
                        全部商品
                      </Button>
                      {categories.map((category, index) => (
                        <Button
                          key={index}
                          variant={selectedCategory === category ? "default" : "ghost"}
                          className="w-full justify-start"
                          onClick={() => setSelectedCategory(category)}
                        >
                          {category}
                        </Button>
                      ))}
                    </div>
                  </Card>

                  {/* Products Area */}
                  <div className="flex-1 space-y-6">
                    {/* Search Bar */}
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                      <Input
                        placeholder="搜尋產品..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <h2 className="text-2xl font-bold">產品列表</h2>
                      <Badge variant="outline">{filteredProducts.length} 項產品</Badge>
                    </div>

                    {suppliesLoading && (
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {Array.from({ length: 8 }).map((_, i) => (
                          <Card key={i} className="overflow-hidden">
                            <Skeleton className="aspect-square" />
                            <div className="p-3 space-y-2">
                              <Skeleton className="h-5 w-3/4" />
                              <Skeleton className="h-4 w-1/2" />
                              <Skeleton className="h-8 w-full" />
                            </div>
                          </Card>
                        ))}
                      </div>
                    )}

                    {!suppliesLoading && (
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {filteredProducts.map((product) => (
                          <Card key={product.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                            <ProductImage product={product} />
                            <div className="p-3 space-y-2">
                              <h3 className="font-semibold">{product.name}</h3>
                              <p className="text-sm text-muted-foreground">
                                {product.pack_size || product.description || product.category || ""}
                              </p>
                              <p className="text-sm font-semibold text-primary">
                                {formatPrice(product)}
                              </p>
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full h-auto whitespace-normal py-1.5 leading-snug"
                                asChild
                              >
                                <Link to={REGISTER_PATH}>{ORDER_CTA}</Link>
                              </Button>
                            </div>
                          </Card>
                        ))}
                      </div>
                    )}

                    {!suppliesLoading && filteredProducts.length === 0 && (
                      <div className="text-center py-12 text-muted-foreground">
                        {products.length === 0 ? "此供應商尚未上架產品" : "沒有找到符合的產品"}
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="about" className="mt-6">
                <div className="space-y-6">
                  <h2 className="text-2xl font-bold">
                    <CheckCircle2 className="w-6 h-6 inline-block mr-2" />
                    供應商介紹
                  </h2>

                  <Card className="p-6">
                    <h3 className="text-xl font-semibold mb-4">公司簡介</h3>
                    <p className="text-muted-foreground leading-relaxed">
                      {supplier.description || "此供應商尚未提供公司簡介。"}
                    </p>
                  </Card>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <Card className="p-6">
                      <h3 className="text-xl font-semibold mb-4">聯絡方式</h3>
                      <div className="space-y-3">
                        {supplier.contact_email && (
                          <div className="flex items-start space-x-3 p-3 rounded-lg bg-muted/50">
                            <Mail className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                            <span className="font-medium break-all">{supplier.contact_email}</span>
                          </div>
                        )}
                        {supplier.phone && (
                          <div className="flex items-start space-x-3 p-3 rounded-lg bg-muted/50">
                            <Phone className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                            <span className="font-medium">{supplier.phone}</span>
                          </div>
                        )}
                        {!supplier.contact_email && !supplier.phone && (
                          <p className="text-muted-foreground">註冊餐廳後即可在後台線上叫貨。</p>
                        )}
                      </div>
                    </Card>

                    <Card className="p-6">
                      <h3 className="text-xl font-semibold mb-4">服務區域</h3>
                      {(supplier.service_areas?.length ?? 0) > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {supplier.service_areas!.map((area, index) => (
                            <Badge key={index} variant="secondary" className="text-sm">
                              <MapPin className="w-3 h-3 mr-1" />
                              {area}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <p className="text-muted-foreground">服務區域請洽供應商。</p>
                      )}
                    </Card>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="reviews" className="mt-6">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {/* Summary */}
                  <Card className="p-6 h-fit">
                    <h3 className="text-lg font-semibold mb-4">整體評價</h3>
                    {reviewStats ? (
                      <>
                        <div className="flex items-end gap-2 mb-3">
                          <span className="text-4xl font-bold text-primary">{reviewStats.avg.toFixed(1)}</span>
                          <span className="text-muted-foreground mb-1">/ 5.0</span>
                        </div>
                        <div className="flex gap-0.5 mb-1">
                          {[1, 2, 3, 4, 5].map((i) => (
                            <Star key={i} className={`w-5 h-5 ${i <= Math.round(reviewStats.avg) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`} />
                          ))}
                        </div>
                        <p className="text-sm text-muted-foreground mb-4">共 {reviews.length} 則買家評價</p>
                        <div className="space-y-1.5">
                          {reviewStats.dist.map(({ star, count }) => (
                            <div key={star} className="flex items-center gap-2 text-sm">
                              <span className="w-8 text-muted-foreground">{star}★</span>
                              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                                <div className="h-full bg-amber-400" style={{ width: `${reviews.length ? (count / reviews.length) * 100 : 0}%` }} />
                              </div>
                              <span className="w-6 text-right text-muted-foreground">{count}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="text-muted-foreground">尚無評價,成為第一個評價的買家!</p>
                    )}
                  </Card>

                  {/* Review list + submit */}
                  <div className="lg:col-span-2 space-y-4">
                    <Card className="p-5">
                      <h3 className="font-semibold mb-3">撰寫評價</h3>
                      <div className="flex items-center gap-1 mb-3">
                        {[1, 2, 3, 4, 5].map((i) => (
                          <button key={i} type="button" onClick={() => setNewRating(i)} aria-label={`${i} 星`}>
                            <Star className={`w-6 h-6 transition-colors ${i <= newRating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30 hover:text-amber-300"}`} />
                          </button>
                        ))}
                      </div>
                      <Input placeholder="店家名稱(選填)" value={newName} onChange={(e) => setNewName(e.target.value)} className="mb-2" />
                      <Textarea placeholder="分享您的採購體驗…" value={newComment} onChange={(e) => setNewComment(e.target.value)} rows={2} className="mb-3" />
                      <Button onClick={submitReview} disabled={submittingReview} className="bg-primary">
                        {submittingReview ? "送出中…" : "送出評價"}
                      </Button>
                    </Card>

                    {reviews.map((r) => (
                      <Card key={r.id} className="p-5">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="font-medium">{r.reviewer_name ?? "匿名買家"}</span>
                          <span className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleDateString("zh-TW")}</span>
                        </div>
                        <div className="flex gap-0.5 mb-2">
                          {[1, 2, 3, 4, 5].map((i) => (
                            <Star key={i} className={`w-4 h-4 ${i <= r.rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`} />
                          ))}
                        </div>
                        {r.comment && <p className="text-sm text-muted-foreground leading-relaxed">{r.comment}</p>}
                      </Card>
                    ))}
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default SupplierDetail;
