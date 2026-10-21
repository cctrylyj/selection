-- 修复：后端读不到选品表（permission denied for table selections）
--
-- 现象：线上 /api/selection 返回
--   DB_ERROR 查询失败：permission denied for table selections
--   hint: GRANT SELECT ON public.selections TO service_role;
-- 影响：选品页读不出数据；/api/selection/stats 因为把 error 吞掉返回 0，
--       看起来像「没有数据」，实际是查询失败。
--
-- 原因：后端用 SUPABASE_SERVICE_ROLE_KEY 访问，但该角色对 public.selections
-- 没有表级权限（表由别的角色创建，或默认权限被改过）。RLS 不是这里的瓶颈，
-- 这是 PostgreSQL 的 GRANT 层面的拒绝。
--
-- 在 Supabase → SQL Editor 里执行本文件即可，幂等，可重复执行。

grant usage on schema public to service_role;

grant select, insert, update, delete
  on table public.selections
  to service_role;

-- 如果表上有 sequence 自增列（当前用 uuid 默认值，不需要），顺手授权也不会有副作用
-- grant usage, select on all sequences in schema public to service_role;

-- 验证：执行后访问 https://<你的域名>/api/health，database 应变成 "ok"；
--       /api/selection 不再报 permission denied。
