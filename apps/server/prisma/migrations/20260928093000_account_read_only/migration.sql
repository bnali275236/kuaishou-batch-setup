-- 代投白名单：true = 仅可看数据，禁止上计划/调预算/调整计划等写操作
ALTER TABLE "OauthAccount" ADD COLUMN "readOnly" BOOLEAN NOT NULL DEFAULT false;
