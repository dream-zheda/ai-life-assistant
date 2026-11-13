-- ============================================================
-- 演示数据：一个用户、一份档案、两个目标、一条固定安排。
-- 幂等：重复执行不会报错，也不会产生重复行。
-- 用法：pnpm db:seed
--
-- ⚠️ demo-user 不是可登录账号（没有 account/password 记录）。
-- 认证已接入 Better Auth，要登录请走 /sign-up 注册。
-- 这里的种子数据只用于「数据库里有点东西可看」的本地观察/调试。
-- ============================================================

INSERT INTO "users" (id, email, name, "timeZone", "updatedAt")
VALUES ('demo-user', 'demo@example.com', '演示用户', 'Asia/Shanghai', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "profiles" (id, "userId", "rawInput", version, "updatedAt")
VALUES (
  'demo-profile',
  'demo-user',
  '我是大学生，白天有课，晚上容易打游戏到很晚。想提高英语听力，也想规律运动。希望保留娱乐时间，别把日程排太满。',
  1,
  now()
)
ON CONFLICT ("userId") DO NOTHING;

INSERT INTO "goals" (id, "userId", title, description, priority, state, "updatedAt")
VALUES
  ('demo-goal-1', 'demo-user', '提高英语听力', '每天至少 20 分钟精听', 1, 'ACTIVE', now()),
  ('demo-goal-2', 'demo-user', '规律运动', '每周至少三次，每次 30 分钟', 2, 'ACTIVE', now())
ON CONFLICT (id) DO NOTHING;

-- 2026-11-03 是周二；这条约束只在周二生效（用来验证"指定星期"逻辑）
INSERT INTO "fixed_constraints"
  (id, "userId", kind, title, weekday, "startTime", "endTime", "timeZone", "updatedAt")
VALUES
  ('demo-fc-1', 'demo-user', 'WEEKLY', '高数课', 2, '08:30', '10:00', 'Asia/Shanghai', now()),
  ('demo-fc-2', 'demo-user', 'WEEKLY', '英语角', 4, '19:00', '20:30', 'Asia/Shanghai', now())
ON CONFLICT (id) DO NOTHING;
