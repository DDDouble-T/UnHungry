CREATE TABLE approvals (
  id VARCHAR(36) PRIMARY KEY,
  openid VARCHAR(128) NOT NULL,
  title VARCHAR(40) NOT NULL,
  price DECIMAL(12, 2) NULL,
  calorie DECIMAL(10, 2) NULL,
  reason VARCHAR(200) NOT NULL,
  alternative VARCHAR(100) NOT NULL DEFAULT '',
  intake VARCHAR(100) NOT NULL DEFAULT '',
  image VARCHAR(2048) NOT NULL DEFAULT '',
  status ENUM('pending', 'approved', 'rejected') NOT NULL,
  support INT NOT NULL DEFAULT 0,
  against INT NOT NULL DEFAULT 0,
  totalVotes INT NOT NULL DEFAULT 0,
  supportRate INT NOT NULL DEFAULT 0,
  tags JSON NOT NULL,
  emoji VARCHAR(16) NOT NULL,
  createdAt DATETIME(3) NOT NULL,
  updatedAt DATETIME(3) NOT NULL,
  INDEX idx_approvals_status_createdAt (status, createdAt)
);

CREATE TABLE approval_votes (
  id VARCHAR(300) PRIMARY KEY,
  approvalId VARCHAR(36) NOT NULL,
  openid VARCHAR(128) NOT NULL,
  choice ENUM('approve', 'wait') NOT NULL,
  reason VARCHAR(200) NOT NULL,
  createdAt DATETIME(3) NOT NULL,
  UNIQUE KEY uq_approval_vote (approvalId, openid),
  INDEX idx_votes_approval (approvalId)
);

CREATE TABLE user_records (
  id VARCHAR(36) PRIMARY KEY,
  openid VARCHAR(128) NOT NULL,
  approvalId VARCHAR(36) NULL,
  title VARCHAR(40) NOT NULL,
  calorie DECIMAL(10, 2) NULL,
  image VARCHAR(2048) NOT NULL DEFAULT '',
  status ENUM('pending', 'approved', 'rejected', 'logged') NOT NULL,
  checkinResult VARCHAR(16) NOT NULL DEFAULT '',
  createdAt DATETIME(3) NOT NULL,
  updatedAt DATETIME(3) NOT NULL,
  INDEX idx_records_openid_createdAt (openid, createdAt),
  INDEX idx_records_approval_openid (approvalId, openid)
);
