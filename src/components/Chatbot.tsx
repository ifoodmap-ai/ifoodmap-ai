import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Send, Bot, User, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { analyzeChat, chatReply, formatIngredient, friendlyAiError } from "@/lib/api";
import { track } from "@/lib/analytics";
import type { AnalysisMeta } from "@/components/MenuUpload";

/** 對話整理出來的採購需求(= onRequirementsSubmit 的兩個參數) */
interface ChatResult {
  requirements: string[];
  meta: AnalysisMeta;
}

interface Message {
  id: number;
  text: string;
  sender: "user" | "bot";
  timestamp: Date;
  /** 只有 panel 版傳了 resultAction 時才會有:這則訊息畫成結果卡 */
  result?: ChatResult;
}

interface ChatbotProps {
  onRequirementsSubmit?: (requirements: string[], meta: AnalysisMeta) => void;
  /**
   * 外觀。對話邏輯兩種都一樣,只有外框不同:
   * - "card"(預設):整段區塊 —— 大標題 + 卡片外框 + 卡片內標題列。訪客首頁 Index.tsx 用這個,
   *   不傳 variant 時的輸出由 Chatbot.test.tsx 的快照鎖住,不能變。
   * - "panel":放進 AI 小助手泡泡(AIAssistantBubble)的面板裡。面板自己有標題列,所以這裡
   *   拿掉外框與重複標題、高度撐滿父層,配色跟形象站的 AI 泡泡一致。
   */
  variant?: "card" | "panel";
  /**
   * 開場白(第一則 AI 訊息)。不傳 = 字典的 chat.welcome —— 訪客首頁與餐廳版泡泡都不傳。
   * 管理員版泡泡是純對話、不交接,原本那句「幫您找到合適的供應商」對它不成立,才另外傳一句。
   */
  greeting?: string;
  /** 使用者每送出一句話時通知一聲(泡泡用來記下「送出時在哪一頁」) */
  onSend?: () => void;
  /**
   * 只給 panel 版用:整理出需求後,在對話裡放一張結果卡(取代「正在為您媒合供應商…」那句),
   * 卡上的主按鈕要做什麼由呼叫端決定 —— 不會自己跳走。onRequirementsSubmit 照樣會被呼叫。
   */
  resultAction?: { label: string; onClick: (requirements: string[], meta: AnalysisMeta) => void };
}

// panel 版新增的無障礙標籤,字典裡沒有對應的 key(字典檔不在這次改動範圍),先放這裡
const PANEL_INPUT_LABEL = { zh: "輸入食材需求", en: "Describe the ingredients you need" } as const;

/** 結果卡的摘要:「已整理 3 項食材：牛肉 5kg、洋蔥 3kg、青蔥」,超過 3 項只列前 3 項再加「…」 */
const summarizeResult = (requirements: string[]) =>
  `已整理 ${requirements.length} 項食材：${requirements.slice(0, 3).join("、")}${requirements.length > 3 ? "…" : ""}`;

const Chatbot = ({
  onRequirementsSubmit,
  variant = "card",
  greeting,
  onSend,
  resultAction,
}: ChatbotProps) => {
  const { t, language } = useLanguage();

  const [messages, setMessages] = useState<Message[]>([
    {
      id: 1,
      text: greeting ?? t('chat.welcome'),
      sender: "bot",
      timestamp: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 元件還在嗎?AI 回得慢時使用者可能已經換頁、登出、切到別的後台(Chatbot 被卸載),
  // 那之後什麼都不做:不再 setState、不再擷取需求,也不再呼叫 onRequirementsSubmit。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scrollToBottom = () => {
    // listRef 只有 panel 版會掛上。panel 在固定定位的泡泡面板裡,只捲訊息列表自己 ——
    // scrollIntoView 會連外層頁面一起捲,把使用者正在看的分析結果拉走(面板收著時也一樣)。
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  const pushBotMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: Date.now() + Math.random(), text, sender: "bot", timestamp: new Date() },
    ]);
  };

  // text 是之後送給 AI 的對話內容(完整清單);畫面上畫成結果卡
  const pushResultMessage = (requirements: string[], meta: AnalysisMeta) => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        text: `已為您整理出採購需求:\n${requirements.join("\n")}`,
        sender: "bot",
        timestamp: new Date(),
        result: { requirements, meta },
      },
    ]);
  };

  // Detect when the customer wants us to start supplier matching.
  const wantsMatching = (msg: string) => {
    const lower = msg.toLowerCase();
    return [
      "find", "supplier", "match", "quote",
      "尋找", "供應商", "媒合", "報價", "採購", "下單",
    ].some((kw) => lower.includes(kw));
  };

  const respond = async (history: Message[], userMessage: string) => {
    setIsTyping(true);

    const apiMessages = history.map((m) => ({ role: m.sender, text: m.text }));

    try {
      // Real conversational reply from Gemini.
      const { reply } = await chatReply(apiMessages);
      if (!mountedRef.current) return;
      if (reply) pushBotMessage(reply);

      // If the customer is ready to match suppliers, extract requirements via AI
      // (this also creates a pending analysis record for admin review).
      if (wantsMatching(userMessage) && onRequirementsSubmit) {
        track("analysis_started", { source: "chat" });
        const result = await analyzeChat(apiMessages);
        if (!mountedRef.current) return;
        if (result.ingredients.length > 0) {
          track("analysis_completed", { source: "chat", count: result.ingredients.length });
          const formatted = result.ingredients.map(formatIngredient);
          const meta: AnalysisMeta = {
            analysisId: result.analysisId,
            names: result.ingredients.map((i) => i.name),
          };
          if (variant === "panel" && resultAction) {
            pushResultMessage(formatted, meta);
          } else {
            pushBotMessage(`已為您整理出採購需求:\n${formatted.join("\n")}\n\n正在為您媒合供應商…`);
          }
          onRequirementsSubmit(formatted, meta);
        }
      }
    } catch (error) {
      if (!mountedRef.current) return;
      // 用量上限這類有錯誤碼的 → 只講白話(例如「今天的 AI 使用次數已達上限,請明天再試」),不露技術細節
      const friendly = friendlyAiError(error);
      if (friendly) {
        pushBotMessage(friendly);
        toast.error(friendly);
        return;
      }
      const message = error instanceof Error ? error.message : "AI 服務暫時無法使用";
      pushBotMessage(`抱歉,AI 服務暫時無法回覆,請稍後再試。(${message})`);
      toast.error(`AI 對話失敗:${message}`);
    } finally {
      if (mountedRef.current) setIsTyping(false);
    }
  };

  const handleSend = () => {
    if (!inputValue.trim() || isTyping) return;

    const userMessage: Message = {
      id: Date.now(),
      text: inputValue,
      sender: "user",
      timestamp: new Date(),
    };

    const history = [...messages, userMessage];
    setMessages(history);
    setInputValue("");
    onSend?.();
    void respond(history, userMessage.text);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (variant === "panel") {
    // 配色取自形象站 AI 泡泡(ifoodmap-landing 的 .ai-body / .ai-bub / .ai-foot)。
    // 使用者泡泡用綠底深字:原本的橘底白字對比只有約 2:1,讀不清楚。
    return (
      <div className="flex h-full min-h-0 flex-col bg-white">
        <div
          ref={listRef}
          role="log"
          aria-live="polite"
          aria-label={t('chat.title')}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain bg-[#f6f9f5] p-4"
        >
          {messages.map((message) =>
            message.result ? (
              <ResultCard
                key={message.id}
                result={message.result}
                timestamp={message.timestamp}
                action={resultAction}
              />
            ) : (
              <div
                key={message.id}
                className={`flex ${message.sender === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[88%] rounded-[15px] px-3.5 py-2.5 ${
                    message.sender === "user"
                      ? "rounded-tr-[5px] bg-gradient-to-br from-[#46c138] to-[#1f9e4e] text-[#0E1A14]"
                      : "rounded-tl-[5px] border border-[#e8efe6] bg-white text-[#1d2b22]"
                  }`}
                >
                  <p className="text-sm leading-relaxed whitespace-pre-line break-words">{message.text}</p>
                  <p
                    className={`mt-1 text-[11px] leading-none ${
                      message.sender === "user" ? "text-[#0E1A14]" : "text-slate-500"
                    }`}
                  >
                    {message.timestamp.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            ),
          )}

          {isTyping && (
            <div className="flex justify-start">
              <div className="rounded-[15px] rounded-tl-[5px] border border-[#e8efe6] bg-white px-3.5 py-3">
                <span className="sr-only">{t('chat.analyzing')}</span>
                <div aria-hidden="true" className="flex gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9bbf8f] animate-pulse motion-reduce:animate-none" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9bbf8f] animate-pulse [animation-delay:200ms] motion-reduce:animate-none" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9bbf8f] animate-pulse [animation-delay:400ms] motion-reduce:animate-none" />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[#eef1ee] bg-white p-2.5">
          <div className="flex items-center gap-2">
            <Input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={t('chat.placeholder')}
              aria-label={PANEL_INPUT_LABEL[language === "en" ? "en" : "zh"]}
              className="h-11 flex-1 rounded-full border-[#dde5dc] px-4 focus-visible:ring-[#1f9e4e] focus-visible:ring-offset-0"
            />
            <Button
              type="button"
              // 送出後輸入框清空、按鈕變 disabled,焦點會掉到 body(手機的焦點陷阱也跟著失效),
              // 所以按完把焦點放回輸入框,讓人可以接著打字。
              onClick={() => {
                handleSend();
                inputRef.current?.focus();
              }}
              disabled={!inputValue.trim()}
              aria-label={t('chat.send')}
              className="h-11 w-11 shrink-0 rounded-full bg-gradient-to-br from-[#46c138] to-[#1f9e4e] p-0 text-[#0E1A14] hover:brightness-105 focus-visible:ring-[#0B6B40] [&_svg]:size-[18px]"
            >
              <Send aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="py-16 bg-background">
      <div className="container px-4 mx-auto">
        <div className="max-w-4xl mx-auto">
          <div className="text-center space-y-4 mb-8">
            <h2 className="text-4xl md:text-5xl font-bold">
              {t('chat.title')}
            </h2>
            <p className="text-xl text-muted-foreground">
              {t('chat.subtitle')}
            </p>
          </div>

          <Card className="overflow-hidden shadow-medium">
            <div className="bg-primary/5 p-4 border-b border-border">
              <div className="flex items-center space-x-2">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <Bot className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold">{t('chat.title')}</h3>
                  <p className="text-xs text-muted-foreground">{t('chat.online')}</p>
                </div>
              </div>
            </div>

            <div className="h-[500px] overflow-y-auto p-4 space-y-4 bg-muted/10">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex items-start space-x-2 ${
                    message.sender === "user" ? "flex-row-reverse space-x-reverse" : ""
                  }`}
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                      message.sender === "user"
                        ? "bg-secondary/20"
                        : "bg-primary/10"
                    }`}
                  >
                    {message.sender === "user" ? (
                      <User className="w-5 h-5 text-secondary" />
                    ) : (
                      <Bot className="w-5 h-5 text-primary" />
                    )}
                  </div>
                  <div
                    className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                      message.sender === "user"
                        ? "bg-secondary text-secondary-foreground rounded-tr-none"
                        : "bg-primary/10 text-foreground rounded-tl-none"
                    }`}
                  >
                    <p className="text-sm whitespace-pre-line">{message.text}</p>
                    <p className="text-xs opacity-60 mt-1">
                      {message.timestamp.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              ))}
              
              {isTyping && (
                <div className="flex items-start space-x-2">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <Bot className="w-5 h-5 text-primary" />
                  </div>
                  <div className="bg-primary/10 rounded-2xl rounded-tl-none px-4 py-3">
                    <div className="flex space-x-1">
                      <div className="w-2 h-2 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <div className="w-2 h-2 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <div className="w-2 h-2 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
              
              <div ref={messagesEndRef} />
            </div>

            <div className="p-4 border-t border-border bg-background">
              <div className="flex space-x-2">
                <Input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder={t('chat.placeholder')}
                  className="flex-1"
                />
                <Button
                  onClick={handleSend}
                  disabled={!inputValue.trim()}
                  className="bg-primary hover:bg-primary/90"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
};

/** panel 版的結果卡:整理好的食材摘要 + 呼叫端給的主按鈕(按了才動作,不會自己跳走) */
const ResultCard = ({
  result,
  timestamp,
  action,
}: {
  result: ChatResult;
  timestamp: Date;
  action?: ChatbotProps["resultAction"];
}) => (
  <div className="flex justify-start">
    <div className="w-full max-w-[88%] rounded-[15px] rounded-tl-[5px] border border-[#cdeec0] bg-white px-3.5 py-3 text-[#1d2b22]">
      <p className="text-sm font-semibold leading-relaxed break-words">{summarizeResult(result.requirements)}</p>
      {action && (
        <button
          type="button"
          onClick={() => action.onClick(result.requirements, result.meta)}
          className="mt-2.5 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-gradient-to-br from-[#46c138] to-[#1f9e4e] px-4 text-[13.5px] font-bold text-[#0E1A14] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B6B40] focus-visible:ring-offset-2 motion-reduce:transition-none"
        >
          {action.label}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </button>
      )}
      <p className="mt-2 text-[11px] leading-none text-slate-500">
        {timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </p>
    </div>
  </div>
);

export default Chatbot;
