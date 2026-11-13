-- Ачивки пары
CREATE TABLE IF NOT EXISTS achievements (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  date        TEXT,                         -- YYYY-MM-DD, NULL для закрытых целей
  rarity      TEXT NOT NULL DEFAULT 'common', -- common | rare | epic | legendary
  status      TEXT NOT NULL DEFAULT 'unlocked', -- unlocked | locked
  icon        TEXT NOT NULL DEFAULT '❤️',   -- эмодзи, если нет фото
  photo_id    TEXT,
  created_by  INTEGER,
  created_by_name TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Фото хранятся прямо в D1 (уже сжатые на клиенте, ~100–300 КБ)
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- Общие настройки пары: название, дата начала отношений
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
