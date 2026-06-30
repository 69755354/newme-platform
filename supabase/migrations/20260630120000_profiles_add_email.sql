-- ================================================
-- profiles 表增加 email 列 + 自动同步 auth.users
-- MoA 审计结论 R1 修正：业务优先，冗余可控
-- ================================================

-- 1. 加列
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS email TEXT;

-- 2. 回填现有数据
UPDATE profiles p
  SET email = u.email
  FROM auth.users u
  WHERE p.id = u.id
    AND (p.email IS NULL OR p.email = '');

-- 3. 唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email
  ON profiles(email) WHERE email IS NOT NULL AND email != '';

-- 4. Trigger: auth.users email 变更时自动同步到 profiles
CREATE OR REPLACE FUNCTION sync_user_email_to_profile()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles SET email = NEW.email WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 先删旧 trigger（如果存在）
DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;

CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION sync_user_email_to_profile();

-- 5. RLS: email 列跟随现有 profiles RLS 策略，无需额外策略
