import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Upload, FileImage, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { analyzeMenu, formatIngredient, friendlyAiError } from "@/lib/api";
import { track } from "@/lib/analytics";

export interface AnalysisMeta {
  analysisId: string | null;
  names: string[];
}

interface MenuUploadProps {
  onAnalysisComplete: (ingredients: string[], meta: AnalysisMeta) => void;
  /**
   * 精簡版(餐廳後台「AI 菜單分析」用):拿掉行銷頁的大標題與大留白,只剩一張上傳卡,
   * 文案一律繁中。不傳 = 原本訪客首頁的樣子,完全不變。
   */
  compact?: boolean;
}

const MenuUpload = ({ onAnalysisComplete, compact = false }: MenuUploadProps) => {
  const { t } = useLanguage();
  const [isUploading, setIsUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        toast.error(compact ? "照片不能超過 10MB" : "File size cannot exceed 10MB");
        return;
      }
      
      if (!file.type.startsWith("image/")) {
        toast.error(compact ? "請選擇圖片檔(JPG、PNG)" : "Please upload an image file");
        return;
      }

      setSelectedFile(file);
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      // 精簡版:預覽圖本身就是回饋,不再多跳一個提示
      if (!compact) toast.success("File selected");
    }
  };

  const clearSelection = () => {
    setSelectedFile(null);
    setPreviewUrl("");
  };

  const handleAnalyze = async () => {
    if (!selectedFile) {
      toast.error(compact ? "請先選一張菜單照片" : "Please select a menu image first");
      return;
    }

    setIsUploading(true);
    track("analysis_started", { source: "menu_upload" });

    try {
      const result = await analyzeMenu(selectedFile);

      if (result.ingredients.length === 0) {
        toast.error("AI 無法從這張菜單辨識出食材,請換一張更清晰的圖片");
        return;
      }

      track("analysis_completed", { source: "menu_upload", count: result.ingredients.length });
      onAnalysisComplete(result.ingredients.map(formatIngredient), {
        analysisId: result.analysisId,
        names: result.ingredients.map((i) => i.name),
      });
      toast.success("AI 分析完成!");
    } catch (error) {
      // 用量上限、照片太大這類有錯誤碼的 → 直接給白話提示;其他照舊
      const friendly = friendlyAiError(error);
      const message = error instanceof Error ? error.message : "AI 分析失敗";
      toast.error(friendly ?? `AI 分析失敗:${message}`);
    } finally {
      setIsUploading(false);
    }
  };

  if (compact) {
    if (!previewUrl) {
      return (
        <>
          {/* sr-only 而不是 hidden:鍵盤 Tab 得到,按 Enter／空白鍵一樣能開選檔 */}
          <input
            id="menu-upload"
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="peer sr-only"
          />
          {/* label 本身就是卡片(外框、底色、陰影、內距跟 <Card> 一樣),外框和內距那一圈也點得到 ——
              不要再包一層 <Card>,那圈內距會變成點了沒反應的死區 */}
          <label
            htmlFor="menu-upload"
            className="group block cursor-pointer rounded-lg border bg-card p-4 text-card-foreground shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-ring sm:p-6"
          >
            <span className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary/30 px-4 py-10 text-center transition-colors group-hover:border-primary/60 group-hover:bg-accent/40 sm:py-14">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                <Upload className="h-7 w-7 text-primary" />
              </span>
              <span className="text-lg font-semibold">上傳菜單照片</span>
              <span className="text-sm text-muted-foreground">AI 會列出要採購的食材</span>
            </span>
          </label>
        </>
      );
    }

    return (
      <Card className="p-4 sm:p-6">
        <div className="space-y-4">
          <img
            src={previewUrl}
            alt="菜單預覽"
            className="max-h-72 w-full rounded-lg bg-muted object-contain sm:max-h-96"
          />
          <div className="flex gap-2">
            <Button variant="outline" size="lg" className="px-4" onClick={clearSelection} disabled={isUploading}>
              換一張
            </Button>
            <Button size="lg" className="flex-1" onClick={handleAnalyze} disabled={isUploading}>
              {isUploading ? (
                <>
                  <Loader2 className="animate-spin" />
                  AI 辨識中…
                </>
              ) : (
                "開始分析"
              )}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <section id="upload-section" className="py-24">
      <div className="container px-4 mx-auto">
        <div className="max-w-4xl mx-auto space-y-8">
          <div className="text-center space-y-4">
            <h2 className="text-4xl md:text-5xl font-bold">
              {t('upload.title')}
            </h2>
            <p className="text-xl text-muted-foreground">
              {t('upload.subtitle')}
            </p>
          </div>

          <Card className="p-8 md:p-12 shadow-medium">
            {!previewUrl ? (
              <div className="space-y-6">
                <label htmlFor="menu-upload" className="cursor-pointer">
                  <div className="border-2 border-dashed border-primary/30 rounded-2xl p-12 hover:border-primary/60 hover:bg-accent/50 transition-all duration-300 text-center">
                    <div className="flex flex-col items-center space-y-4">
                      <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                        <Upload className="w-10 h-10 text-primary" />
                      </div>
                      <div className="space-y-2">
                        <p className="text-xl font-semibold">{t('upload.drag')}</p>
                        <p className="text-muted-foreground">{t('upload.or')}</p>
                        <Button variant="outline" size="lg" type="button">
                          <FileImage className="mr-2 h-5 w-5" />
                          {t('upload.select')}
                        </Button>
                        <p className="text-sm text-muted-foreground">{t('upload.support')}</p>
                      </div>
                    </div>
                  </div>
                </label>
                <input
                  id="menu-upload"
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>
            ) : (
              <div className="space-y-6">
                <div className="relative rounded-xl overflow-hidden">
                  <img 
                    src={previewUrl} 
                    alt="Menu preview" 
                    className="w-full h-auto max-h-[500px] object-contain bg-muted"
                  />
                  <div className="absolute top-4 right-4">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setSelectedFile(null);
                        setPreviewUrl("");
                      }}
                    >
                      {t('upload.remove')}
                    </Button>
                  </div>
                </div>

                <div className="flex items-center space-x-3 p-4 bg-accent rounded-lg">
                  <FileImage className="w-6 h-6 text-primary" />
                  <div className="flex-1">
                    <p className="font-medium">{selectedFile?.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {((selectedFile?.size || 0) / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                </div>

                <Button
                  variant="hero"
                  size="lg"
                  className="w-full text-lg py-6"
                  onClick={handleAnalyze}
                  disabled={isUploading}
                >
                  {isUploading ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      {t('upload.analyzing')}
                    </>
                  ) : (
                    t('upload.analyze')
                  )}
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
};

export default MenuUpload;
