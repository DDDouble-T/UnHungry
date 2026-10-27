-- 已有数据库执行一次：补齐当前 MySQL schema 所需字段。
-- 保留历史审批单匿名状态，新审批单默认显示名称。
ALTER TABLE approvals
  ADD COLUMN authorName VARCHAR(32) NOT NULL DEFAULT '',
  ADD COLUMN isAnonymous BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE approvals ALTER COLUMN isAnonymous SET DEFAULT FALSE;

ALTER TABLE approvals
  ADD COLUMN authorAvatar VARCHAR(2048) NOT NULL DEFAULT '';

ALTER TABLE user_records
  ADD COLUMN foodRecorded BOOLEAN NOT NULL DEFAULT FALSE;
