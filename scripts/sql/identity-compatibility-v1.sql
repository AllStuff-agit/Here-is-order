WITH constants AS (
  SELECT char(
    9, 10, 11, 12, 13, 32, 160, 5760,
    8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
    8232, 8233, 8239, 8287, 12288, 65279
  ) AS trim_chars
), classified AS (
  SELECT
    CASE
      WHEN typeof(password_hash) = 'text'
       AND length(password_hash) = 64
       AND password_hash NOT GLOB '*[^0-9a-f]*'
      THEN 1 ELSE 0
    END AS is_legacy_hash,
    CASE
      WHEN typeof(password_hash) = 'text'
       AND length(password_hash) = 118
       AND substr(password_hash, 1, 21) = 'pbkdf2_sha256$100000$'
       AND substr(password_hash, 22, 32) NOT GLOB '*[^0-9a-f]*'
       AND substr(password_hash, 54, 1) = '$'
       AND substr(password_hash, 55, 64) NOT GLOB '*[^0-9a-f]*'
      THEN 1 ELSE 0
    END AS is_current_hash,
    CASE
      WHEN typeof(id) <> 'integer' OR id <= 0
        OR typeof(username) <> 'text'
        OR username <> trim(username, trim_chars)
        OR length(username) < 1 OR length(username) > 128
        OR typeof(name) <> 'text'
        OR name <> trim(name, trim_chars)
        OR length(name) < 1 OR length(name) > 200
        OR typeof(role) <> 'text' OR role NOT IN ('admin', 'staff')
        OR typeof(is_active) <> 'integer' OR is_active NOT IN (0, 1)
        OR typeof(created_at) <> 'text' OR length(created_at) <> 19
        OR strftime('%Y-%m-%d %H:%M:%S', created_at) IS NULL
        OR strftime('%Y-%m-%d %H:%M:%S', created_at) <> created_at
      THEN 1 ELSE 0
    END AS is_invalid_projection
  FROM users
  CROSS JOIN constants
  WHERE is_deleted = 0
)
SELECT
  'identity-compatibility-v1' AS audit_version,
  COALESCE(SUM(is_legacy_hash), 0) AS legacy_password_hash_count,
  COALESCE(SUM(CASE WHEN is_legacy_hash = 0 AND is_current_hash = 0 THEN 1 ELSE 0 END), 0)
    AS unsupported_password_hash_count,
  COALESCE(SUM(is_invalid_projection), 0) AS invalid_identity_projection_count
FROM classified;
