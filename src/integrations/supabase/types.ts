export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      // 以下三張表 2026-10-07 手動補上(欄位照正式庫 information_schema + 形象站 AI 防濫用 migration 新增的欄位:
      // ai_usage.tier / thoughts_tokens、analysis_records.claim_token_hash / claimed_*、landing_leads.contact_email)。
      // 既有頁面仍沿用 loose cast 慣例;新程式可以直接用型別。
      ai_usage: {
        Row: {
          action: string
          completion_tokens: number | null
          created_at: string
          error: string | null
          id: string
          latency_ms: number | null
          model: string | null
          ok: boolean
          prompt_tokens: number | null
          thoughts_tokens: number | null
          tier: string | null
        }
        Insert: {
          action: string
          completion_tokens?: number | null
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          model?: string | null
          ok?: boolean
          prompt_tokens?: number | null
          thoughts_tokens?: number | null
          tier?: string | null
        }
        Update: {
          action?: string
          completion_tokens?: number | null
          created_at?: string
          error?: string | null
          id?: string
          latency_ms?: number | null
          model?: string | null
          ok?: boolean
          prompt_tokens?: number | null
          thoughts_tokens?: number | null
          tier?: string | null
        }
        Relationships: []
      }
      analysis_records: {
        Row: {
          admin_notes: string | null
          claim_token_hash: string | null
          claimed_at: string | null
          claimed_order_id: string | null
          claimed_restaurant_id: string | null
          created_at: string
          id: string
          images: Json | null
          ingredient_list: Json
          messages: Json | null
          reviewed_at: string | null
          reviewed_by: string | null
          source_id: string | null
          source_type: string
          status: string
          summary: string | null
          transcript: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          admin_notes?: string | null
          claim_token_hash?: string | null
          claimed_at?: string | null
          claimed_order_id?: string | null
          claimed_restaurant_id?: string | null
          created_at?: string
          id?: string
          images?: Json | null
          ingredient_list?: Json
          messages?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_id?: string | null
          source_type: string
          status?: string
          summary?: string | null
          transcript?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          admin_notes?: string | null
          claim_token_hash?: string | null
          claimed_at?: string | null
          claimed_order_id?: string | null
          claimed_restaurant_id?: string | null
          created_at?: string
          id?: string
          images?: Json | null
          ingredient_list?: Json
          messages?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_id?: string | null
          source_type?: string
          status?: string
          summary?: string | null
          transcript?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      landing_leads: {
        Row: {
          analysis_id: string | null
          company_name: string | null
          contact_email: string | null
          contact_line: string | null
          contact_phone: string | null
          created_at: string
          detail: string | null
          id: string
          items_text: string | null
          source: string
          status: string
          user_agent: string | null
        }
        Insert: {
          analysis_id?: string | null
          company_name?: string | null
          contact_email?: string | null
          contact_line?: string | null
          contact_phone?: string | null
          created_at?: string
          detail?: string | null
          id?: string
          items_text?: string | null
          source?: string
          status?: string
          user_agent?: string | null
        }
        Update: {
          analysis_id?: string | null
          company_name?: string | null
          contact_email?: string | null
          contact_line?: string | null
          contact_phone?: string | null
          created_at?: string
          detail?: string | null
          id?: string
          items_text?: string | null
          source?: string
          status?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      inquiries: {
        Row: {
          created_at: string
          id: string
          message: string | null
          products: Json
          status: string
          supplier_id: number
          supplier_name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message?: string | null
          products: Json
          status?: string
          supplier_id: number
          supplier_name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string | null
          products?: Json
          status?: string
          supplier_id?: number
          supplier_name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      // 形象站 AI 對話 → 採購單草稿的認領(SPEC §6、修訂 2 R2)。一律回 200,用 ok / reason 表達結果:
      //   { ok: true, order_id: uuid | null, already: boolean } | { ok: false, reason: "invalid" | "no_restaurant" | "expired_or_used" }
      // p_restaurant_id:有帶 → 呼叫者必須是那家店的 accepted 成員,不是就 no_restaurant;沒帶 → 最近 accepted 的那家。
      // 產品站一律帶目前畫面上那家店。
      claim_landing_analysis: {
        Args: {
          p_handoff: string
          p_restaurant_id?: string | null
        }
        Returns: Json
      }
      create_restaurant_onboarding: {
        Args: {
          p_contact_name?: string | null
          p_contact_phone?: string | null
          p_name: string
        }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
