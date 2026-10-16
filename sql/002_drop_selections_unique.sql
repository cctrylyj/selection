-- 去掉 (channel, channel_key) 唯一索引。
--
-- 背景：系统不做去重 —— 商品本身就是唯一的，重复采集/重复加入就应该是多条记录。
-- 旧版本 001_selections.sql 里建过这个唯一索引，它会让第二次插入直接报
-- 「duplicate key value violates unique constraint」，所以已建过库的请执行本文件。
--
-- 在 Supabase SQL Editor 执行本文件即可（可重复执行，幂等）。

drop index if exists public.selections_channel_channel_key_uidx;

-- 顺手补一个非唯一的查询索引，按渠道过滤时仍然走索引
create index if not exists selections_channel_idx
  on public.selections (channel);
