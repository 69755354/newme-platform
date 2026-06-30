-- ============================================================
-- Activity Tracking — 用户操作事件留存
-- 2026-06-12
-- ============================================================

-- 用户活动日志表
CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  user_id UUID NOT NULL REFERENCES profiles(id),
  action TEXT NOT NULL,           -- login, logout, page_view, create, update, delete, approve, reject, convert, assign
  entity_type TEXT,               -- lead, quotation, contract, payment, customer, project, kpi_target
  entity_id UUID,
  details JSONB,                  -- 变更详情: {field, old_value, new_value, ...}
  ip_address INET,
  user_agent TEXT,
  session_id TEXT,                 -- 前端 session 标识
  page_path TEXT,                  -- 访问页面路径
  duration_seconds INTEGER,        -- 页面停留时长(秒)
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant ON activity_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON activity_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at);

-- 用户会话汇总表（每日聚合）
CREATE TABLE IF NOT EXISTS user_session_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  user_id UUID NOT NULL REFERENCES profiles(id),
  session_date DATE NOT NULL DEFAULT CURRENT_DATE,
  first_login TIMESTAMPTZ,        -- 当天首次登录
  last_active TIMESTAMPTZ,        -- 最后活跃时间
  total_duration_seconds INTEGER DEFAULT 0,  -- 总在线时长
  login_count INTEGER DEFAULT 0,  -- 登录次数
  pages_viewed INTEGER DEFAULT 0, -- 浏览页面数
  actions_count INTEGER DEFAULT 0,-- 操作次数
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_user_session_daily_user_date ON user_session_daily(user_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_user_session_daily_tenant ON user_session_daily(tenant_id);

-- RLS
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_session_daily ENABLE ROW LEVEL SECURITY;

-- boss/admin 看全部，sales 看自己
CREATE POLICY "boss_admin_see_all_activity" ON activity_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('boss', 'admin'))
  );
CREATE POLICY "sales_see_own_activity" ON activity_logs
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "boss_admin_see_all_sessions" ON user_session_daily
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('boss', 'admin'))
  );
CREATE POLICY "sales_see_own_sessions" ON user_session_daily
  FOR SELECT USING (user_id = auth.uid());

-- 插入活动日志的 RPC（前端调用）
CREATE OR REPLACE FUNCTION log_activity(
  p_action TEXT,
  p_entity_type TEXT DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_details JSONB DEFAULT NULL,
  p_page_path TEXT DEFAULT NULL,
  p_duration_seconds INTEGER DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_user_id UUID;
  v_tenant_id UUID;
  v_result UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_user_id;

  INSERT INTO activity_logs (tenant_id, user_id, action, entity_type, entity_id, details, page_path, duration_seconds)
  VALUES (COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'), v_user_id, p_action, p_entity_type, p_entity_id, p_details, p_page_path, p_duration_seconds)
  RETURNING id INTO v_result;

  -- 更新每日汇总
  INSERT INTO user_session_daily (tenant_id, user_id, session_date, first_login, last_active, actions_count)
  VALUES (
    COALESCE(v_tenant_id, '00000000-0000-0000-0000-000000000000'),
    v_user_id,
    CURRENT_DATE,
    CASE WHEN p_action = 'login' THEN now() ELSE NULL END,
    now(),
    1
  )
  ON CONFLICT (user_id, session_date) DO UPDATE SET
    first_login = COALESCE(user_session_daily.first_login, EXCLUDED.first_login),
    last_active = now(),
    login_count = user_session_daily.login_count + CASE WHEN p_action = 'login' THEN 1 ELSE 0 END,
    actions_count = user_session_daily.actions_count + 1,
    pages_viewed = user_session_daily.pages_viewed + CASE WHEN p_action = 'page_view' THEN 1 ELSE 0 END,
    updated_at = now();

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 查询团队活动汇总 RPC
CREATE OR REPLACE FUNCTION get_team_activity(
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  role TEXT,
  first_login TIMESTAMPTZ,
  last_active TIMESTAMPTZ,
  total_duration_seconds INTEGER,
  login_count INTEGER,
  pages_viewed INTEGER,
  actions_count INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    us.user_id,
    p.full_name,
    p.role,
    us.first_login,
    us.last_active,
    us.total_duration_seconds,
    us.login_count,
    us.pages_viewed,
    us.actions_count
  FROM user_session_daily us
  JOIN profiles p ON us.user_id = p.id
  WHERE us.session_date = p_date
  ORDER BY
    CASE p.role
      WHEN 'boss' THEN 1
      WHEN 'admin' THEN 2
      WHEN 'sales' THEN 3
      ELSE 4
    END,
    p.full_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
