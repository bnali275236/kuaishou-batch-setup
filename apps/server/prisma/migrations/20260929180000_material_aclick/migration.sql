-- 素材日报新增「素材曝光数」字段。
--
-- 背景：平台素材报表同时返回三个极易混淆的曝光/点击字段，实测（2026-09-29）确认：
--   show        = 封面曝光数（小，如 738）
--   aclick      = 素材曝光数（大，如 161683，与 played_num 恒等）
--   photo_click = 封面点击数（小，如 43）
--   bclick      = 行为数（真正的点击数，如 1034）
-- 平台自算 action_ratio = bclick / aclick，impression_1k_cost = charge / show × 1000。
-- 因此「展示数」与点击率分母必须用 aclick，千展仍按 show 计算。
ALTER TABLE "MaterialDailyStat" ADD COLUMN "aclick" INTEGER NOT NULL DEFAULT 0;
