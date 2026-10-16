-- 给选品表补上「销量 / 评价数」列。
--
-- 背景：产品信息页新增了销量列（山姆取星级右边那个数字，本质是评价数），
-- 加入选品时也要一起落库。旧版本 001_selections.sql 建的表里没有 sales 列，
-- 已经建过库的请执行本文件。
--
-- 在 Supabase SQL Editor 执行本文件即可（可重复执行，幂等）。

alter table public.selections add column if not exists sales integer;

-- 说明：允许为 null —— 页面上没有展示销量时就不写值，不要用 0 冒充，
-- 否则排序会把它们当成「真的没人买」排在最前/最后，误导判断。
