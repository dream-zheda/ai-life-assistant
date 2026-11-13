-- ============================================================
-- 手写约束：Prisma schema 表达不了、但业务上必须由数据库兜底的部分。
-- 这些不是"锦上添花"——缺少它们时，并发与脏数据会静默污染计划语义。
-- ============================================================

-- 1) 同一用户、同一天，只能有一个「生效中」的计划版本。
--    并发生成两份计划时，第二条会被这个索引直接挡下（而不是靠应用层先查后写）。
CREATE UNIQUE INDEX "plan_versions_one_active_per_day"
  ON "plan_versions" ("userId", "localDate")
  WHERE "state" = 'ACTIVE';

-- 2) 固定约束的形态：WEEKLY 必须有 weekday（1-7）且不能有 localDate；ONE_OFF 反之。
--    否则会出现"既是每周又是指定日期"或"两者都没有"的无效约束，
--    而 fixedSlotIntervalOnDay 无法判断这种约束是否生效。
--
--    注意 SQL 三值逻辑：CHECK 约束在表达式求值为 NULL 时**是放行的**。
--    因此必须先写 `IS NOT NULL` 把结果压成 TRUE/FALSE，
--    否则 `weekday BETWEEN 1 AND 7` 遇到 NULL 会变成 NULL，坏数据直接穿过去。
ALTER TABLE "fixed_constraints"
  ADD CONSTRAINT "fixed_constraints_shape_check"
  CHECK (
    ("kind" = 'WEEKLY' AND "weekday" IS NOT NULL AND "weekday" BETWEEN 1 AND 7 AND "localDate" IS NULL)
    OR
    ("kind" = 'ONE_OFF' AND "weekday" IS NULL AND "localDate" IS NOT NULL)
  );

-- 3) 本地时刻必须是 HH:mm。存了 "9:00" 或 "09:00:00" 都会让解析失败。
ALTER TABLE "fixed_constraints"
  ADD CONSTRAINT "fixed_constraints_time_format_check"
  CHECK (
    "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  );

-- 4) 计划条目的时长必须为正，且结束晚于开始。
ALTER TABLE "plan_items"
  ADD CONSTRAINT "plan_items_positive_interval_check"
  CHECK ("minutes" > 0 AND "endsAt" > "startsAt");

-- 5) 进度比例必须在 [0,1]。
--    applyReport 在应用层已经夹紧，但历史数据/手工修库仍可能越界。
ALTER TABLE "progress_events"
  ADD CONSTRAINT "progress_events_ratio_check"
  CHECK ("ratio" >= 0 AND "ratio" <= 1);

-- 6) 任务队列的领取索引：worker 只关心「到点且可领取」的任务。
--    部分索引比全表索引小得多，扫描顺序也直接对应 ORDER BY "runAt"。
CREATE INDEX "jobs_claimable_idx"
  ON "jobs" ("runAt")
  WHERE "state" = 'PENDING';
