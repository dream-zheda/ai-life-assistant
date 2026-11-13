-- ============================================================
-- 约束验证：不是"迁移跑通"就算数，要证明坏数据真的插不进去。
-- 用法：node scripts/dev-db.mjs sql scripts/verify-constraints.sql
-- 任何一条断言失败都会抛异常并中止。
-- ============================================================

DO $$
DECLARE
  uid text := 'verify-user';
BEGIN
  INSERT INTO "users" (id, email, "updatedAt")
  VALUES (uid, 'verify@example.com', now());

  -- 1) 同一天只能有一个 ACTIVE 计划版本
  INSERT INTO "plan_versions" (id, "userId", "localDate", "timeZone", version, state)
  VALUES ('pv-1', uid, '2026-11-03', 'Asia/Shanghai', 1, 'ACTIVE');

  BEGIN
    INSERT INTO "plan_versions" (id, "userId", "localDate", "timeZone", version, state)
    VALUES ('pv-2', uid, '2026-11-03', 'Asia/Shanghai', 2, 'ACTIVE');
    RAISE EXCEPTION 'ASSERT FAILED: 第二个 ACTIVE 计划版本竟然插入成功';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ASSERT OK: plan_versions_one_active_per_day 生效';
  END;

  -- 2) WEEKLY 约束必须有 weekday
  BEGIN
    INSERT INTO "fixed_constraints"
      (id, "userId", kind, title, "startTime", "endTime", "timeZone", "updatedAt")
    VALUES ('fc-bad', uid, 'WEEKLY', '缺 weekday 的坏约束', '09:00', '10:00', 'Asia/Shanghai', now());
    RAISE EXCEPTION 'ASSERT FAILED: WEEKLY 缺少 weekday 竟然插入成功';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ASSERT OK: fixed_constraints_shape_check 生效';
  END;

  -- 3) 本地时刻必须是 HH:mm
  BEGIN
    INSERT INTO "fixed_constraints"
      (id, "userId", kind, title, weekday, "startTime", "endTime", "timeZone", "updatedAt")
    VALUES ('fc-time', uid, 'WEEKLY', '时间格式错误', 2, '9:00', '10:00', 'Asia/Shanghai', now());
    RAISE EXCEPTION 'ASSERT FAILED: 非 HH:mm 的时刻竟然插入成功';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ASSERT OK: fixed_constraints_time_format_check 生效';
  END;

  -- 4) 合法的 WEEKLY 约束应当插入成功
  INSERT INTO "fixed_constraints"
    (id, "userId", kind, title, weekday, "startTime", "endTime", "timeZone", "updatedAt")
  VALUES ('fc-ok', uid, 'WEEKLY', '高数课', 2, '08:30', '10:00', 'Asia/Shanghai', now());

  -- 5) 进度比例越界应被拒绝
  INSERT INTO "plan_items"
    (id, "userId", "planVersionId", title, "startsAt", "endsAt", minutes, "updatedAt")
  VALUES ('pi-1', uid, 'pv-1', '背单词', '2026-11-03T09:00:00+08:00', '2026-11-03T09:30:00+08:00', 30, now());

  BEGIN
    INSERT INTO "progress_events" (id, "userId", "planItemId", state, ratio)
    VALUES ('pe-bad', uid, 'pi-1', 'PARTIALLY_DONE', 1.5);
    RAISE EXCEPTION 'ASSERT FAILED: ratio > 1 竟然插入成功';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ASSERT OK: progress_events_ratio_check 生效';
  END;

  -- 清理
  DELETE FROM "progress_events" WHERE "userId" = uid;
  DELETE FROM "plan_items" WHERE "userId" = uid;
  DELETE FROM "fixed_constraints" WHERE "userId" = uid;
  DELETE FROM "plan_versions" WHERE "userId" = uid;
  DELETE FROM "users" WHERE id = uid;

  RAISE NOTICE 'ALL CONSTRAINT CHECKS PASSED';
END $$;
