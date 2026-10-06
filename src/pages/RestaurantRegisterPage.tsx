import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type RefObject,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  BarChart3,
  Check,
  ClipboardCheck,
  Loader2,
  ShoppingBasket,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import PublicHeader from "@/components/PublicHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import {
  registerRestaurant,
  RestaurantRegistrationError,
  RestaurantRegistrationValidationError,
  validateRestaurantRegistration,
  type RegistrationErrors,
  type RestaurantRegistrationInput,
} from "@/lib/restaurant-registration";
import {
  captureHandoffFromUrl,
  readStoredHandoff,
} from "@/lib/landing-handoff";

/** 形象站帶著 AI 對話過來時的說明橫幅(文案業主指定) */
export const HANDOFF_BANNER_TEXT =
  "你跟 AI 採購助手聊的需求已經保存，註冊完成後會自動幫你建成一張採購單草稿";

const INITIAL_FORM: RestaurantRegistrationInput = {
  restaurantName: "",
  contactName: "",
  phone: "",
  email: "",
  password: "",
  confirmPassword: "",
  terms: false,
};

const FIELD_ORDER: (keyof RestaurantRegistrationInput)[] = [
  "restaurantName",
  "contactName",
  "phone",
  "email",
  "password",
  "confirmPassword",
  "terms",
];

type TextFieldName = Exclude<keyof RestaurantRegistrationInput, "terms">;
type SubmissionError =
  | "EMAIL_NOTICE"
  | "SESSION_EMAIL_MISMATCH"
  | "GENERIC"
  | null;

interface FormFieldProps {
  autoComplete: string;
  error?: string;
  inputRef: RefObject<HTMLInputElement>;
  label: string;
  name: TextFieldName;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  spellCheck?: boolean;
  type?: "email" | "password" | "tel" | "text";
  value: string;
}

const FormField = ({
  autoComplete,
  error,
  inputRef,
  label,
  name,
  onChange,
  spellCheck,
  type = "text",
  value,
}: FormFieldProps) => {
  const errorId = `${name}-error`;

  return (
    <div className="space-y-2">
      <Label htmlFor={name} className="text-slate-800">
        {label}
      </Label>
      <Input
        ref={inputRef}
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={onChange}
        spellCheck={spellCheck}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? errorId : undefined}
        className="h-11 border-slate-300 bg-white text-base focus-visible:ring-emerald-600 md:text-base"
      />
      {error ? (
        <p id={errorId} className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
};

const BENEFITS = [
  {
    icon: ShoppingBasket,
    title: "智慧採購",
    description: "快速媒合適合的食材與供應商，讓詢價與採購更有效率。",
  },
  {
    icon: BarChart3,
    title: "菜單成本",
    description: "掌握菜色與食材成本，建立更清楚的採購決策依據。",
  },
  {
    icon: ClipboardCheck,
    title: "訂單收貨",
    description: "集中追蹤訂單、收貨與交易履歷，減少人工對帳負擔。",
  },
] as const;

const RestaurantRegisterPage = () => {
  const navigate = useNavigate();
  const [form, setForm] =
    useState<RestaurantRegistrationInput>(INITIAL_FORM);
  const [fieldErrors, setFieldErrors] = useState<RegistrationErrors>({});
  const [submissionError, setSubmissionError] =
    useState<SubmissionError>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<
    keyof RestaurantRegistrationInput | null
  >(null);
  const submittingRef = useRef(false);
  const restaurantNameRef = useRef<HTMLInputElement>(null);
  const contactNameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const termsRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef<
    Record<
      keyof RestaurantRegistrationInput,
      RefObject<HTMLInputElement>
    >
  >({
    restaurantName: restaurantNameRef,
    contactName: contactNameRef,
    phone: phoneRef,
    email: emailRef,
    password: passwordRef,
    confirmPassword: confirmPasswordRef,
    terms: termsRef,
  });

  // 形象站的 AI 需求交接碼(#handoff=…)。一進頁面就撈出來存好、把片段從網址拿掉(SPEC §7);
  // 之前存過、還沒過期的也算(例如先去登入頁晃一圈又回來)。用 layout effect:畫面出來前網址就乾淨了。
  const [handoff, setHandoff] = useState<string | null>(null);
  useLayoutEffect(() => {
    setHandoff(captureHandoffFromUrl() ?? readStoredHandoff());
  }, []);

  const queueFirstError = (errors: RegistrationErrors) => {
    const firstInvalid = FIELD_ORDER.find((field) => errors[field]);
    setPendingFocus(firstInvalid ?? null);
  };

  useLayoutEffect(() => {
    if (!pendingFocus || !fieldErrors[pendingFocus]) return;
    fieldRefs.current[pendingFocus].current?.focus();
    setPendingFocus(null);
  }, [fieldErrors, pendingFocus]);

  const updateTextField = (event: ChangeEvent<HTMLInputElement>) => {
    const name = event.target.name as TextFieldName;
    setForm((current) => ({ ...current, [name]: event.target.value }));
    if (fieldErrors[name]) {
      setFieldErrors((current) => ({ ...current, [name]: undefined }));
    }
    setSubmissionError(null);
  };

  const updateTerms = (event: ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, terms: event.target.checked }));
    if (fieldErrors.terms) {
      setFieldErrors((current) => ({ ...current, terms: undefined }));
    }
    setSubmissionError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const errors = validateRestaurantRegistration(form);
    setSubmissionError(null);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      queueFirstError(errors);
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);

    try {
      // 交接碼跟著 signUp 寄放進 user_metadata(換裝置開確認信也能認領);沒有就照舊只傳表單
      const pendingHandoff = handoff ?? readStoredHandoff();
      if (pendingHandoff) {
        await registerRestaurant(supabase, form, { handoff: pendingHandoff });
      } else {
        await registerRestaurant(supabase, form);
      }
      toast.success("餐廳帳號已建立", {
        description: "歡迎加入 iFoodmap，現在開始設定你的採購流程。",
      });
      navigate("/restaurant", { replace: true });
    } catch (error) {
      setForm((current) => ({
        ...current,
        password: "",
        confirmPassword: "",
      }));

      if (error instanceof RestaurantRegistrationValidationError) {
        setFieldErrors(error.fieldErrors);
        queueFirstError(error.fieldErrors);
      } else if (
        error instanceof RestaurantRegistrationError &&
        (error.code === "EMAIL_EXISTS" ||
          error.code === "EMAIL_CONFIRMATION_REQUIRED")
      ) {
        setSubmissionError("EMAIL_NOTICE");
      } else if (
        error instanceof RestaurantRegistrationError &&
        error.code === "SESSION_EMAIL_MISMATCH"
      ) {
        setSubmissionError("SESSION_EMAIL_MISMATCH");
      } else {
        setSubmissionError("GENERIC");
      }
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-gradient-to-b from-emerald-50/70 via-white to-slate-50 px-4 text-slate-900 sm:px-6">
      <PublicHeader className="pt-3 sm:pt-4" />
      <main className="mx-auto grid w-full max-w-6xl gap-8 py-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-14 lg:py-12">
        <section className="mx-auto w-full max-w-xl lg:mx-0">
          <div>
            <p className="text-sm font-semibold tracking-wide text-emerald-700">
              餐廳採購，從今天開始更簡單
            </p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              建立餐廳帳號
            </h1>
            <p className="mt-4 max-w-lg text-base leading-7 text-slate-600">
              一次整合食材媒合、成本掌握與訂單管理，立即建立專屬於餐廳的採購工作台。
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {BENEFITS.map(({ icon: Icon, title, description }) => (
              <div
                key={title}
                className="flex gap-4 rounded-xl border border-emerald-100 bg-white/80 p-4 shadow-sm"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="font-semibold text-slate-900">{title}</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <Card className="mx-auto w-full max-w-2xl border-slate-200 bg-white p-5 shadow-xl shadow-slate-900/5 sm:p-8">
          {handoff ? (
            <Alert
              role="status"
              data-testid="handoff-banner"
              className="mb-5 border-emerald-200 bg-emerald-50 text-emerald-950"
            >
              <Sparkles className="h-4 w-4 !text-emerald-700" aria-hidden="true" />
              <AlertDescription className="leading-6">
                {HANDOFF_BANNER_TEXT}
              </AlertDescription>
            </Alert>
          ) : null}
          <form noValidate onSubmit={handleSubmit} className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                inputRef={restaurantNameRef}
                name="restaurantName"
                label="餐廳名稱"
                autoComplete="organization"
                value={form.restaurantName}
                error={fieldErrors.restaurantName}
                onChange={updateTextField}
              />
              <FormField
                inputRef={contactNameRef}
                name="contactName"
                label="聯絡人姓名"
                autoComplete="name"
                value={form.contactName}
                error={fieldErrors.contactName}
                onChange={updateTextField}
              />
              <FormField
                inputRef={phoneRef}
                name="phone"
                label="聯絡電話"
                type="tel"
                autoComplete="tel"
                value={form.phone}
                error={fieldErrors.phone}
                onChange={updateTextField}
              />
              <FormField
                inputRef={emailRef}
                name="email"
                label="Email"
                type="email"
                autoComplete="email"
                spellCheck={false}
                value={form.email}
                error={fieldErrors.email}
                onChange={updateTextField}
              />
              <FormField
                inputRef={passwordRef}
                name="password"
                label="密碼"
                type="password"
                autoComplete="new-password"
                value={form.password}
                error={fieldErrors.password}
                onChange={updateTextField}
              />
              <FormField
                inputRef={confirmPasswordRef}
                name="confirmPassword"
                label="確認密碼"
                type="password"
                autoComplete="new-password"
                value={form.confirmPassword}
                error={fieldErrors.confirmPassword}
                onChange={updateTextField}
              />
            </div>

            <div>
              {/* 保持純文字，待正式服務條款文件與網址核准後再加連結。 */}
              <label
                htmlFor="terms"
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md text-sm leading-6 text-slate-700 focus-within:ring-2 focus-within:ring-emerald-600 focus-within:ring-offset-2"
              >
                <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
                  <input
                    ref={termsRef}
                    id="terms"
                    name="terms"
                    type="checkbox"
                    checked={form.terms}
                    onChange={updateTerms}
                    aria-invalid={fieldErrors.terms ? "true" : "false"}
                    aria-describedby={
                      fieldErrors.terms ? "terms-error" : undefined
                    }
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="flex h-5 w-5 items-center justify-center rounded border border-slate-400 bg-white text-white peer-checked:border-emerald-700 peer-checked:bg-emerald-700 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-600 peer-focus-visible:ring-offset-2"
                  >
                    {form.terms ? <Check className="h-4 w-4" /> : null}
                  </span>
                </span>
                <span>同意服務條款</span>
              </label>
              {fieldErrors.terms ? (
                <p
                  id="terms-error"
                  className="ml-14 text-sm font-medium text-red-700"
                >
                  {fieldErrors.terms}
                </p>
              ) : null}
            </div>

            {submissionError === "EMAIL_NOTICE" ? (
              <Alert
                aria-labelledby="email-notice-title"
                className="border-amber-300 bg-amber-50 text-amber-950"
              >
                <AlertCircle className="h-4 w-4" />
                <AlertTitle id="email-notice-title">請確認你的 Email</AlertTitle>
                <AlertDescription>
                  如果此 Email 可用，我們會寄送確認資訊；若已有帳號，請直接
                  <Link
                    to="/"
                    className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-800"
                  >
                    登入平台
                  </Link>
                  。
                </AlertDescription>
              </Alert>
            ) : null}

            {submissionError === "SESSION_EMAIL_MISMATCH" ? (
              <Alert
                aria-labelledby="session-mismatch-title"
                className="border-amber-300 bg-amber-50 text-amber-950"
              >
                <AlertCircle className="h-4 w-4" />
                <AlertTitle id="session-mismatch-title">
                  目前登入的帳號不同
                </AlertTitle>
                <AlertDescription>
                  請改用目前帳號的 Email，或
                  <Link
                    to="/"
                    className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-800"
                  >
                    前往平台
                  </Link>
                  登出後再重新註冊。
                </AlertDescription>
              </Alert>
            ) : null}

            {submissionError === "GENERIC" ? (
              <Alert
                variant="destructive"
                aria-live="polite"
                className="border-red-200 bg-red-50"
              >
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>暫時無法建立帳號</AlertTitle>
                <AlertDescription>
                  帳號建立未完成，請稍後再試或聯絡客服協助。
                </AlertDescription>
              </Alert>
            ) : null}

            <Button
              type="submit"
              disabled={isSubmitting}
              className="h-12 w-full bg-emerald-700 text-base font-semibold text-white hover:bg-emerald-800 focus-visible:ring-emerald-600"
            >
              {isSubmitting ? (
                <>
                  <Loader2
                    className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  正在建立帳號…
                </>
              ) : (
                "建立餐廳帳號"
              )}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-600">
            已有帳號？{" "}
            <Link
              to="/"
              className="inline-flex min-h-11 items-center font-semibold text-emerald-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
            >
              登入平台
            </Link>
          </p>
        </Card>
      </main>
    </div>
  );
};

export default RestaurantRegisterPage;
