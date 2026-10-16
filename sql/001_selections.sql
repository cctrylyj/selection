-- 选品表：产品信息页勾选的数据统一存这里
-- 在 Supabase SQL Editor 执行本文件

create table if not exists public.selections (
  id           uuid primary key default gen_random_uuid(),
  channel      text        not null check (channel in ('samsclub', 'amazon', 'tiktokshop')),
  channel_key  text        not null,
  product_name text        not null,
  category     text        not null default '',
  price        numeric(12, 2),
  currency     text        not null default 'USD',
  -- 销量 / 评价数：页面上的整数（山姆是星级旁的评价数）。
  -- 取不到就是 null，不要写 0 —— 0 会被排序当成「真的没人买」。
  sales        integer,
  image_url    text        not null default '',
  product_url  text        not null default '',
  raw          jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

-- 已经建过表（旧版没有 sales 列）的话，单独执行这一句补上：
--   alter table public.selections add column if not exists sales integer;
-- 本文件整体是幂等的，重新执行也不会报错。

-- 不做去重：商品本身就是唯一的，同一条商品允许被多次加入（每次都是一条新记录）。
-- 所以这里刻意不建 (channel, channel_key) 唯一索引。
-- 如果你之前建过（旧版本 001 里有），执行 002_drop_selections_unique.sql 去掉。

create index if not exists selections_created_at_idx
  on public.selections (created_at desc);

create index if not exists selections_channel_idx
  on public.selections (channel);

-- 说明：
-- 1) 后端使用 service_role 密钥访问，RLS 不生效；
--    若将来要让前端直连，请改为 anon key + 打开 RLS 并配置
--    insert/select/delete 策略，且按 user_id 隔离数据。
-- 2) 删除本表属于危险操作，执行前先确认没有需要保留的数据。
