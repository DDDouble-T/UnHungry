-- 保留已有审批单的匿名状态，新审批单默认显示名称。
ALTER TABLE approvals
  ADD COLUMN authorName VARCHAR(32) NOT NULL DEFAULT '',
  ADD COLUMN isAnonymous BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE approvals ALTER COLUMN isAnonymous SET DEFAULT FALSE;
